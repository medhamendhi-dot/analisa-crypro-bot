import router from "./router.js";
import { getKucoinReadOnlyStatus } from "./kucoin-readonly.js";

const BUILD_VERSION = "2026-08-27-kucoin-one-tap-commands-v2";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/command-version") {
      return json({ ok: true, version: BUILD_VERSION });
    }

    if (request.method === "GET" && url.pathname === "/kucoin-health") {
      const status = await getKucoinReadOnlyStatus(env);
      return json(status, status.ok ? 200 : 503);
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
        "• /newsbtc — berita crypto/BTC terbaru\n" +
        "• /kucoin — cek koneksi API KuCoin\n" +
        "• /kucointrade — buat proposal order KuCoin dengan tombol 1-tap\n\n" +
        "Siklus KuCoin memakai Isolated Margin BTC-USDT. Bot menyiapkan BUY/SELL, tetapi order live hanya dikirim setelah tombol Konfirmasi ditekan di Telegram.\n\n" +
        "⚠️ Market order dapat terkena fee dan slippage."
      );
      return json({ ok: true });
    }

    if (command === "/kucoin") {
      const status = await getKucoinReadOnlyStatus(env);
      if (status.ok) {
        const permissions = escapeHtml(status.permission || "-");
        const hasMargin = String(status.permission || "").toLowerCase().includes("margin");
        await sendTelegram(env, chatId,
          "✅ <b>KUCOIN API TERHUBUNG</b>\n\n" +
          `API version: <b>${escapeHtml(String(status.apiVersion || "-"))}</b>\n` +
          `Permission: <b>${permissions}</b>\n` +
          `Margin permission: <b>${hasMargin ? "✅ ada" : "⚠️ tidak terdeteksi"}</b>\n` +
          `Region: <b>${escapeHtml(String(status.region || "-"))}</b>\n\n` +
          "Gunakan /kucointrade untuk membuat proposal order 1-tap."
        );
      } else {
        await sendTelegram(env, chatId,
          "❌ <b>KUCOIN API BELUM TERHUBUNG</b>\n\n" +
          `${escapeHtml(status.error || "Autentikasi gagal")}\n\n` +
          `Key: ${status.configured?.key ? "✅" : "❌"}\n` +
          `Secret: ${status.configured?.secret ? "✅" : "❌"}\n` +
          `Passphrase: ${status.configured?.passphrase ? "✅" : "❌"}`
        );
      }
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
        "• /newsbtc untuk berita BTC\n" +
        "• /kucoin untuk cek koneksi KuCoin\n" +
        "• /kucointrade untuk proposal order 1-tap"
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
