import kucoin from "./kucoin-one-tap-all.js";

const BUILD_VERSION = "2026-08-27-kucoin-safe-wrapper-v1";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/wrapper-health") {
      return json({ ok: true, version: BUILD_VERSION, inner: "kucoin-one-tap-all" });
    }

    let telegramMeta = null;
    if (request.method === "POST" && url.pathname === "/telegram") {
      const clone = request.clone();
      const update = await clone.json().catch(() => null);
      telegramMeta = {
        chatId: update?.message?.chat?.id != null
          ? String(update.message.chat.id)
          : update?.callback_query?.message?.chat?.id != null
            ? String(update.callback_query.message.chat.id)
            : null,
        text: String(update?.message?.text || "").trim(),
      };
    }

    try {
      return await kucoin.fetch(request, env, ctx);
    } catch (error) {
      const message = clean(error?.message || error);
      console.error("KuCoin wrapper fetch error:", message);

      if (telegramMeta?.chatId && isAuthorizedTelegram(request, env, telegramMeta.chatId)) {
        const isRateLimit = /too many requests|rate limit|429|429000/i.test(message);
        const friendly = isRateLimit
          ? "⏳ <b>KuCoin sedang membatasi request API</b>\nTunggu sekitar 60 detik lalu kirim /kucointrade lagi."
          : "❌ <b>KUCOIN BOT ERROR</b>\n" + escapeHtml(message) + "\n\nKirim /kucointrade lagi setelah masalah diperbaiki.";
        await notifyTo(env, telegramMeta.chatId, friendly).catch(() => {});
      }

      return json({ ok: false, error: message }, 502);
    }
  },

  async scheduled(event, env, ctx) {
    try {
      if (typeof kucoin.scheduled === "function") {
        return await kucoin.scheduled(event, env, ctx);
      }
    } catch (error) {
      const message = clean(error?.message || error);
      console.error("KuCoin wrapper scheduled error:", message);
      if (!/too many requests|rate limit|429|429000/i.test(message)) {
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
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: String(chatId),
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
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
