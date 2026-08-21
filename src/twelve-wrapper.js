import commands from "./commands.js";

const TWELVE_BASE = "https://api.twelvedata.com";
const BUILD_VERSION = "2026-08-21-twelvedata-v1";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/twelve-health") {
      if (!env.TWELVEDATA_API_KEY) {
        return json({ ok: false, configured: false, error: "TWELVEDATA_API_KEY belum dikonfigurasi" }, 503);
      }

      try {
        const snapshot = await getTechnicalSnapshot(env, "BTC/USDT");
        return json({
          ok: true,
          configured: true,
          version: BUILD_VERSION,
          symbol: snapshot.symbol,
          interval: snapshot.interval,
          latestClose: snapshot.latestClose,
          rsi14: snapshot.rsi14,
          ema20: snapshot.ema20,
          ema50: snapshot.ema50,
          macd: snapshot.macd,
          signal: snapshot.signal,
          histogram: snapshot.histogram,
          technicalBias: snapshot.technicalBias,
        });
      } catch (error) {
        return json({ ok: false, configured: true, error: cleanError(error?.message) }, 502);
      }
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      const clone = request.clone();
      const update = await clone.json().catch(() => null);
      const message = update?.message;
      const chatId = message?.chat?.id != null ? String(message.chat.id) : null;
      const text = String(message?.text || "").trim();
      const [rawCommand] = text.split(/\s+/);
      const command = String(rawCommand || "").toLowerCase().split("@")[0];

      if (command === "/analyzebtc") {
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

        try {
          const snapshot = await getTechnicalSnapshot(env, "BTC/USDT");
          await sendTelegram(env, chatId, formatTechnicalMessage(snapshot));
        } catch (error) {
          await sendTelegram(
            env,
            chatId,
            `⚠️ <b>Twelve Data sementara tidak tersedia</b>\n${escapeHtml(cleanError(error?.message))}\n\nAnalisa utama tetap dilanjutkan dari sumber lain.`
          ).catch(() => {});
        }

        return commands.fetch(request, env, ctx);
      }
    }

    return commands.fetch(request, env, ctx);
  },
};

async function getTechnicalSnapshot(env, symbol) {
  if (!env.TWELVEDATA_API_KEY) {
    throw new Error("TWELVEDATA_API_KEY belum dikonfigurasi");
  }

  const url = new URL(`${TWELVE_BASE}/time_series`);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "15min");
  url.searchParams.set("outputsize", "120");
  url.searchParams.set("order", "asc");
  url.searchParams.set("timezone", "UTC");

  const response = await fetch(url.toString(), {
    headers: {
      accept: "application/json",
      authorization: `apikey ${env.TWELVEDATA_API_KEY}`,
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.status === "error" || data?.code) {
    throw new Error(data?.message || `Twelve Data HTTP ${response.status}`);
  }

  const values = Array.isArray(data?.values) ? data.values : [];
  if (values.length < 60) {
    throw new Error(`Data candle tidak cukup (${values.length})`);
  }

  const closes = values
    .map((v) => Number(v?.close))
    .filter((v) => Number.isFinite(v));

  if (closes.length < 60) throw new Error("Data close Twelve Data tidak cukup");

  const ema12 = emaSeries(closes, 12);
  const ema20 = emaSeries(closes, 20);
  const ema26 = emaSeries(closes, 26);
  const ema50 = emaSeries(closes, 50);
  const macdSeries = ema12.map((v, i) => v - ema26[i]);
  const signalSeries = emaSeries(macdSeries, 9);

  const latestClose = closes.at(-1);
  const rsi14 = rsi(closes, 14);
  const latestEma20 = ema20.at(-1);
  const latestEma50 = ema50.at(-1);
  const macd = macdSeries.at(-1);
  const signal = signalSeries.at(-1);
  const histogram = macd - signal;

  return {
    symbol,
    interval: "15min",
    latestDatetime: values.at(-1)?.datetime || null,
    latestClose,
    rsi14,
    ema20: latestEma20,
    ema50: latestEma50,
    macd,
    signal,
    histogram,
    technicalBias: technicalBias({ latestClose, rsi14, ema20: latestEma20, ema50: latestEma50, macd, signal }),
  };
}

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const output = [];
  let current = values[0];

  for (const value of values) {
    current = value * k + current * (1 - k);
    output.push(current);
  }
  return output;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function technicalBias({ latestClose, rsi14, ema20, ema50, macd, signal }) {
  let score = 0;
  if (Number.isFinite(latestClose) && Number.isFinite(ema20)) score += latestClose > ema20 ? 1 : -1;
  if (Number.isFinite(ema20) && Number.isFinite(ema50)) score += ema20 > ema50 ? 1 : -1;
  if (Number.isFinite(macd) && Number.isFinite(signal)) score += macd > signal ? 1 : -1;
  if (Number.isFinite(rsi14)) {
    if (rsi14 >= 55 && rsi14 < 70) score += 1;
    if (rsi14 <= 45 && rsi14 > 30) score -= 1;
    if (rsi14 >= 75) score -= 1;
    if (rsi14 <= 25) score += 1;
  }

  if (score >= 3) return "BULLISH";
  if (score <= -3) return "BEARISH";
  return "NEUTRAL";
}

function formatTechnicalMessage(s) {
  const biasIcon = s.technicalBias === "BULLISH" ? "🟢" : s.technicalBias === "BEARISH" ? "🔴" : "⚪";
  const rsiState = !Number.isFinite(s.rsi14)
    ? "-"
    : s.rsi14 >= 70 ? "overbought"
      : s.rsi14 <= 30 ? "oversold"
        : "normal";

  return [
    "📐 <b>TEKNIKAL BTC — TWELVE DATA</b>",
    `Timeframe: <b>${escapeHtml(s.interval)}</b>`,
    `Close: <b>${formatNumber(s.latestClose)}</b> USDT`,
    "",
    `RSI 14: <b>${formatNumber(s.rsi14)}</b> (${rsiState})`,
    `EMA 20: <b>${formatNumber(s.ema20)}</b>`,
    `EMA 50: <b>${formatNumber(s.ema50)}</b>`,
    `MACD: <b>${formatNumber(s.macd)}</b>`,
    `Signal: <b>${formatNumber(s.signal)}</b>`,
    `Histogram: <b>${formatNumber(s.histogram)}</b>`,
    "",
    `${biasIcon} <b>Bias teknikal awal: ${escapeHtml(s.technicalBias)}</b>`,
    "Sumber candle: Twelve Data. Analisa AI utama menyusul.",
  ].join("\n");
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

function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (abs >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function cleanError(value) {
  return String(value || "Unknown error")
    .replace(/apikey\s+[A-Za-z0-9._-]+/gi, "apikey [REDACTED]")
    .slice(0, 500);
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
