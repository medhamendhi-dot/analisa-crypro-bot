import monitor from "./auto-monitor.js";

const BUILD_VERSION = "2026-08-27-kucoin-one-tap-all-v1";
const SYMBOL = "BTC-USDT";
const KUCOIN_BASE = "https://api.kucoin.com";
const STATE_URL = "https://state.local/kucoin-one-tap-all-cycle";
const PENDING_URL = "https://state.local/kucoin-one-tap-all-pending";
const VERSION_URL = "https://state.local/kucoin-api-version";
const PRICE_URL = "https://state.local/kucoin-reference-price";
const FIVE_MINUTES = 5 * 60 * 1000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/kucoin-confirm-health") {
      let availableUsdt = null;
      let balanceError = null;
      if (hasKucoinSecrets(env)) {
        try {
          availableUsdt = await getAvailableIsolatedUsdt(env);
        } catch (error) {
          balanceError = clean(error?.message || error);
        }
      }

      return json({
        ok: true,
        version: BUILD_VERSION,
        mode: "one-tap-confirmation",
        liveOrderOnlyAfterTelegramTap: true,
        isolatedMargin: true,
        autoBorrow: false,
        symbol: SYMBOL,
        schedule: "proposal checked every 5 minutes",
        buySizing: "all available isolated-margin USDT",
        availableUsdt,
        optionalMaxOrderUsdt: getMaxOrderUsdt(env),
        balanceError,
        configured: {
          telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
          kucoinKey: Boolean(env.KUCOIN_API_KEY),
          kucoinSecret: Boolean(env.KUCOIN_API_SECRET),
          kucoinPassphrase: Boolean(env.KUCOIN_API_PASSPHRASE),
        },
        state: await getState(),
        pending: redactPending(await getPending()),
      });
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      const clone = request.clone();
      const update = await clone.json().catch(() => null);

      if (update?.callback_query) {
        return handleCallbackQuery(request, update.callback_query, env);
      }

      const chatId = update?.message?.chat?.id != null ? String(update.message.chat.id) : null;
      const text = String(update?.message?.text || "").trim();
      const command = text.split(/\s+/)[0]?.toLowerCase().split("@")[0] || "";

      if (chatId && (command === "/kucointrade" || command === "/kucoincycle")) {
        if (!isAuthorizedTelegram(request, env, chatId)) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }
        await sendNextProposal(env, chatId, true);
        return json({ ok: true });
      }
    }

    return monitor.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    try {
      monitor.scheduled(event, env, ctx);
    } catch (error) {
      console.error("auto-monitor scheduled setup gagal", clean(error?.message));
    }

    ctx.waitUntil(runProposalCycle(event, env).catch(async (error) => {
      const message = clean(error?.message || error);
      console.error("KuCoin one-tap-all cycle gagal", message);
      if (!isRateLimitError(message)) {
        await notify(env, "⚠️ <b>KUCOIN ONE-TAP ERROR</b>\n" + escapeHtml(message)).catch(() => {});
      }
    }));
  },
};

async function runProposalCycle(event, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  if (!hasKucoinSecrets(env)) return;

  const pending = await getPending();
  if (pending && Number(pending.expiresAt || 0) > Date.now()) return;
  if (pending) await clearPending();

  const state = await getState();
  const scheduledMs = Number(event?.scheduledTime || Date.now());
  if (state?.nextAt && scheduledMs < Number(state.nextAt)) return;

  await sendNextProposal(env, String(env.TELEGRAM_CHAT_ID), false);
}

async function sendNextProposal(env, chatId, force) {
  if (!hasKucoinSecrets(env)) {
    await notifyTo(env, chatId,
      "❌ <b>KuCoin belum siap</b>\nPastikan KUCOIN_API_KEY, KUCOIN_API_SECRET, dan KUCOIN_API_PASSPHRASE sudah ada di Cloudflare."
    );
    return;
  }

  const existing = await getPending();
  if (!force && existing && Number(existing.expiresAt || 0) > Date.now()) return;
  if (existing) await clearPending();

  const state = await getState();
  if (!force && state?.nextAt && Date.now() < Number(state.nextAt)) return;

  const reference = await getReferencePrice();
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 18);
  const expiresAt = Date.now() + 6 * 60 * 1000;

  if (state?.lastAction === "BUY" && state?.buyOrderId) {
    const order = await getMarginOrder(env, state.buyOrderId);
    const dealSize = Number(order?.dealSize || 0);
    if (!Number.isFinite(dealSize) || dealSize <= 0) {
      await notifyTo(env, chatId,
        "⏳ <b>Order BUY belum memiliki ukuran fill</b>\nBot belum membuat proposal SELL. Coba /kucointrade beberapa saat lagi."
      );
      return;
    }

    // Sisakan dust sangat kecil untuk mengurangi risiko penolakan akibat fee/rounding.
    const size = roundDown(dealSize * 0.999, 8);
    if (!Number.isFinite(size) || size <= 0) {
      throw new Error("Ukuran BTC untuk SELL tidak valid");
    }

    const pending = {
      token,
      side: "sell",
      size: String(size),
      referencePrice: reference.price,
      referenceSource: reference.source,
      createdAt: Date.now(),
      expiresAt,
    };
    await setPending(pending);

    await sendTelegramWithButtons(env, chatId, [
      "🔴 <b>KUCOIN ISOLATED MARGIN — KONFIRMASI SELL</b>",
      `Pair: <b>${SYMBOL}</b>`,
      `Referensi harga: <b>${format(reference.price, 2)}</b> USDT (${escapeHtml(reference.source)})`,
      `Jumlah: <b>${format(size, 8)} BTC</b>`,
      "Order: <b>MARKET SELL</b>",
      "Auto-borrow: <b>OFF</b>",
      "",
      "Tekan tombol di bawah untuk mengirim order live ke KuCoin.",
      "Tombol kedaluwarsa sekitar 6 menit.",
    ].join("\n"), [
      [{ text: `✅ Konfirmasi SELL ${format(size, 8)} BTC`, callback_data: `kca:s:${token}` }],
      [{ text: "❌ Batal", callback_data: `kca:x:${token}` }],
    ]);
    return;
  }

  const available = await getAvailableIsolatedUsdt(env);
  const cap = getMaxOrderUsdt(env);
  const funds = roundDown(Math.min(available, cap ?? available), 6);

  if (!Number.isFinite(funds) || funds <= 0) {
    await notifyTo(env, chatId,
      "❌ <b>Saldo USDT Isolated Margin tidak tersedia</b>\nTidak ada proposal BUY yang dibuat."
    );
    return;
  }

  const pending = {
    token,
    side: "buy",
    funds: String(funds),
    availableAtProposal: String(available),
    referencePrice: reference.price,
    referenceSource: reference.source,
    createdAt: Date.now(),
    expiresAt,
  };
  await setPending(pending);

  await sendTelegramWithButtons(env, chatId, [
    "🟢 <b>KUCOIN ISOLATED MARGIN — KONFIRMASI BUY</b>",
    `Pair: <b>${SYMBOL}</b>`,
    `Referensi harga: <b>${format(reference.price, 2)}</b> USDT (${escapeHtml(reference.source)})`,
    `Saldo USDT tersedia: <b>${format(available, 6)} USDT</b>`,
    `Dana order: <b>${format(funds, 6)} USDT</b>`,
    "Order: <b>MARKET BUY</b>",
    "Auto-borrow: <b>OFF</b>",
    "",
    "Bot memakai saldo USDT tersedia di akun Isolated Margin; API KuCoin tidak membedakan dana trial dan dana pribadi.",
    "Tekan tombol di bawah untuk mengirim order live ke KuCoin.",
  ].join("\n"), [
    [{ text: `✅ Konfirmasi BUY ${format(funds, 6)} USDT`, callback_data: `kca:b:${token}` }],
    [{ text: "❌ Batal", callback_data: `kca:x:${token}` }],
  ]);
}

async function handleCallbackQuery(request, callback, env) {
  const chatId = callback?.message?.chat?.id != null ? String(callback.message.chat.id) : null;
  const callbackId = String(callback?.id || "");
  const data = String(callback?.data || "");

  if (!chatId || !isAuthorizedTelegram(request, env, chatId)) {
    if (callbackId) await answerCallback(env, callbackId, "Tidak diizinkan").catch(() => {});
    return json({ ok: true });
  }

  const match = /^kca:([bsx]):([a-f0-9]{10,24})$/i.exec(data);
  if (!match) return json({ ok: true });

  const action = match[1].toLowerCase();
  const token = match[2];
  const pending = await getPending();

  if (!pending || pending.token !== token || Number(pending.expiresAt || 0) < Date.now()) {
    await clearPending();
    await answerCallback(env, callbackId, "Tombol sudah kedaluwarsa").catch(() => {});
    await notifyTo(env, chatId, "⌛ Konfirmasi sudah kedaluwarsa. Gunakan /kucointrade untuk membuat proposal baru.");
    return json({ ok: true });
  }

  if (action === "x") {
    await clearPending();
    await answerCallback(env, callbackId, "Dibatalkan").catch(() => {});
    await notifyTo(env, chatId, "❌ Order KuCoin dibatalkan. Tidak ada order yang dikirim.");
    return json({ ok: true });
  }

  const expected = pending.side === "buy" ? "b" : "s";
  if (action !== expected) {
    await answerCallback(env, callbackId, "Konfirmasi tidak cocok").catch(() => {});
    return json({ ok: true });
  }

  await clearPending();
  await answerCallback(env, callbackId, "Mengirim order ke KuCoin...").catch(() => {});

  try {
    const clientOid = `tgall${token}`.slice(0, 40);
    let result;

    if (pending.side === "buy") {
      // Jangan pernah menaikkan nominal di atas yang ditampilkan pada tombol.
      // Jika saldo berkurang sebelum tombol ditekan, gunakan saldo yang tersisa.
      const currentAvailable = await getAvailableIsolatedUsdt(env);
      const approvedFunds = Number(pending.funds);
      const funds = roundDown(Math.min(currentAvailable, approvedFunds), 6);
      if (!Number.isFinite(funds) || funds <= 0) {
        throw new Error("Saldo USDT Isolated Margin tidak cukup saat konfirmasi");
      }

      result = await placeMarginOrder(env, {
        clientOid,
        symbol: SYMBOL,
        side: "buy",
        type: "market",
        funds: String(funds),
        isIsolated: true,
        autoBorrow: false,
        autoRepay: false,
      });

      await setState({
        lastAction: "BUY",
        buyOrderId: result?.orderId || null,
        buyClientOid: clientOid,
        confirmedAt: Date.now(),
        nextAt: Date.now() + FIVE_MINUTES,
      });

      await notifyTo(env, chatId, [
        "✅ <b>KUCOIN BUY TERKIRIM</b>",
        `Pair: <b>${SYMBOL}</b>`,
        `Dana: <b>${format(funds, 6)} USDT</b>`,
        `Order ID: <code>${escapeHtml(result?.orderId || "-")}</code>`,
        "Mode: <b>Isolated Margin / Market</b>",
        "Auto-borrow: <b>OFF</b>",
        "",
        "Bot akan menyiapkan konfirmasi SELL setelah jeda sekitar 5 menit.",
      ].join("\n"));
    } else {
      result = await placeMarginOrder(env, {
        clientOid,
        symbol: SYMBOL,
        side: "sell",
        type: "market",
        size: String(pending.size),
        isIsolated: true,
        autoBorrow: false,
        autoRepay: false,
      });

      await setState({
        lastAction: "SELL",
        sellOrderId: result?.orderId || null,
        sellClientOid: clientOid,
        confirmedAt: Date.now(),
        nextAt: Date.now() + FIVE_MINUTES,
      });

      await notifyTo(env, chatId, [
        "✅ <b>KUCOIN SELL TERKIRIM</b>",
        `Pair: <b>${SYMBOL}</b>`,
        `Jumlah: <b>${format(Number(pending.size), 8)} BTC</b>`,
        `Order ID: <code>${escapeHtml(result?.orderId || "-")}</code>`,
        "Mode: <b>Isolated Margin / Market</b>",
        "",
        "Bot akan menyiapkan konfirmasi BUY berikutnya setelah jeda sekitar 5 menit.",
      ].join("\n"));
    }
  } catch (error) {
    await notifyTo(env, chatId, [
      "❌ <b>ORDER KUCOIN GAGAL</b>",
      escapeHtml(clean(error?.message || error)),
      "",
      "Tidak ada retry otomatis. Gunakan /kucointrade untuk membuat proposal baru.",
    ].join("\n"));
  }

  return json({ ok: true });
}

async function getAvailableIsolatedUsdt(env) {
  const endpoint = `/api/v3/isolated/accounts?symbol=${encodeURIComponent(SYMBOL)}&quoteCurrency=USDT&queryType=ISOLATED`;
  const data = await kucoinPrivate(env, "GET", endpoint, null);
  const assets = Array.isArray(data?.assets) ? data.assets : [];
  const pair = assets.find((item) => String(item?.symbol || "").toUpperCase() === SYMBOL);
  const available = Number(pair?.quoteAsset?.available);
  if (!Number.isFinite(available) || available < 0) {
    throw new Error("KuCoin tidak mengembalikan saldo USDT available untuk BTC-USDT Isolated Margin");
  }
  return available;
}

async function placeMarginOrder(env, body) {
  if (!hasKucoinSecrets(env)) throw new Error("Secret KuCoin belum lengkap");
  return kucoinPrivate(env, "POST", "/api/v3/hf/margin/order", body);
}

async function getMarginOrder(env, orderId) {
  const endpoint = `/api/v3/hf/margin/orders/${encodeURIComponent(String(orderId))}?symbol=${SYMBOL}`;
  return kucoinPrivate(env, "GET", endpoint, null);
}

async function kucoinPrivate(env, method, endpoint, bodyObj) {
  const version = await resolveApiVersion(env);
  return kucoinSignedRaw(env, method, endpoint, bodyObj, version);
}

async function resolveApiVersion(env) {
  const configured = String(env.KUCOIN_API_KEY_VERSION || "").trim();
  if (configured) return configured;

  const cached = await caches.default.match(new Request(VERSION_URL));
  if (cached) {
    const data = await cached.json().catch(() => null);
    if (data?.version) return String(data.version);
  }

  let lastError = null;
  for (const version of ["3", "2"]) {
    try {
      await kucoinSignedRaw(env, "GET", "/api/v1/user/api-key", null, version);
      await caches.default.put(new Request(VERSION_URL), new Response(JSON.stringify({ version }), {
        headers: { "content-type": "application/json", "cache-control": "max-age=86400" },
      }));
      return version;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Tidak dapat menentukan KC-API-KEY-VERSION");
}

async function kucoinSignedRaw(env, method, endpoint, bodyObj, version) {
  const body = bodyObj == null ? "" : JSON.stringify(bodyObj);
  const timestamp = String(Date.now());
  const prehash = `${timestamp}${method.toUpperCase()}${endpoint}${body}`;

  const [signature, passphrase] = await Promise.all([
    hmacBase64(env.KUCOIN_API_SECRET, prehash),
    hmacBase64(env.KUCOIN_API_SECRET, env.KUCOIN_API_PASSPHRASE),
  ]);

  const response = await fetch(`${KUCOIN_BASE}${endpoint}`, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "KC-API-KEY": env.KUCOIN_API_KEY,
      "KC-API-SIGN": signature,
      "KC-API-TIMESTAMP": timestamp,
      "KC-API-PASSPHRASE": passphrase,
      "KC-API-KEY-VERSION": String(version),
    },
    body: body || undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.code !== "200000") {
    const code = payload?.code || `HTTP ${response.status}`;
    const message = payload?.msg || payload?.message || "request gagal";
    throw new Error(`${code}: ${message}`);
  }
  return payload.data;
}

async function getReferencePrice() {
  const cached = await caches.default.match(new Request(PRICE_URL));
  if (cached) {
    const data = await cached.json().catch(() => null);
    if (Number(data?.price) > 0) return data;
  }

  const sources = [
    async () => {
      const response = await fetch(`${KUCOIN_BASE}/api/v1/market/orderbook/level1?symbol=${SYMBOL}`, {
        headers: { accept: "application/json" },
      });
      const data = await response.json().catch(() => ({}));
      const price = Number(data?.data?.price);
      if (!response.ok || data?.code !== "200000" || !Number.isFinite(price) || price <= 0) {
        throw new Error(data?.msg || data?.message || `KuCoin HTTP ${response.status}`);
      }
      return { price, source: "KuCoin" };
    },
    async () => {
      const response = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", {
        headers: { accept: "application/json" },
      });
      const data = await response.json().catch(() => ({}));
      const price = Number(data?.price);
      if (!response.ok || !Number.isFinite(price) || price <= 0) throw new Error(`Binance HTTP ${response.status}`);
      return { price, source: "Binance fallback" };
    },
    async () => {
      const response = await fetch("https://api.mexc.com/api/v3/ticker/price?symbol=BTCUSDT", {
        headers: { accept: "application/json" },
      });
      const data = await response.json().catch(() => ({}));
      const price = Number(data?.price);
      if (!response.ok || !Number.isFinite(price) || price <= 0) throw new Error(`MEXC HTTP ${response.status}`);
      return { price, source: "MEXC fallback" };
    },
  ];

  const errors = [];
  for (const read of sources) {
    try {
      const result = await read();
      await caches.default.put(new Request(PRICE_URL), new Response(JSON.stringify(result), {
        headers: { "content-type": "application/json", "cache-control": "max-age=30" },
      }));
      return result;
    } catch (error) {
      errors.push(clean(error?.message));
    }
  }
  throw new Error(`Semua sumber harga gagal: ${errors.join("; ")}`);
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

function getMaxOrderUsdt(env) {
  const raw = String(env.KUCOIN_MAX_ORDER_USDT || "").trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function getState() {
  const response = await caches.default.match(new Request(STATE_URL));
  return response ? response.json().catch(() => null) : null;
}

async function setState(state) {
  await caches.default.put(new Request(STATE_URL), new Response(JSON.stringify(state), {
    headers: { "content-type": "application/json", "cache-control": "max-age=86400" },
  }));
}

async function getPending() {
  const response = await caches.default.match(new Request(PENDING_URL));
  return response ? response.json().catch(() => null) : null;
}

async function setPending(pending) {
  await caches.default.put(new Request(PENDING_URL), new Response(JSON.stringify(pending), {
    headers: { "content-type": "application/json", "cache-control": "max-age=420" },
  }));
}

async function clearPending() {
  await caches.default.delete(new Request(PENDING_URL));
}

function redactPending(pending) {
  if (!pending) return null;
  return {
    side: pending.side,
    funds: pending.funds || null,
    size: pending.size || null,
    referencePrice: pending.referencePrice || null,
    referenceSource: pending.referenceSource || null,
    expiresAt: pending.expiresAt || null,
  };
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

async function answerCallback(env, callbackQueryId, text) {
  return telegramApi(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: String(text).slice(0, 180),
    show_alert: false,
  });
}

async function telegramApi(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN belum dikonfigurasi");
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.description || `Telegram HTTP ${response.status}`);
  }
  return data.result;
}

async function hmacBase64(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(String(message)));
  const bytes = new Uint8Array(signature);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function isRateLimitError(message) {
  const text = String(message || "").toLowerCase();
  return text.includes("too many requests") || text.includes("rate limit") || text.includes("429");
}

function roundDown(value, decimals) {
  const factor = 10 ** decimals;
  return Math.floor(Number(value) * factor) / factor;
}

function format(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString("en-US", { maximumFractionDigits: decimals });
}

function clean(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 500)
    .trim();
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
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
