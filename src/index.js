const MEXC_BASE = "https://api.mexc.com/api/v3";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({
        ok: true,
        service: "analisa-crypto-bot",
        runtime: "cloudflare-workers",
        telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN),
        xaiConfigured: Boolean(env.XAI_API_KEY),
        newsConfigured: Boolean(env.NEWS_API_KEY),
      });
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      if (env.TELEGRAM_WEBHOOK_SECRET) {
        const secret = request.headers.get("x-telegram-bot-api-secret-token");
        if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
          return json({ ok: false, error: "Unauthorized webhook" }, 401);
        }
      }

      const update = await request.json().catch(() => null);
      if (!update) return json({ ok: false, error: "Invalid JSON" }, 400);

      await handleTelegramUpdate(update, env);
      return json({ ok: true });
    }

    return json({ ok: false, error: "Not found" }, 404);
  },
};

async function handleTelegramUpdate(update, env) {
  const message = update.message;
  if (!message?.chat?.id || !message?.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();
  const [rawCommand, rawSymbol] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().split("@")[0];

  if (command === "/start") {
    return sendTelegram(env, chatId,
      "🤖 <b>Analisa Crypto Bot</b>\n\n" +
      "Bot aktif dan siap dikembangkan untuk analisa pasar + berita.\n\n" +
      "Perintah awal:\n" +
      "• /price BTCUSDT — harga & perubahan 24 jam\n" +
      "• /status — status konfigurasi API\n\n" +
      "⚠️ Analisa bukan jaminan keuntungan dan bukan nasihat keuangan."
    );
  }

  if (command === "/status") {
    const lines = [
      "⚙️ <b>Status API</b>",
      `Telegram: ${yesNo(env.TELEGRAM_BOT_TOKEN)}`,
      `MEXC private key: ${yesNo(env.MEXC_API_KEY && env.MEXC_API_SECRET)}`,
      `xAI: ${yesNo(env.XAI_API_KEY)}`,
      `News API: ${yesNo(env.NEWS_API_KEY)}`,
      `Trading Economics: ${yesNo(env.TRADING_ECONOMICS_API_KEY)}`,
      `CoinGlass: ${yesNo(env.COINGLASS_API_KEY)}`,
      `FRED: ${yesNo(env.FRED_API_KEY)}`,
      "",
      "MEXC public market data tetap dapat dipakai tanpa API key.",
    ];
    return sendTelegram(env, chatId, lines.join("\n"));
  }

  if (command === "/price") {
    const symbol = normalizeSymbol(rawSymbol || "BTCUSDT");
    try {
      const ticker = await getMexcTicker(symbol);
      const price = Number(ticker.lastPrice);
      const change = Number(ticker.priceChangePercent);
      const volume = Number(ticker.quoteVolume);
      const arrow = change > 0 ? "🟢" : change < 0 ? "🔴" : "⚪";

      return sendTelegram(env, chatId,
        `📊 <b>${escapeHtml(symbol)}</b>\n` +
        `Harga: <b>${formatNumber(price)}</b> USDT\n` +
        `${arrow} 24 jam: <b>${formatSigned(change)}%</b>\n` +
        `Volume quote 24j: ${formatCompact(volume)} USDT\n\n` +
        `Sumber: MEXC public market data`
      );
    } catch (error) {
      return sendTelegram(env, chatId, `❌ Gagal mengambil ${escapeHtml(symbol)} dari MEXC: ${escapeHtml(error.message)}`);
    }
  }

  return sendTelegram(env, chatId,
    "Perintah belum dikenal. Gunakan /start, /price BTCUSDT, atau /status."
  );
}

async function getMexcTicker(symbol) {
  const response = await fetch(`${MEXC_BASE}/ticker/24hr?symbol=${encodeURIComponent(symbol)}`, {
    headers: { "accept": "application/json" },
  });

  if (!response.ok) {
    throw new Error(`MEXC HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!data?.lastPrice) throw new Error("Ticker tidak ditemukan");
  return data;
}

async function sendTelegram(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN belum dikonfigurasi");
  }

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
    throw new Error(`Telegram HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
}

function normalizeSymbol(input) {
  return String(input)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 24);
}

function yesNo(value) {
  return value ? "✅ siap" : "❌ belum";
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "-";
  if (value >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (value >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
  return value.toLocaleString("en-US", { maximumFractionDigits: 10 });
}

function formatSigned(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function formatCompact(value) {
  if (!Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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
