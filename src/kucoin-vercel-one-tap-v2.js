import monitor from "./auto-monitor.js";

const BUILD_VERSION = "2026-08-27-kucoin-vercel-one-tap-v2";
const SYMBOL = "BTC-USDT";
const FIVE_MINUTES = 5 * 60 * 1000;
const STATE_URL = "https://state.local/kucoin-vercel-one-tap-v2-state";
const PENDING_URL = "https://state.local/kucoin-vercel-one-tap-v2-pending";
const ERROR_URL = "https://state.local/kucoin-vercel-one-tap-v2-error";
const DEFAULT_PROXY_URL = "https://vercel-kucoin-check-lutfula.vercel.app/api/kucoin-proxy-v2";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/kucoin-health") {
      const result = {
        ok: true,
        version: BUILD_VERSION,
        mode: "one-tap-live-confirmation",
        symbol: SYMBOL,
        isolatedMargin: true,
        autoBorrow: false,
        proxy: getProxyUrl(env),
        proxySecretConfigured: Boolean(getProxySecret(env)),
        telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
        balances: null,
        proxyHealth: null,
        error: null,
        state: await getState(),
      };
      try {
        result.proxyHealth = await proxyHealth(env);
        result.balances = await getBalances(env);
      } catch (error) {
        result.error = formatError(error);
      }
      return json(result);
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      const clone = request.clone();
      const update = await clone.json().catch(() => null);

      if (update?.callback_query) {
        const data = String(update.callback_query?.data || "");
        if (/^kv2:[bsx]:/i.test(data)) {
          return handleCallback(request, update.callback_query, env);
        }
      }

      const chatId = update?.message?.chat?.id != null ? String(update.message.chat.id) : null;
      const text = String(update?.message?.text || "").trim();
      const command = text.split(/\s+/)[0]?.toLowerCase().split("@")[0] || "";

      if (chatId && (command === "/kucointrade" || command === "/kucoincycle" || command === "/kucoinproxy")) {
        if (!isAuthorizedTelegram(request, env, chatId)) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }

        try {
          if (command === "/kucoinproxy") {
            await sendProxyStatus(env, chatId);
          } else {
            await sendProposal(env, chatId, true);
          }
        } catch (error) {
          const message = formatError(error);
          await notifyTo(env, chatId, [
            "❌ <b>KUCOIN/Vercel gagal</b>",
            escapeHtml(message),
            "",
            `Proxy: <code>${escapeHtml(getProxyUrl(env))}</code>`,
            "Gunakan /kucoinproxy untuk tes koneksi tanpa membuat order.",
          ].join("\n")).catch(() => {});
        }
        return json({ ok: true });
      }
    }

    return monitor.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    try {
      if (typeof monitor.scheduled === "function") monitor.scheduled(event, env, ctx);
    } catch (error) {
      console.error("monitor scheduled error", formatError(error));
    }

    ctx.waitUntil(runCycle(event, env).catch(async (error) => {
      const message = formatError(error);
      console.error("KuCoin Vercel v2 cycle error", message);
      if (!/429|rate limit|too many requests/i.test(message)) {
        await notifyCycleErrorOnce(env, message).catch(() => {});
      }
    }));
  },
};

async function runCycle(event, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  if (!getProxySecret(env)) return;

  const pending = await getPending();
  if (pending && Number(pending.expiresAt || 0) > Date.now()) return;
  if (pending) await clearPending();

  const state = await getState();
  const now = Number(event?.scheduledTime || Date.now());
  if (state?.nextAt && now < Number(state.nextAt)) return;

  await sendProposal(env, String(env.TELEGRAM_CHAT_ID), false);
}

async function sendProxyStatus(env, chatId) {
  const health = await proxyHealth(env);
  const balances = await getBalances(env);
  await notifyTo(env, chatId, [
    "✅ <b>KUCOIN PROXY TERHUBUNG</b>",
    `Vercel region: <b>${escapeHtml(health?.region || "-")}</b>`,
    `Proxy version: <code>${escapeHtml(health?.version || "-")}</code>`,
    `USDT available: <b>${format(balances.usdtAvailable, 6)}</b>`,
    `BTC available: <b>${format(balances.btcAvailable, 8)}</b>`,
    "",
    "Tes ini tidak membuat order.",
  ].join("\n"));
}

async function sendProposal(env, chatId, force) {
  if (!getProxySecret(env)) {
    await notifyTo(env, chatId, "❌ <b>Proxy belum siap</b>\nKUCOIN_PROXY_SECRET atau KUCOIN_API_SECRET belum ada di Cloudflare.");
    return;
  }

  const existing = await getPending();
  if (!force && existing && Number(existing.expiresAt || 0) > Date.now()) return;
  if (existing) await clearPending();

  const state = await getState();
  if (!force && state?.nextAt && Date.now() < Number(state.nextAt)) return;

  await proxyHealth(env);
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
    if (!(funds > 0)) {
      await notifyTo(env, chatId, "❌ <b>Saldo USDT Isolated Margin tidak tersedia</b>\nTidak ada order BUY yang disiapkan.");
      return;
    }

    await setPending({ token, side: "buy", funds: String(funds), createdAt: Date.now(), expiresAt });
    await sendTelegramWithButtons(env, chatId, [
      "🟢 <b>KUCOIN ISOLATED MARGIN — ONE TAP BUY</b>",
      `Pair: <b>${SYMBOL}</b>`,
      `Referensi harga: <b>${format(reference.price, 2)}</b> USDT (${escapeHtml(reference.source)})`,
      `Saldo USDT tersedia: <b>${format(balances.usdtAvailable, 6)} USDT</b>`,
      `Dana order: <b>${format(funds, 6)} USDT</b>`,
      "Order: <b>MARKET BUY</b>",
      "Auto-borrow: <b>OFF</b>",
      "Backend: <b>Vercel Singapore</b>",
      "",
      "⚠️ Satu klik pada tombol BUY langsung mengirim order live.",
      "Nominal adalah seluruh saldo USDT available pada akun BTC-USDT Isolated Margin.",
    ].join("\n"), [
      [{ text: `✅ BUY SEMUA ${format(funds, 6)} USDT`, callback_data: `kv2:b:${token}` }],
      [{ text: "❌ Batal", callback_data: `kv2:x:${token}` }],
    ]);
    return;
  }

  const size = roundDown(balances.btcAvailable, 8);
  if (!(size > 0)) {
    await notifyTo(env, chatId, "⏳ <b>BTC hasil BUY belum tersedia</b>\nBot belum menyiapkan SELL. Coba beberapa saat lagi.");
    return;
  }

  await setPending({ token, side: "sell", size: String(size), createdAt: Date.now(), expiresAt });
  await sendTelegramWithButtons(env, chatId, [
    "🔴 <b>KUCOIN ISOLATED MARGIN — ONE TAP SELL</b>",
    `Pair: <b>${SYMBOL}</b>`,
    `Referensi harga: <b>${format(reference.price, 2)}</b> USDT (${escapeHtml(reference.source)})`,
    `BTC tersedia: <b>${format(balances.btcAvailable, 8)} BTC</b>`,
    `Jumlah order: <b>${format(size, 8)} BTC</b>`,
    "Order: <b>MARKET SELL</b>",
    "Auto-borrow: <b>OFF</b>",
    "Backend: <b>Vercel Singapore</b>",
    "",
    "⚠️ Satu klik pada tombol SELL langsung mengirim order live.",
  ].join("\n"), [
    [{ text: `✅ SELL SEMUA ${format(size, 8)} BTC`, callback_data: `kv2:s:${token}` }],
    [{ text: "❌ Batal", callback_data: `kv2:x:${token}` }],
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

  const match = /^kv2:([bsx]):([a-f0-9]{10,24})$/i.exec(data);
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
    const clientOid = `tgvercelv2${token}`.slice(0, 40);

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
        "Backend: <b>Vercel Singapore</b>",
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
        "Backend: <b>Vercel Singapore</b>",
        "",
        "Sekitar 5 menit lagi bot akan menyiapkan tombol BUY menggunakan seluruh USDT available.",
      ].join("\n"));
    }
  } catch (error) {
    await notifyTo(env, chatId, "❌ <b>ORDER KUCOIN GAGAL</b>\n" + escapeHtml(formatError(error))).catch(() => {});
  }

  return json({ ok: true });
}

async function proxyHealth(env) {
  const url = getProxyUrl(env);
  let response;
  try {
    response = await fetch(url, { method: "GET", headers: { accept: "application/json" } });
  } catch (error) {
    throw new Error(`Tidak dapat menghubungi Vercel proxy: ${formatError(error)}`);
  }
  const text = await response.text();
  const payload = parseJson(text);
  if (!response.ok || payload?.ok !== true) {
    throw new Error(`Vercel proxy health HTTP ${response.status}: ${formatPayload(payload, text)}`);
  }
  return payload;
}

async function getBalances(env) {
  const endpoint = `/api/v3/isolated/accounts?symbol=${SYMBOL}&quoteCurrency=USDT&queryType=ISOLATED`;
  const data = await kucoinProxy(env, "GET", endpoint, null);
  const assets = Array.isArray(data?.assets) ? data.assets : [];
  const pair = assets.find((item) => String(item?.symbol || "").toUpperCase() === SYMBOL);
  const usdtAvailable = Number(pair?.quoteAsset?.available ?? 0);
  const btcAvailable = Number(pair?.baseAsset?.available ?? 0);
  if (!Number.isFinite(usdtAvailable) || !Number.isFinite(btcAvailable)) {
    throw new Error(`Format saldo Isolated Margin tidak valid: ${formatPayload(data, "")}`);
  }
  return { usdtAvailable, btcAvailable };
}

async function placeMarginOrder(env, body) {
  return kucoinProxy(env, "POST", "/api/v3/hf/margin/order", body);
}

async function kucoinProxy(env, method, endpoint, body) {
  const proxyUrl = getProxyUrl(env);
  const proxySecret = getProxySecret(env);
  if (!proxySecret) throw new Error("Proxy secret belum dikonfigurasi di Cloudflare");

  const ts = String(Date.now());
  const canonicalBody = body == null ? "" : JSON.stringify(body);
  const signed = `${ts}\n${method.toUpperCase()}\n${endpoint}\n${canonicalBody}`;
  const signature = await hmacHex(proxySecret, signed);

  let response;
  try {
    response = await fetch(proxyUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-kc-proxy-ts": ts,
        "x-kc-proxy-sign": signature,
      },
      body: JSON.stringify({ method: method.toUpperCase(), endpoint, body }),
    });
  } catch (error) {
    throw new Error(`Fetch Vercel proxy gagal: ${formatError(error)}`);
  }

  const text = await response.text();
  const payload = parseJson(text);
  if (!response.ok || payload?.ok !== true) {
    throw new Error(`Vercel proxy HTTP ${response.status}: ${formatPayload(payload, text)}`);
  }
  return payload.data;
}

function getProxyUrl(env) {
  return String(env.KUCOIN_PROXY_URL || DEFAULT_PROXY_URL).trim();
}

function getProxySecret(env) {
  return String(env.KUCOIN_PROXY_SECRET || env.KUCOIN_API_SECRET || "").trim();
}

async function getReferencePrice() {
  const sources = [
    ["MEXC", "https://api.mexc.com/api/v3/ticker/price?symbol=BTCUSDT"],
    ["Binance", "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"],
  ];
  for (const [source, url] of sources) {
    try {
      const response = await fetch(url, { headers: { accept: "application/json" } });
      const data = await response.json().catch(() => ({}));
      const price = Number(data?.price);
      if (response.ok && price > 0) return { price, source };
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

async function sendTelegramWithButtons(env, chatId, text, inlineKeyboard) {
  return telegramApi(env, "sendMessage", {
    chat_id: String(chatId),
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

async function notify(env, text) {
  if (!env.TELEGRAM_CHAT_ID) return;
  return notifyTo(env, String(env.TELEGRAM_CHAT_ID), text);
}

async function notifyTo(env, chatId, text) {
  return telegramApi(env, "sendMessage", {
    chat_id: String(chatId),
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

async function answerCallback(env, callbackId, text) {
  return telegramApi(env, "answerCallbackQuery", {
    callback_query_id: callbackId,
    text: String(text).slice(0, 180),
    show_alert: false,
  });
}

async function telegramApi(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN belum ada di Cloudflare");
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const data = parseJson(text);
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.description || `Telegram HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return data.result;
}

async function notifyCycleErrorOnce(env, message) {
  const cleanMessage = formatError(message).slice(0, 700);
  const key = new Request(`${ERROR_URL}/${await sha256Hex(cleanMessage)}`);
  const existing = await caches.default.match(key);
  if (existing) return;
  await caches.default.put(key, new Response("1", { headers: { "cache-control": "max-age=600" } }));
  await notify(env, "⚠️ <b>KUCOIN CYCLE ERROR</b>\n" + escapeHtml(cleanMessage));
}

async function getState() {
  const response = await caches.default.match(new Request(STATE_URL));
  return response ? response.json().catch(() => null) : null;
}
async function setState(value) {
  await caches.default.put(new Request(STATE_URL), new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", "cache-control": "max-age=86400" },
  }));
}
async function getPending() {
  const response = await caches.default.match(new Request(PENDING_URL));
  return response ? response.json().catch(() => null) : null;
}
async function setPending(value) {
  await caches.default.put(new Request(PENDING_URL), new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", "cache-control": "max-age=420" },
  }));
}
async function clearPending() {
  await caches.default.delete(new Request(PENDING_URL));
}

async function hmacHex(secret, data) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseJson(text) {
  try { return text ? JSON.parse(text) : {}; } catch { return null; }
}

function formatPayload(payload, text) {
  if (payload !== null && payload !== undefined) {
    if (typeof payload === "string") return payload.slice(0, 700);
    if (typeof payload?.error === "string") return payload.error.slice(0, 700);
    try { return JSON.stringify(payload).slice(0, 700); } catch {}
  }
  return String(text || "respons kosong").replace(/\s+/g, " ").slice(0, 700);
}

function formatError(value) {
  if (value instanceof Error) return value.message || String(value);
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function roundDown(value, decimals) {
  const factor = 10 ** decimals;
  return Math.floor(Number(value) * factor + 1e-12) / factor;
}
function format(value, decimals) {
  return Number(value).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
