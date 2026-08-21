import monitor from "./auto-monitor.js";

const BUILD_VERSION = "2026-08-21-telegram-test-v1";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/notification-health") {
      return json({
        ok: true,
        version: BUILD_VERSION,
        telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
        testCommand: "/testnotif",
      });
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      const clone = request.clone();
      const update = await clone.json().catch(() => null);
      const message = update?.message;
      const chatId = message?.chat?.id != null ? String(message.chat.id) : null;
      const text = String(message?.text || "").trim();
      const command = String(text.split(/\s+/)[0] || "").toLowerCase().split("@")[0];

      if (command === "/testnotif") {
        if (env.TELEGRAM_WEBHOOK_SECRET) {
          const secret = request.headers.get("x-telegram-bot-api-secret-token");
          if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
            return json({ ok: false, error: "Unauthorized webhook" }, 401);
          }
        }

        if (!chatId) return json({ ok: true });
        if (env.TELEGRAM_CHAT_ID && chatId !== String(env.TELEGRAM_CHAT_ID)) {
          return json({ ok: true });
        }

        if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
          return json({ ok: false, error: "Telegram belum dikonfigurasi" }, 503);
        }

        try {
          await sendTelegram(
            env,
            chatId,
            "✅ <b>TES NOTIFIKASI BERHASIL</b>\n\n" +
              "Worker berhasil mengirim pesan ke Telegram Anda.\n" +
              "Jalur notifikasi otomatis market menggunakan BOT TOKEN dan CHAT ID yang sama.\n\n" +
              "⏱️ Monitor market: setiap 5 menit\n" +
              "📰 Scan berita: setiap 10 menit"
          );
          return json({ ok: true, delivered: true });
        } catch (error) {
          return json({ ok: false, delivered: false, error: clean(error?.message) }, 502);
        }
      }
    }

    return monitor.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return monitor.scheduled(event, env, ctx);
  },
};

async function sendTelegram(env, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram HTTP ${response.status}: ${body.slice(0, 250)}`);
  }
}

function clean(value) {
  return String(value || "Unknown error")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
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
