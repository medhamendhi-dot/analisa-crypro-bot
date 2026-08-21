import router from "./router.js";

const BUILD_VERSION = "2026-08-21-botfather-commands-v1";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/command-version") {
      return json({ ok: true, version: BUILD_VERSION });
    }

    if (request.method !== "POST" || url.pathname !== "/telegram") {
      return router.fetch(request, env, ctx);
    }

    const clone = request.clone();
    const update = await clone.json().catch(() => null);
    const message = update?.message;
    const chatId = message?.chat?.id != null ? String(message.chat.id) : null;
    const text = String(message?.text || "").trim();
    const [rawCommand] = text.split(/\s+/);
    const command = String(rawCommand || "").toLowerCase().split("@")[0];

    if (!chatId || !text) return router.fetch(request, env, ctx);

    if (env.TELEGRAM_WEBHOOK_SECRET) {
      const secret = request.headers.get("x-telegram-bot-api-secret-token");
      if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return json({ ok: false, error: "Unauthorized webhook" }, 401);
      }
    }

    if (env.TELEGRAM_CHAT_ID && chatId !== String(env.TELEGRAM_CHAT_ID)) {
      return json({ ok: true });
    }

    if (command === "/start") {
      await sendTelegram(env, chatId,
        "🤖 <b>Analisa Crypto Bot</b>\n\n" +
        "Command utama:\n" +
        "• /analyzebtc — analisa BTC lengkap\n" +
        "• /newsbtc — berita crypto/BTC terbaru\n\n" +
        "Bot menggabungkan market, derivatives, macro, berita, dan xAI untuk analisa probabilistik.\n\n" +
        "⚠️ Analisa bukan jaminan keuntungan atau nasihat keuangan."
      );
      return json({ ok: true });
    }

    if (command === "/analyzebtc") {
      return forwardAs(request, update, "/analyze BTC", env, ctx);
    }

    if (command === "/newsbtc") {
      return forwardAs(request, update, "/news BTC", env, ctx);
    }

    if (command === "/analyze" || command === "/analisa" || command === "/news") {
      await sendTelegram(env, chatId,
        "ℹ️ Command lama sudah dinonaktifkan.\n\n" +
        "Gunakan:\n" +
        "• /analyzebtc untuk analisa BTC\n" +
        "• /newsbtc untuk berita BTC"
      );
      return json({ ok: true });
    }

    return router.fetch(request, env, ctx);
  },
};

async function forwardAs(originalRequest, update, newText, env, ctx) {
  const translated = {
    ...update,
    message: {
      ...update.message,
      text: newText,
    },
  };

  const forwarded = new Request(originalRequest.url, {
    method: "POST",
    headers: new Headers(originalRequest.headers),
    body: JSON.stringify(translated),
  });

  return router.fetch(forwarded, env, ctx);
}

async function sendTelegram(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN belum dikonfigurasi");

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
    throw new Error(`Telegram HTTP ${response.status}`);
  }
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
