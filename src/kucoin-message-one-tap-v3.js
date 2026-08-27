import legacy from "./kucoin-vercel-one-tap-v2.js";

const BUILD_VERSION = "2026-08-27-kucoin-message-one-tap-v3-2min";
const SYMBOL = "BTC-USDT";
const TWO_MINUTES = 2 * 60 * 1000;
const PENDING_URL = "https://state.local/kucoin-message-one-tap-v3-pending";
const STATE_URL = "https://state.local/kucoin-message-one-tap-v3-state";
const DEFAULT_PROXY_URL = "https://vercel-kucoin-check-lutfula.vercel.app/api/kucoin-proxy-v2";
const CONFIRM_BUY = "✅ KONFIRMASI BUY SEMUA";
const CONFIRM_SELL = "✅ KONFIRMASI SELL SEMUA";
const CANCEL = "❌ BATAL";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/kucoin-message-health") {
      let balances = null;
      let error = null;
      try { balances = await getBalances(env); } catch (e) { error = formatError(e); }
      return json({ ok: true, version: BUILD_VERSION, mode: "telegram-reply-keyboard-one-tap", balances, error });
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      const clone = request.clone();
      const update = await clone.json().catch(() => null);
      const chatId = update?.message?.chat?.id != null ? String(update.message.chat.id) : null;
      const text = String(update?.message?.text || "").trim();
      const command = text.split(/\s+/)[0]?.toLowerCase().split("@")[0] || "";

      if (chatId && (command === "/kucointrade" || command === "/kucoincycle")) {
        if (!isAuthorizedTelegram(request, env, chatId)) return json({ ok: false, error: "Unauthorized" }, 401);
        try {
          await createProposal(env, chatId, true);
        } catch (e) {
          await sendText(env, chatId, `❌ <b>KUCOIN/Vercel gagal</b>\n${escapeHtml(formatError(e))}`);
        }
        return json({ ok: true });
      }

      if (chatId && [CONFIRM_BUY, CONFIRM_SELL, CANCEL].includes(text)) {
        if (!isAuthorizedTelegram(request, env, chatId)) return json({ ok: false, error: "Unauthorized" }, 401);
        if (text === CANCEL) {
          await clearPending();
          await sendText(env, chatId, "❌ Dibatalkan. Tidak ada order yang dikirim.", true);
          return json({ ok: true });
        }
        await executePending(env, chatId, text === CONFIRM_BUY ? "buy" : "sell");
        return json({ ok: true });
      }
    }

    return legacy.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    try {
      ctx.waitUntil(runScheduled(event, env).catch(async (e) => {
        console.error("KuCoin message one-tap cycle error", formatError(e));
      }));
    } catch (e) {
      console.error("scheduled error", formatError(e));
    }
  },
};

async function runScheduled(event, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  if (!getProxySecret(env)) return;

  const pending = await getPending();
  if (pending && Number(pending.expiresAt || 0) > Date.now()) return;
  if (pending) await clearPending();

  const state = await getState();
  const now = Number(event?.scheduledTime || Date.now());
  if (state?.nextAt && now < Number(state.nextAt)) return;

  await createProposal(env, String(env.TELEGRAM_CHAT_ID), false);
}

async function createProposal(env, chatId, force) {
  if (!getProxySecret(env)) throw new Error("KUCOIN_API_SECRET/KUCOIN_PROXY_SECRET belum ada di Cloudflare");

  const existing = await getPending();
  if (!force && existing && Number(existing.expiresAt || 0) > Date.now()) return;
  if (existing) await clearPending();

  const balances = await getBalances(env);
  const reference = await getReferencePrice();
  const btcValue = balances.btcAvailable * reference.price;
  const side = balances.btcAvailable > 0 && btcValue >= balances.usdtAvailable ? "sell" : "buy";
  const expiresAt = Date.now() + 6 * 60 * 1000;

  if (side === "buy") {
    const funds = roundDown(balances.usdtAvailable, 6);
    if (!(funds > 0)) {
      await sendText(env, chatId, "❌ <b>Saldo USDT Isolated Margin tidak tersedia</b>");
      return;
    }
    await setPending({ side: "buy", funds: String(funds), createdAt: Date.now(), expiresAt });
    await sendReplyKeyboard(env, chatId, [
      "🟢 <b>KUCOIN ISOLATED MARGIN — ONE TAP BUY</b>",
      `Pair: <b>${SYMBOL}</b>`,
      `Referensi harga: <b>${format(reference.price, 2)}</b> USDT (${escapeHtml(reference.source)})`,
      `Saldo USDT tersedia: <b>${format(balances.usdtAvailable, 6)} USDT</b>`,
      `Dana order: <b>${format(funds, 6)} USDT</b>`,
      "Order: <b>MARKET BUY</b>",
      "Auto-borrow: <b>OFF</b>",
      "Backend: <b>Vercel Singapore</b>",
      "",
      "Tekan tombol keyboard di bawah sekali untuk mengirim order live.",
    ].join("\n"), CONFIRM_BUY);
    return;
  }

  const size = roundDown(balances.btcAvailable, 8);
  if (!(size > 0)) {
    await sendText(env, chatId, "❌ <b>Saldo BTC Isolated Margin tidak tersedia</b>");
    return;
  }
  await setPending({ side: "sell", size: String(size), createdAt: Date.now(), expiresAt });
  await sendReplyKeyboard(env, chatId, [
    "🔴 <b>KUCOIN ISOLATED MARGIN — ONE TAP SELL</b>",
    `Pair: <b>${SYMBOL}</b>`,
    `Referensi harga: <b>${format(reference.price, 2)}</b> USDT (${escapeHtml(reference.source)})`,
    `BTC tersedia: <b>${format(balances.btcAvailable, 8)} BTC</b>`,
    `Jumlah order: <b>${format(size, 8)} BTC</b>`,
    "Order: <b>MARKET SELL</b>",
    "Auto-borrow: <b>OFF</b>",
    "Backend: <b>Vercel Singapore</b>",
    "",
    "Tekan tombol keyboard di bawah sekali untuk mengirim order live.",
  ].join("\n"), CONFIRM_SELL);
}

async function executePending(env, chatId, requestedSide) {
  const pending = await getPending();
  if (!pending || Number(pending.expiresAt || 0) < Date.now()) {
    await clearPending();
    await sendText(env, chatId, "⌛ Konfirmasi sudah kedaluwarsa. Kirim /kucointrade lagi.", true);
    return;
  }
  if (pending.side !== requestedSide) {
    await sendText(env, chatId, "❌ Tombol konfirmasi tidak cocok dengan proposal terbaru.", true);
    return;
  }

  await clearPending();
  await sendText(env, chatId, "⏳ Mengirim order live ke KuCoin melalui Vercel Singapore...", true);

  try {
    const balances = await getBalances(env);
    const clientOid = `tgreply${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    let result;

    if (requestedSide === "buy") {
      const approved = Number(pending.funds);
      const funds = roundDown(Math.min(approved, balances.usdtAvailable), 6);
      if (!(funds > 0)) throw new Error("Saldo USDT tidak cukup saat konfirmasi");
      result = await placeMarginOrder(env, {
        clientOid, symbol: SYMBOL, side: "buy", type: "market", funds: String(funds),
        isIsolated: true, autoBorrow: false, autoRepay: false,
      });
      await setState({ lastAction: "BUY", orderId: result?.orderId || null, nextAt: Date.now() + TWO_MINUTES });
      await sendText(env, chatId, [
        "✅ <b>KUCOIN BUY TERKIRIM</b>",
        `Dana: <b>${format(funds, 6)} USDT</b>`,
        `Order ID: <code>${escapeHtml(result?.orderId || "-")}</code>`,
        "Sekitar 2 menit lagi bot menyiapkan SELL.",
      ].join("\n"), true);
    } else {
      const approved = Number(pending.size);
      const size = roundDown(Math.min(approved, balances.btcAvailable), 8);
      if (!(size > 0)) throw new Error("Saldo BTC tidak cukup saat konfirmasi");
      result = await placeMarginOrder(env, {
        clientOid, symbol: SYMBOL, side: "sell", type: "market", size: String(size),
        isIsolated: true, autoBorrow: false, autoRepay: false,
      });
      await setState({ lastAction: "SELL", orderId: result?.orderId || null, nextAt: Date.now() + TWO_MINUTES });
      await sendText(env, chatId, [
        "✅ <b>KUCOIN SELL TERKIRIM</b>",
        `Jumlah: <b>${format(size, 8)} BTC</b>`,
        `Order ID: <code>${escapeHtml(result?.orderId || "-")}</code>`,
        "Sekitar 2 menit lagi bot menyiapkan BUY.",
      ].join("\n"), true);
    }
  } catch (e) {
    await sendText(env, chatId, `❌ <b>ORDER KUCOIN GAGAL</b>\n${escapeHtml(formatError(e))}`, true);
  }
}

async function getBalances(env) {
  const endpoint = `/api/v3/isolated/accounts?symbol=${SYMBOL}&quoteCurrency=USDT&queryType=ISOLATED`;
  const data = await kucoinProxy(env, "GET", endpoint, null);
  const assets = Array.isArray(data?.assets) ? data.assets : [];
  const pair = assets.find((item) => String(item?.symbol || "").toUpperCase() === SYMBOL);
  const usdtAvailable = Number(pair?.quoteAsset?.available ?? 0);
  const btcAvailable = Number(pair?.baseAsset?.available ?? 0);
  if (!Number.isFinite(usdtAvailable) || !Number.isFinite(btcAvailable)) throw new Error("Format saldo KuCoin tidak valid");
  return { usdtAvailable, btcAvailable };
}

async function placeMarginOrder(env, body) {
  return kucoinProxy(env, "POST", "/api/v3/hf/margin/order", body);
}

async function kucoinProxy(env, method, endpoint, body) {
  const secret = getProxySecret(env);
  if (!secret) throw new Error("Proxy secret belum dikonfigurasi di Cloudflare");
  const ts = String(Date.now());
  const canonicalBody = body == null ? "" : JSON.stringify(body);
  const signed = `${ts}\n${method.toUpperCase()}\n${endpoint}\n${canonicalBody}`;
  const signature = await hmacHex(secret, signed);
  const response = await fetch(getProxyUrl(env), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "x-kc-proxy-ts": ts, "x-kc-proxy-sign": signature },
    body: JSON.stringify({ method: method.toUpperCase(), endpoint, body }),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok || payload?.ok !== true) {
    const detail = typeof payload?.error === "string" ? payload.error : text || `HTTP ${response.status}`;
    throw new Error(`Vercel proxy HTTP ${response.status}: ${String(detail).slice(0, 700)}`);
  }
  return payload.data;
}

function getProxyUrl(env) { return String(env.KUCOIN_PROXY_URL || DEFAULT_PROXY_URL).trim(); }
function getProxySecret(env) { return String(env.KUCOIN_PROXY_SECRET || env.KUCOIN_API_SECRET || "").trim(); }

async function getReferencePrice() {
  const sources = [["MEXC", "https://api.mexc.com/api/v3/ticker/price?symbol=BTCUSDT"], ["Binance", "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"]];
  for (const [source, url] of sources) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      const j = await r.json().catch(() => ({}));
      const price = Number(j?.price);
      if (r.ok && price > 0) return { price, source };
    } catch {}
  }
  return { price: 0, source: "tidak tersedia" };
}

function isAuthorizedTelegram(request, env, chatId) {
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const secret = request.headers.get("x-telegram-bot-api-secret-token");
    if (secret !== env.TELEGRAM_WEBHOOK_SECRET) return false;
  }
  if (env.TELEGRAM_CHAT_ID && String(chatId) !== String(env.TELEGRAM_CHAT_ID)) return false;
  return true;
}

async function sendReplyKeyboard(env, chatId, text, confirmText) {
  return telegramApi(env, "sendMessage", {
    chat_id: String(chatId), text, parse_mode: "HTML", disable_web_page_preview: true,
    reply_markup: { keyboard: [[{ text: confirmText }], [{ text: CANCEL }]], resize_keyboard: true, one_time_keyboard: true },
  });
}

async function sendText(env, chatId, text, removeKeyboard = false) {
  const payload = { chat_id: String(chatId), text, parse_mode: "HTML", disable_web_page_preview: true };
  if (removeKeyboard) payload.reply_markup = { remove_keyboard: true };
  return telegramApi(env, "sendMessage", payload);
}

async function telegramApi(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN belum ada di Cloudflare");
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  const text = await r.text();
  let j = null;
  try { j = text ? JSON.parse(text) : {}; } catch {}
  if (!r.ok || j?.ok === false) throw new Error(j?.description || `Telegram HTTP ${r.status}: ${text.slice(0, 300)}`);
  return j.result;
}

async function getPending() {
  const r = await caches.default.match(new Request(PENDING_URL));
  return r ? r.json().catch(() => null) : null;
}
async function setPending(v) {
  await caches.default.put(new Request(PENDING_URL), new Response(JSON.stringify(v), { headers: { "content-type": "application/json", "cache-control": "max-age=420" } }));
}
async function clearPending() { await caches.default.delete(new Request(PENDING_URL)); }
async function getState() {
  const r = await caches.default.match(new Request(STATE_URL));
  return r ? r.json().catch(() => null) : null;
}
async function setState(v) {
  await caches.default.put(new Request(STATE_URL), new Response(JSON.stringify(v), { headers: { "content-type": "application/json", "cache-control": "max-age=86400" } }));
}

async function hmacHex(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function roundDown(value, decimals) { const f = 10 ** decimals; return Math.floor(Number(value) * f + 1e-12) / f; }
function format(value, decimals) { return Number(value).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: decimals }); }
function formatError(value) { if (value instanceof Error) return value.message || String(value); if (typeof value === "string") return value; try { return JSON.stringify(value); } catch { return String(value); } }
function escapeHtml(value) { return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
