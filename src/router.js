import app from "./app.js";
import { getFinnhubStatusText, getMacroFallbackText } from "./macro-fallback.js";

const BUILD_VERSION = "2026-08-21-macro-fallback-v2";
const MEXC_BASE = "https://api.mexc.com/api/v3";
const BINANCE_BASES = [
  "https://data-api.binance.vision/api/v3",
  "https://api.binance.com/api/v3",
  "https://api-gcp.binance.com/api/v3",
  "https://api1.binance.com/api/v3",
  "https://api2.binance.com/api/v3",
  "https://api3.binance.com/api/v3",
  "https://api4.binance.com/api/v3",
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/version") {
      return json({ ok: true, version: BUILD_VERSION });
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      const clone = request.clone();
      const update = await clone.json().catch(() => null);
      const message = update?.message;
      const chatId = message?.chat?.id != null ? String(message.chat.id) : null;
      const text = String(message?.text || "").trim();
      const [rawCommand, rawArg] = text.split(/\s+/);
      const command = String(rawCommand || "").toLowerCase().split("@")[0];

      const handled = new Set(["/start", "/version", "/binance", "/price", "/macro", "/finnhub"]);
      if (handled.has(command)) {
        if (env.TELEGRAM_WEBHOOK_SECRET) {
          const secret = request.headers.get("x-telegram-bot-api-secret-token");
          if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
            return json({ ok: false, error: "Unauthorized webhook" }, 401);
          }
        }

        if (!chatId || !text) return json({ ok: true });
        if (env.TELEGRAM_CHAT_ID && chatId !== String(env.TELEGRAM_CHAT_ID)) {
          return json({ ok: true });
        }

        try {
          if (command === "/start") {
            await sendTelegram(env, chatId,
              "🤖 <b>Analisa Crypto Bot</b>\n\n" +
              `Build: <code>${BUILD_VERSION}</code>\n\n` +
              "Perintah utama:\n" +
              "• /price BTCUSDT — harga MEXC + Binance\n" +
              "• /binance BTCUSDT — tes Binance\n" +
              "• /mexc — tes MEXC\n" +
              "• /finnhub — cek akses Finnhub (opsional)\n" +
              "• /macro — event makro AS via FRED + You.com, fallback otomatis\n" +
              "• /coinalyze BTC — tes Coinalyze\n" +
              "• /derivatives BTC — OI/funding/liquidation\n" +
              "• /news BTC — berita terbaru\n" +
              "• /fred — data makro FRED\n" +
              "• /xai — tes xAI\n" +
              "• /analyze BTC — analisa AI gabungan\n" +
              "• /status — status API\n" +
              "• /version — versi deploy\n\n" +
              "⚠️ Analisa bersifat probabilistik, bukan jaminan keuntungan."
            );
          } else if (command === "/version") {
            await sendTelegram(env, chatId, `✅ Build aktif: <code>${BUILD_VERSION}</code>`);
          } else if (command === "/finnhub") {
            const result = await getFinnhubStatusText(env);
            await sendTelegram(env, chatId, escapeHtml(result));
          } else if (command === "/macro") {
            await sendTelegram(env, chatId, "⏳ Mengambil kalender makro dari FRED + You.com...");
            const result = await getMacroFallbackText(env);
            await sendTelegram(env, chatId, escapeHtml(result));
          } else if (command === "/binance") {
            const symbol = normalizeSymbol(rawArg || "BTCUSDT");
            const result = await getBinanceTicker(symbol);
            await sendTelegram(env, chatId,
              "✅ <b>BINANCE TERHUBUNG</b>\n\n" +
              `Endpoint: <code>${escapeHtml(result.base)}</code>\n` +
              `Symbol: <b>${escapeHtml(symbol)}</b>\n` +
              `Harga: <b>${formatNumber(Number(result.data.lastPrice))}</b> USDT\n` +
              `24 jam: <b>${formatSigned(Number(result.data.priceChangePercent))}%</b>\n` +
              `Volume: ${formatCompact(Number(result.data.quoteVolume))} USDT`
            );
          } else if (command === "/price") {
            const symbol = normalizeSymbol(rawArg || "BTCUSDT");
            const [mexc, binance] = await Promise.allSettled([
              getMexcTicker(symbol),
              getBinanceTicker(symbol),
            ]);

            const lines = [`📊 <b>${escapeHtml(symbol)}</b>`];
            let mexcPrice = null;
            let binancePrice = null;

            if (mexc.status === "fulfilled") {
              mexcPrice = Number(mexc.value.lastPrice);
              lines.push(
                "",
                "<b>MEXC</b>",
                `Harga: <b>${formatNumber(mexcPrice)}</b> USDT`,
                `24 jam: <b>${formatSigned(Number(mexc.value.priceChangePercent))}%</b>`,
                `Volume: ${formatCompact(Number(mexc.value.quoteVolume))} USDT`
              );
            } else {
              lines.push("", `<b>MEXC:</b> ❌ ${escapeHtml(cleanError(mexc.reason?.message))}`);
            }

            if (binance.status === "fulfilled") {
              binancePrice = Number(binance.value.data.lastPrice);
              lines.push(
                "",
                "<b>BINANCE</b>",
                `Harga: <b>${formatNumber(binancePrice)}</b> USDT`,
                `24 jam: <b>${formatSigned(Number(binance.value.data.priceChangePercent))}%</b>`,
                `Volume: ${formatCompact(Number(binance.value.data.quoteVolume))} USDT`,
                `Endpoint: <code>${escapeHtml(binance.value.base)}</code>`
              );
            } else {
              lines.push(
                "",
                `<b>BINANCE:</b> ❌ ${escapeHtml(cleanError(binance.reason?.message))}`,
                "Binance diblokir WAF dari IP Worker; MEXC tetap digunakan sebagai sumber harga utama."
              );
            }

            if (Number.isFinite(mexcPrice) && Number.isFinite(binancePrice) && binancePrice !== 0) {
              const diff = ((mexcPrice - binancePrice) / binancePrice) * 100;
              lines.push("", `<b>Selisih MEXC vs Binance:</b> ${formatSigned(diff)}%`);
            }

            await sendTelegram(env, chatId, lines.join("\n"));
          }
        } catch (error) {
          await sendTelegram(env, chatId, `❌ ${escapeHtml(cleanError(error?.message))}`).catch(() => {});
        }

        return json({ ok: true });
      }
    }

    return app.fetch(request, env, ctx);
  },
};

async function getMexcTicker(symbol) {
  const response = await fetch(`${MEXC_BASE}/ticker/24hr?symbol=${encodeURIComponent(symbol)}`, {
    headers: { accept: "application/json" },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.msg || `MEXC HTTP ${response.status}`);
  if (!data?.lastPrice) throw new Error("Ticker MEXC tidak ditemukan");
  return data;
}

async function getBinanceTicker(symbol) {
  const errors = [];

  for (const base of BINANCE_BASES) {
    try {
      const response = await fetch(`${base}/ticker/24hr?symbol=${encodeURIComponent(symbol)}`, {
        headers: {
          accept: "application/json",
          "user-agent": "analisa-crypto-bot/1.0",
        },
      });
      const text = await response.text();
      let data = {};
      try { data = JSON.parse(text); } catch {}

      if (!response.ok) {
        errors.push(`${new URL(base).hostname}: HTTP ${response.status}`);
        continue;
      }
      if (!data?.lastPrice) {
        errors.push(`${new URL(base).hostname}: ticker kosong`);
        continue;
      }
      return { data, base: new URL(base).hostname };
    } catch (error) {
      errors.push(`${new URL(base).hostname}: ${cleanError(error?.message)}`);
    }
  }

  throw new Error(`Semua endpoint Binance gagal (${errors.join("; ")})`);
}

async function sendTelegram(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN belum dikonfigurasi");
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: String(text).slice(0, 4090),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
}

function normalizeSymbol(value) {
  return String(value).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 24) || "BTCUSDT";
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (abs >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
  return value.toLocaleString("en-US", { maximumFractionDigits: 10 });
}

function formatSigned(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function formatCompact(value) {
  if (!Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function cleanError(value) {
  return String(value || "Unknown error").slice(0, 800);
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
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
