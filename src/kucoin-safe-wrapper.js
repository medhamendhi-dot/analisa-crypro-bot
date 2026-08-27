import kucoin from "./kucoin-one-tap-all.js";
import monitor from "./auto-monitor.js";

const BUILD_VERSION = "2026-08-27-kucoin-safe-wrapper-v2-region-block";
const REGION_BLOCK_MESSAGE =
  "⛔ <b>KuCoin trading sementara dinonaktifkan</b>\n" +
  "Server Cloudflare Worker ini terdeteksi KuCoin sebagai IP wilayah AS (error 400302).\n\n" +
  "Tidak ada order yang dikirim. Bot analisa tetap aktif.\n" +
  "Trading KuCoin baru bisa diaktifkan lagi setelah backend menggunakan egress IP dari wilayah yang didukung KuCoin dan sesuai dengan akun Anda.";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/wrapper-health") {
      return json({
        ok: true,
        version: BUILD_VERSION,
        inner: "kucoin-one-tap-all",
        kucoinDirectTradingEnabled: env.KUCOIN_DIRECT_TRADING === "true",
      });
    }

    let telegramMeta = null;
    let update = null;
    if (request.method === "POST" && url.pathname === "/telegram") {
      const clone = request.clone();
      update = await clone.json().catch(() => null);
      telegramMeta = {
        chatId: update?.message?.chat?.id != null
          ? String(update.message.chat.id)
          : update?.callback_query?.message?.chat?.id != null
            ? String(update.callback_query.message.chat.id)
            : null,
        text: String(update?.message?.text || "").trim(),
        callbackId: String(update?.callback_query?.id || ""),
        callbackData: String(update?.callback_query?.data || ""),
      };
    }

    const directEnabled = env.KUCOIN_DIRECT_TRADING === "true";
    const command = telegramMeta?.text
      ? telegramMeta.text.split(/\s+/)[0].toLowerCase().split("@")[0]
      : "";
    const isKucoinCommand = command === "/kucointrade" || command === "/kucoincycle";
    const isKucoinCallback = /^kc(?:a)?:[bsx]:/i.test(telegramMeta?.callbackData || "");

    if (!directEnabled && telegramMeta?.chatId && (isKucoinCommand || isKucoinCallback)) {
      if (isAuthorizedTelegram(request, env, telegramMeta.chatId)) {
        if (telegramMeta.callbackId) {
          await answerCallback(env, telegramMeta.callbackId, "KuCoin dinonaktifkan: server terdeteksi US").catch(() => {});
        }
        await notifyTo(env, telegramMeta.chatId, REGION_BLOCK_MESSAGE).catch(() => {});
      }
      return json({ ok: true, kucoinTradingPaused: true, reason: "400302-region-block" });
    }

    try {
      return await kucoin.fetch(request, env, ctx);
    } catch (error) {
      const message = clean(error?.message || error);
      console.error("KuCoin wrapper fetch error:", message);

      if (telegramMeta?.chatId && isAuthorizedTelegram(request, env, telegramMeta.chatId)) {
        const isRegionBlocked = /400302|current area:\s*US|unavailable in the U\.S\./i.test(message);
        const isRateLimit = /too many requests|rate limit|429|429000/i.test(message);
        const friendly = isRegionBlocked
          ? REGION_BLOCK_MESSAGE
          : isRateLimit
            ? "⏳ <b>KuCoin sedang membatasi request API</b>\nTunggu sekitar 60 detik sebelum mencoba lagi."
            : "❌ <b>KUCOIN BOT ERROR</b>\n" + escapeHtml(message);
        await notifyTo(env, telegramMeta.chatId, friendly).catch(() => {});
      }

      return json({ ok: false, error: message }, 502);
    }
  },

  async scheduled(event, env, ctx) {
    // Analisa pasar tetap jalan setiap cron meskipun koneksi trading KuCoin dipause.
    try {
      if (typeof monitor.scheduled === "function") {
        monitor.scheduled(event, env, ctx);
      }
    } catch (error) {
      console.error("Monitor scheduled error:", clean(error?.message || error));
    }

    // Jangan terus memanggil KuCoin dari egress Cloudflare yang sedang diblokir.
    if (env.KUCOIN_DIRECT_TRADING !== "true") return;

    try {
      if (typeof kucoin.scheduled === "function") {
        return await kucoin.scheduled(event, env, ctx);
      }
    } catch (error) {
      const message = clean(error?.message || error);
      console.error("KuCoin wrapper scheduled error:", message);
      if (!/400302|current area:\s*US|unavailable in the U\.S\.|too many requests|rate limit|429|429000/i.test(message)) {
        await notify(env, "⚠️ <b>KUCOIN SCHEDULE ERROR</b>\n" + escapeHtml(message)).catch(() => {});
      }
    }
  },
};

function isAuthorizedTelegram(request, env, chatId) {
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const secret = request.headers.get("x-telegram-bot-api-secret-token");
    if (secret !== env.TELEGRAM_WEBHOOK_SECRET) return false;
  }
  if (env.TELEGRAM_CHAT_ID && String(chatId) !== String(env.TELEGRAM_CHAT_ID)) return false;
  return true;
}

async function notify(env, text) {
  if (!env.TELEGRAM_CHAT_ID) return;
  return notifyTo(env, String(env.TELEGRAM_CHAT_ID), text);
}

async function notifyTo(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
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
    show_alert: true,
  });
}

async function telegramApi(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
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

function clean(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 600)
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
