import monitor from "./auto-monitor.js";

const BUILD_VERSION = "2026-08-27-kucoin-vercel-one-tap-v1";
const SYMBOL = "BTC-USDT";
const FIVE_MINUTES = 5 * 60 * 1000;
const STATE_URL = "https://state.local/kucoin-vercel-one-tap-state";
const PENDING_URL = "https://state.local/kucoin-vercel-one-tap-pending";
const DEFAULT_PROXY_URL = "https://vercel-kucoin-check-lutfula.vercel.app/api/kucoin-proxy";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/kucoin-health") {
      let balances = null;
      let error = null;
      try {
        balances = await getBalances(env);
      } catch (e) {
        error = clean(e?.message || e);
      }
      return json({
        ok: true,
        version: BUILD_VERSION,
        mode: "one-tap-live-confirmation",
        symbol: SYMBOL,
        isolatedMargin: true,
        autoBorrow: false,
        buySizing: "100% available USDT",
        sellSizing: "100% available BTC",
        proxy: getProxyUrl(env),
        balances,
        error,
        state: await getState(),
      });
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      const clone = request.clone();
      const update = await clone.json().catch(() => null);

      if (update?.callback_query) {
        const data = String(update.callback_query?.data || "");
        if (/^kv1:[bsx]:/i.test(data)) {
          return handleCallback(request, update.callback_query, env);
        }
      }

      const chatId = update?.message?.chat?.id != null ? String(update.message.chat.id) : null;
      const text = String(update?.message?.text || "").trim();
      const command = text.split(/\s+/)[0]?.toLowerCase().split("@")[0] || "";

      if (chatId && (command === "/kucointrade" || command === "/kucoincycle")) {
        if (!isAuthorizedTelegram(request, env, chatId)) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }
        await sendProposal(env, chatId, true);
        return json({ ok: true });
      }
    }

    return monitor.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    try {
      if (typeof monitor.scheduled === "function") monitor.scheduled(event, env, ctx);
    } catch (e) {
      console.error("monitor scheduled error", clean(e?.message || e));
    }

    ctx.waitUntil(runCycle(event, env).catch(async (e) => {
      const message = clean(e?.message || e);
      console.error("KuCoin Vercel cycle error", message);
      if (!/429|rate limit|too many requests/i.test(message)) {
        await notify(env, "⚠️ <b>KUCOIN CYCLE ERROR</b>\n" + escapeHtml(message)).catch(() => {});
      }
    }));
  },
};

async function runCycle(event, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  if (!hasKucoinSecrets(env)) return;

  const pending = await getPending();
  if (pending && Number(pending.expiresAt || 0) > Date.now()) return;
  if (pending) await clearPending();

  const state = await getState();
  const now = Number(event?.scheduledTime || Date.now());
  if (state?.nextAt && now < Number(state.nextAt)) return;

  await sendProposal(env, String(env.TELEGRAM_CHAT_ID), false);
}

async function sendProposal(env, chatId, force) {
  if (!hasKucoinSecrets(env)) {
    await notifyTo(env, chatId, "❌ <b>KuCoin belum siap</b>\nSecret KuCoin di Cloudflare belum lengkap.");
    return;
  }

  const existing = await getPending();
  if (!force && existing && Number(existing.expiresAt || 0) > Date.now()) return;
  if (existing) await clearPending();

  const state = await getState();
  if (!force && state?.nextAt && Date.now() < Number(state.nextAt)) return;

  const [balances, reference] = await Promise.all([getBalances(env), getReferencePrice()]);
  const btcValue = balances.btcAvailable * reference.price;

  let side;
  if (state?.lastAction === "BUY") side = "sell";
  else if (state?.lastAction === "SELL") side = "buy";
  else side = btcValue > balances.usdtAvailable && balances.btcAvailable > 0 ? "sell" : "buy";

  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 18);
  const expiresAt = Date.now() + 6 * 60 * 1000;

  if (side === "buy") {
    const funds = roundDown(balances.usdtAvailable, 6);
    if (!Number.isFinite(funds) || funds <= 0) {
      await notifyTo(env, chatId, "❌ <b>Saldo USDT Isolated Margin tidak tersedia</b>\nTidak ada order BUY yang disiapkan.");
      return;
    }

    await setPending({ token, side: "buy", funds: String(funds), createdAt: Date.now(), expiresAt });
    await sendTelegramWithButtons(env, chatId, [
      "🟢 <b>KUCOIN ISOLATED MARGIN — ONE TAP BUY</b>",
      `Pair: <b>${SYMBOL}</b>`,
      `Referensi harga: <b>${format(reference.price, 2)}</b> USDT (${escapeHtml(reference.source)})`,
      `Saldo tersedia: <b>${format(balances.usdtAvailable, 6)} USDT</b>`,
      `Dana order: <b>${format(funds, 6)} USDT</b> (semua saldo available)`,
      "Order: <b>MARKET BUY</b>",
      "Auto-borrow: <b>OFF</b>",
      "",
      "⚠️ Tombol ini langsung mengirim order live saat ditekan.",
      "API tidak membedakan dana trial dan dana pribadi di akun Isolated Margin.",
    ].join("\n"), [
      [{ text: `✅ BUY SEMUA ${format(funds, 6)} USDT`, callback_data: `kv1:b:${token}` }],
      [{ text: "❌ Batal", callback_data: `kv1:x:${token}` }],
    ]);
    return;
  }

  const size = roundDown(balances.btcAvailable, 8);
  if (!Number.isFinite(size) || size <= 0) {
    await notifyTo(env, chatId, "⏳ <b>BTC hasil BUY belum tersedia</b>\nBot belum menyiapkan SELL. Coba lagi beberapa saat.");
    return;
  }

  await setPending({ token, side: "sell", size: String(size), createdAt: Date.now(), expiresAt });
  await sendTelegramWithButtons(env, chatId, [
    "🔴 <b>KUCOIN ISOLATED MARGIN — ONE TAP SELL</b>",
    `Pair: <b>${SYMBOL}</b>`,
    `Referensi harga: <b>${format(reference.price, 2)}</b> USDT (${escapeHtml(reference.source)})`,
    `BTC tersedia: <b>${format(balances.btcAvailable, 8)} BTC</b>`,
    `Jumlah order: <b>${format(size, 8)} BTC</b> (semua BTC available)`,
    "Order: <b>MARKET SELL</b>",
    "Auto-borrow: <b>OFF</b>",
    "",
    "⚠️ Tombol ini langsung mengirim order live saat ditekan.",
  ].join("\n"), [
    [{ text: `✅ SELL SEMUA ${format(size, 8)} BTC`, callback_data: `kv1:s:${token}` }],
    [{ text: "❌ Batal", callback_data: `kv1:x:${token}` }],
  ]);
}

async function handleCallback(request, callback, env) {
  const chatId = callback?.message?.chat?.id != null ? String(callback.message.chat.id) : null;
  const callbackId = String(callback?.id || "");
  const data = String(callback?.data || "");

  if (!chatId || !isAuthorizedTelegram(request, env, chatId)) {
    if (callbackId) await answerCallback(env, callbackId, "Tidak diizinkan").catch(() => {});
    return json({ ok: true });
  }

  const match = /^kv1:([bsx]):([a-f0-9]{10,24})$/i.exec(data);
  if (!match) return json({ ok: true });

  const action = match[1].toLowerCase();
  const token = match[2];
  const pending = await getPending();

  if (!pending || pending.token !== token || Number(pending.expiresAt || 0) < Date.now()) {
    await clearPending();
    await answerCallback(env, callbackId, "Tombol kedaluwarsa").catch(() => {});
    await notifyTo(env, chatId, "⌛ Tombol sudah kedaluwarsa. Kirim /kucointrade untuk membuat tombol baru.");
    return json({ ok: true });
  }

  if (action === "x") {
    await clearPending();
    await answerCallback(env, callbackId, "Dibatalkan").catch(() => {});
    await notifyTo(env, chatId, "❌ Dibatalkan. Tidak ada order yang dikirim.");
    return json({ ok: true });
  }

  const expected = pending.side === "buy" ? "b" : "s";
  if (action !== expected) {
    await answerCallback(env, callbackId, "Tombol tidak cocok").catch(() => {});
    return json({ ok: true });
  }

  await clearPending();
  await answerCallback(env, callbackId, "Mengirim order live ke KuCoin...").catch(() => {});

  try {
    const balances = await getBalances(env);
    const clientOid = `tgvercel${token}`.slice(0, 40);

    if (pending.side === "buy") {
      const approved = Number(pending.funds);
      const funds = roundDown(Math.min(balances.usdtAvailable, approved), 6);
      if (!(funds > 0)) throw new Error("Saldo USDT tidak cukup saat tombol ditekan");

      const result = await placeMarginOrder(env, {
        clientOid,
        symbol: SYMBOL,
        side: "buy",
        type: "market",
        funds: String(funds),
        isIsolated: true,
        autoBorrow: false,
        autoRepay: false,
      });

      await setState({ lastAction: "BUY", orderId: result?.orderId || null, confirmedAt: Date.now(), nextAt: Date.now() + FIVE_MINUTES });
      await notifyTo(env, chatId, [
        "✅ <b>KUCOIN BUY TERKIRIM</b>",
        `Dana: <b>${format(funds, 6)} USDT</b>`,
        `Order ID: <code>${escapeHtml(result?.orderId || "-")}</code>`,
        "Backend KuCoin: <b>Vercel Singapore</b>",
        "",
        "Sekitar 5 menit lagi bot akan menyiapkan tombol SELL seluruh BTC available.",
      ].join("\n"));
    } else {
      const approved = Number(pending.size);
      const size = roundDown(Math.min(balances.btcAvailable, approved), 8);
      if (!(size > 0)) throw new Error("Saldo BTC tidak cukup saat tombol ditekan");

      const result = await placeMarginOrder(env, {
        clientOid,
        symbol: SYMBOL,
        side: "sell",
        type: "market",
        size: String(size),
        isIsolated: true,
        autoBorrow: false,
        autoRepay: false,
      });

      await setState({ lastAction: "SELL", orderId: result?.orderId || null, confirmedAt: Date.now(), nextAt: Date.now() + FIVE_MINUTES });
      await notifyTo(env, chatId, [
        "✅ <b>KUCOIN SELL TERKIRIM</b>",
        `Jumlah: <b>${format(size, 8)} BTC</b>`,
        `Order ID: <code>${escapeHtml(result?.orderId || "-")}</code>`,
        "Backend KuCoin: <b>Vercel Singapore</b>",
        "",
        "Sekitar 5 menit lagi bot akan menyiapkan tombol BUY menggunakan seluruh USDT available.",
      ].join("\n"));
    }
  } catch (e) {
    await notifyTo(env, chatId, "❌ <b>ORDER KUCOIN GAGAL</b>\n" + escapeHtml(clean(e?.message || e)));
  }

  return json({ ok: true });
}

async function getBalances(env) {
  const endpoint = `/api/v3/isolated/accounts?symbol=${SYMBOL}&quoteCurrency=USDT&queryType=ISOLATED`;
  const data = await kucoinProxy(env, "GET", endpoint, null);
  const assets = Array.isArray(data?.assets) ? data.assets : [];
  const pair = assets.find((x) => String(x?.symbol || "").toUpperCase() === SYMBOL);
  const usdtAvailable = Number(pair?.quoteAsset?.available || 0);
  const btcAvailable = Number(pair?.baseAsset?.available || 0);
  if (!Number.isFinite(usdtAvailable) || !Number.isFinite(btcAvailable)) throw new Error("Format saldo Isolated Margin KuCoin tidak valid");
  return { usdtAvailable, btcAvailable };
}

async function placeMarginOrder(env, body) {
  return kucoinProxy(env, "POST", "/api/v3/hf/margin/order", body);
}

async function kucoinProxy(env, method, endpoint, body) {
  const proxyUrl = getProxyUrl(env);
  const ts = String(Date.now());
  const canonicalBody = body == null ? "" : JSON.stringify(body);
  const signed = `${ts}\n${method.toUpperCase()}\n${endpoint}\n${canonicalBody}`;
  const signature = await hmacHex(env.KUCOIN_API_SECRET, signed);

  const response = await fetch(proxyUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-kc-proxy-ts": ts,
      "x-kc-proxy-sign": signature,
    },
    body: JSON.stringify({ method: method.toUpperCase(), endpoint, body }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || `Vercel proxy HTTP ${response.status}`);
  return payload.data;
}

function getProxyUrl(env) {
  return String(env.KUCOIN_PROXY_URL || DEFAULT_PROXY_URL).trim();
}

async function getReferencePrice() {
  const sources = [
    ["MEXC", "https://api.mexc.com/api/v3/ticker/price?symbol=BTCUSDT"],
    ["Binance", "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"],
  ];
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

function hasKucoinSecrets(env) {
  return Boolean(env.KUCOIN_API_KEY && env.KUCOIN_API_SECRET && env.KUCOIN_API_PASSPHRASE);
}

async function sendTelegramWithButtons(env, chatId, text, inlineKeyboard) {
  return telegramApi(env, "sendMessage", { chat_id: String(chatId), text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: inlineKeyboard } });
}

async function notify(env, text) {
  if (!env.TELEGRAM_CHAT_ID) return;
  return notifyTo(env, String(env.TELEGRAM_CHAT_ID), text);
}

async function notifyTo(env, chatId, text) {
  return telegramApi(env, "sendMessage", { chat_id: String(chatId), text, parse_mode: "HTML", disable_web_page_preview: true });
}

async function answerCallback(env, callbackId, text) {
  return telegramApi(env, "answerCallbackQuery", { callback_query_id: callbackId, text: String(text).slice(0, 180), show_alert: false });
}

async function telegramApi(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN belum ada");
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.ok === false) throw new Error(j?.description || `Telegram HTTP ${r.status}`);
  return j.result;
}

async function getState() {
  const r = await caches.default.match(new Request(STATE_URL));
  return r ? r.json().catch(() => null) : null;
}
async function setState(v) {
  await caches.default.put(new Request(STATE_URL), new Response(JSON.stringify(v), { headers: { "content-type": "application/json", "cache-control": "max-age=86400" } }));
}
async function getPending() {
  const r = await caches.default.match(new Request(PENDING_URL));
  return r ? r.json().catch(() => null) : null;
}
async function setPending(v) {
  await caches.default.put(new Request(PENDING_URL), new Response(JSON.stringify(v), { headers: { "content-type": "application/json", "cache-control": "max-age=420" } }));
}
async function clearPending() { await caches.default.delete(new Request(PENDING_URL)); }

async function hmacHex(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function roundDown(value, decimals) {
  const factor = 10 ** decimals;
  return Math.floor(Number(value) * factor + 1e-12) / factor;
}
function format(value, decimals) { return Number(value).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: decimals }); }
function clean(value) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").slice(0, 700).trim(); }
function escapeHtml(value) { return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
