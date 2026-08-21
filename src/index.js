const MEXC_BASE = "https://api.mexc.com/api/v3";
const BINANCE_BASE = "https://data-api.binance.vision/api/v3";
const BINANCE_FALLBACK_BASE = "https://api.binance.com/api/v3";
const FINNHUB_BASE = "https://finnhub.io/api/v1";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({
        ok: true,
        service: "analisa-crypto-bot",
        runtime: "cloudflare-workers",
        telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
        mexcConfigured: Boolean(env.MEXC_API_KEY && env.MEXC_API_SECRET),
        binancePublicApi: true,
        finnhubConfigured: Boolean(env.FINNHUB_API_KEY),
        youConfigured: Boolean(env.YOU_API_KEY),
        xaiConfigured: Boolean(env.XAI_API_KEY),
        newsConfigured: Boolean(env.NEWS_API_KEY),
      });
    }

    // One-time helper: open https://YOUR-WORKER/setup-webhook after deploy.
    if (request.method === "GET" && url.pathname === "/setup-webhook") {
      try {
        const result = await setupTelegramWebhook(env, url.origin);
        return json({ ok: true, webhook: `${url.origin}/telegram`, telegram: result });
      } catch (error) {
        return json({ ok: false, error: error.message }, 500);
      }
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

  const chatId = String(message.chat.id);

  // If TELEGRAM_CHAT_ID is configured, only that chat can control the bot.
  if (env.TELEGRAM_CHAT_ID && chatId !== String(env.TELEGRAM_CHAT_ID)) {
    return;
  }

  const text = message.text.trim();
  const [rawCommand, rawSymbol] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().split("@")[0];

  if (command === "/start") {
    return sendTelegram(env, chatId,
      "🤖 <b>Analisa Crypto Bot</b>\n\n" +
      "Telegram, MEXC, Binance, dan Finnhub sudah didukung melalui Cloudflare Worker.\n\n" +
      "Perintah:\n" +
      "• /price BTCUSDT — bandingkan harga MEXC + Binance\n" +
      "• /mexc — tes koneksi API privat MEXC\n" +
      "• /binance BTCUSDT — tes Binance public API\n" +
      "• /finnhub — tes Finnhub Economic Calendar\n" +
      "• /macro — event makro AS penting hari ini + besok\n" +
      "• /status — status konfigurasi API\n\n" +
      "⚠️ Analisa bukan jaminan keuntungan dan bukan nasihat keuangan."
    );
  }

  if (command === "/status") {
    const lines = [
      "⚙️ <b>Status API</b>",
      `Telegram Bot: ${yesNo(env.TELEGRAM_BOT_TOKEN)}`,
      `Telegram Chat ID: ${yesNo(env.TELEGRAM_CHAT_ID)}`,
      `MEXC API: ${yesNo(env.MEXC_API_KEY && env.MEXC_API_SECRET)}`,
      "Binance Public API: ✅ tanpa API key",
      `Finnhub: ${yesNo(env.FINNHUB_API_KEY)}`,
      `You.com: ${yesNo(env.YOU_API_KEY)}`,
      `xAI: ${yesNo(env.XAI_API_KEY)}`,
      `News API: ${yesNo(env.NEWS_API_KEY)}`,
      `CoinGlass: ${yesNo(env.COINGLASS_API_KEY)}`,
      `FRED: ${yesNo(env.FRED_API_KEY)}`,
      "",
      "MEXC dan Binance public market data dapat digunakan tanpa API key.",
    ];
    return sendTelegram(env, chatId, lines.join("\n"));
  }

  if (command === "/mexc") {
    try {
      const account = await getMexcAccount(env);
      const nonZero = Array.isArray(account.balances)
        ? account.balances.filter((b) => Number(b.free) > 0 || Number(b.locked) > 0).length
        : 0;

      return sendTelegram(env, chatId,
        "✅ <b>MEXC API TERHUBUNG</b>\n\n" +
        `Status trading API: ${account.canTrade ? "aktif pada key" : "tidak aktif / read-only"}\n` +
        `Aset dengan saldo: ${nonZero}\n\n` +
        "Bot hanya melakukan tes baca akun. Kode ini tidak memasang order, withdraw, atau transfer."
      );
    } catch (error) {
      return sendTelegram(env, chatId,
        `❌ <b>MEXC API gagal</b>\n${escapeHtml(cleanApiError(error.message))}`
      );
    }
  }

  if (command === "/binance") {
    const symbol = normalizeSymbol(rawSymbol || "BTCUSDT");
    try {
      const ticker = await getBinanceTicker(symbol);
      const price = Number(ticker.lastPrice);
      const change = Number(ticker.priceChangePercent);
      const volume = Number(ticker.quoteVolume);
      const arrow = change > 0 ? "🟢" : change < 0 ? "🔴" : "⚪";

      return sendTelegram(env, chatId,
        "✅ <b>BINANCE PUBLIC API TERHUBUNG</b>\n\n" +
        `📊 <b>${escapeHtml(symbol)}</b>\n` +
        `Harga: <b>${formatNumber(price)}</b> USDT\n` +
        `${arrow} 24 jam: <b>${formatSigned(change)}%</b>\n` +
        `Volume quote 24j: ${formatCompact(volume)} USDT\n\n` +
        "Tidak memakai Binance API key."
      );
    } catch (error) {
      return sendTelegram(env, chatId,
        `❌ <b>Binance API gagal</b>\n${escapeHtml(cleanApiError(error.message))}`
      );
    }
  }

  if (command === "/finnhub") {
    try {
      const { from, to } = getDateRangeUtc(0, 1);
      const events = await getFinnhubEconomicCalendar(env, from, to);
      const usEvents = events.filter(isUnitedStatesEvent);
      const important = usEvents.filter(isImportantMacroEvent);

      return sendTelegram(env, chatId,
        "✅ <b>FINNHUB API TERHUBUNG</b>\n\n" +
        `Periode tes: ${from} s/d ${to}\n` +
        `Semua event: ${events.length}\n` +
        `Event AS: ${usEvents.length}\n` +
        `Event AS penting: ${important.length}\n\n` +
        "Gunakan /macro untuk melihat CPI, FOMC/Fed, NFP/jobs, PCE, GDP, retail sales dan event penting lain."
      );
    } catch (error) {
      return sendTelegram(env, chatId,
        `❌ <b>Finnhub API gagal</b>\n${escapeHtml(cleanApiError(error.message))}`
      );
    }
  }

  if (command === "/macro") {
    try {
      const { from, to } = getDateRangeUtc(0, 1);
      const events = await getFinnhubEconomicCalendar(env, from, to);
      const important = events
        .filter(isUnitedStatesEvent)
        .filter(isImportantMacroEvent)
        .sort(sortEconomicEvents)
        .slice(0, 12);

      if (important.length === 0) {
        return sendTelegram(env, chatId,
          `📅 <b>MACRO AS</b>\n\nTidak ada event utama yang terdeteksi untuk ${from} s/d ${to}.\n\nSumber: Finnhub Economic Calendar.`
        );
      }

      const lines = [
        "📅 <b>MACRO AS — EVENT PENTING</b>",
        `Periode: ${from} s/d ${to}`,
        "",
      ];

      important.forEach((event, index) => {
        const impact = formatImpact(event.impact);
        const unit = event.unit ? ` ${event.unit}` : "";
        lines.push(
          `<b>${index + 1}. ${escapeHtml(event.event || "Economic event")}</b>`,
          `Waktu: ${escapeHtml(formatFinnhubTime(event.time))}`,
          `Impact: ${impact}`,
          `Previous: ${formatMacroValue(event.prev, unit)}`,
          `Estimate: ${formatMacroValue(event.estimate, unit)}`,
          `Actual: ${formatMacroValue(event.actual, unit)}`,
          ""
        );
      });

      lines.push(
        "Sumber: Finnhub Economic Calendar.",
        "Bot belum memberi prediksi bullish/bearish dari data ini sampai mesin AI dihubungkan."
      );

      return sendTelegram(env, chatId, lines.join("\n"));
    } catch (error) {
      return sendTelegram(env, chatId,
        `❌ <b>Gagal membaca kalender makro</b>\n${escapeHtml(cleanApiError(error.message))}`
      );
    }
  }

  if (command === "/price") {
    const symbol = normalizeSymbol(rawSymbol || "BTCUSDT");

    const [mexcResult, binanceResult] = await Promise.allSettled([
      getMexcTicker(symbol),
      getBinanceTicker(symbol),
    ]);

    if (mexcResult.status === "rejected" && binanceResult.status === "rejected") {
      return sendTelegram(env, chatId,
        `❌ Gagal mengambil ${escapeHtml(symbol)} dari MEXC dan Binance.\n` +
        `MEXC: ${escapeHtml(cleanApiError(mexcResult.reason?.message))}\n` +
        `Binance: ${escapeHtml(cleanApiError(binanceResult.reason?.message))}`
      );
    }

    const lines = [`📊 <b>${escapeHtml(symbol)}</b>`];
    let mexcPrice = null;
    let binancePrice = null;

    if (mexcResult.status === "fulfilled") {
      const ticker = mexcResult.value;
      mexcPrice = Number(ticker.lastPrice);
      const change = Number(ticker.priceChangePercent);
      const volume = Number(ticker.quoteVolume);
      const arrow = change > 0 ? "🟢" : change < 0 ? "🔴" : "⚪";
      lines.push(
        "",
        "<b>MEXC</b>",
        `Harga: <b>${formatNumber(mexcPrice)}</b> USDT`,
        `${arrow} 24 jam: <b>${formatSigned(change)}%</b>`,
        `Volume: ${formatCompact(volume)} USDT`
      );
    } else {
      lines.push("", `<b>MEXC</b>: ❌ ${escapeHtml(cleanApiError(mexcResult.reason?.message))}`);
    }

    if (binanceResult.status === "fulfilled") {
      const ticker = binanceResult.value;
      binancePrice = Number(ticker.lastPrice);
      const change = Number(ticker.priceChangePercent);
      const volume = Number(ticker.quoteVolume);
      const arrow = change > 0 ? "🟢" : change < 0 ? "🔴" : "⚪";
      lines.push(
        "",
        "<b>BINANCE</b>",
        `Harga: <b>${formatNumber(binancePrice)}</b> USDT`,
        `${arrow} 24 jam: <b>${formatSigned(change)}%</b>`,
        `Volume: ${formatCompact(volume)} USDT`
      );
    } else {
      lines.push("", `<b>BINANCE</b>: ❌ ${escapeHtml(cleanApiError(binanceResult.reason?.message))}`);
    }

    if (Number.isFinite(mexcPrice) && Number.isFinite(binancePrice) && binancePrice !== 0) {
      const difference = mexcPrice - binancePrice;
      const differencePct = (difference / binancePrice) * 100;
      lines.push(
        "",
        `<b>Selisih MEXC vs Binance:</b> ${formatSigned(differencePct)}%`,
        `Selisih harga: ${difference > 0 ? "+" : ""}${formatNumber(difference)} USDT`
      );
    }

    lines.push("", "Sumber: MEXC + Binance public market data");
    return sendTelegram(env, chatId, lines.join("\n"));
  }

  return sendTelegram(env, chatId,
    "Perintah belum dikenal. Gunakan /start, /price BTCUSDT, /mexc, /binance BTCUSDT, /finnhub, /macro, atau /status."
  );
}

async function setupTelegramWebhook(env, origin) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN belum dikonfigurasi");

  const payload = {
    url: `${origin}/telegram`,
    allowed_updates: ["message"],
    drop_pending_updates: false,
  };

  if (env.TELEGRAM_WEBHOOK_SECRET) {
    payload.secret_token = env.TELEGRAM_WEBHOOK_SECRET;
  }

  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram HTTP ${response.status}`);
  }
  return { ok: true, description: data.description || "Webhook set" };
}

async function getMexcTicker(symbol) {
  const response = await fetch(`${MEXC_BASE}/ticker/24hr?symbol=${encodeURIComponent(symbol)}`, {
    headers: { accept: "application/json" },
  });

  if (!response.ok) throw new Error(`MEXC HTTP ${response.status}`);

  const data = await response.json();
  if (!data?.lastPrice) throw new Error("Ticker tidak ditemukan");
  return data;
}

async function getBinanceTicker(symbol) {
  const bases = [BINANCE_BASE, BINANCE_FALLBACK_BASE];
  let lastError = null;

  for (const base of bases) {
    try {
      const response = await fetch(`${base}/ticker/24hr?symbol=${encodeURIComponent(symbol)}`, {
        headers: { accept: "application/json" },
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.msg || `Binance HTTP ${response.status}`);
      }
      if (!data?.lastPrice) throw new Error("Ticker Binance tidak ditemukan");
      return data;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Binance public API tidak tersedia");
}

async function getFinnhubEconomicCalendar(env, from, to) {
  if (!env.FINNHUB_API_KEY) {
    throw new Error("FINNHUB_API_KEY belum dikonfigurasi");
  }

  const url = new URL(`${FINNHUB_BASE}/calendar/economic`);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set("token", env.FINNHUB_API_KEY);

  const response = await fetch(url.toString(), {
    headers: { accept: "application/json" },
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data?.error || data?.message || `Finnhub HTTP ${response.status}`);
  }

  if (data?.error) {
    throw new Error(data.error);
  }

  const events = Array.isArray(data?.economicCalendar)
    ? data.economicCalendar
    : Array.isArray(data)
      ? data
      : [];

  if (!Array.isArray(events)) {
    throw new Error("Format economic calendar Finnhub tidak dikenali");
  }

  return events;
}

async function getMexcAccount(env) {
  if (!env.MEXC_API_KEY || !env.MEXC_API_SECRET) {
    throw new Error("MEXC_API_KEY atau MEXC_API_SECRET belum dikonfigurasi");
  }

  const query = `timestamp=${Date.now()}&recvWindow=5000`;
  const signature = await hmacSha256Hex(env.MEXC_API_SECRET, query);
  const response = await fetch(`${MEXC_BASE}/account?${query}&signature=${signature}`, {
    headers: {
      "X-MEXC-APIKEY": env.MEXC_API_KEY,
      accept: "application/json",
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.code < 0) {
    throw new Error(data?.msg || `MEXC HTTP ${response.status}`);
  }
  return data;
}

async function hmacSha256Hex(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

function isUnitedStatesEvent(event) {
  const country = String(event?.country || "").trim().toUpperCase();
  return country === "US" || country === "USA" || country === "UNITED STATES";
}

function isImportantMacroEvent(event) {
  const name = String(event?.event || "").toLowerCase();
  const importantName = /(cpi|consumer price|core inflation|inflation|pce|personal consumption|nonfarm|non-farm|payroll|employment change|unemployment|jobless|fomc|fed funds|federal reserve|interest rate|rate decision|powell|gdp|retail sales|ppi|producer price|ism|jolts|consumer confidence)/i.test(name);
  const impact = normalizeImpact(event?.impact);
  return importantName || impact >= 3;
}

function normalizeImpact(value) {
  if (typeof value === "number") return value;
  const text = String(value || "").toLowerCase();
  if (text.includes("high")) return 3;
  if (text.includes("medium")) return 2;
  if (text.includes("low")) return 1;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatImpact(value) {
  const impact = normalizeImpact(value);
  if (impact >= 3) return "🔴 HIGH";
  if (impact >= 2) return "🟠 MEDIUM";
  if (impact >= 1) return "🟡 LOW";
  return "⚪ -";
}

function sortEconomicEvents(a, b) {
  return getEventTimestamp(a?.time) - getEventTimestamp(b?.time);
}

function getEventTimestamp(value) {
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  const raw = String(value || "").trim();
  if (!raw) return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z");
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function formatFinnhubTime(value) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number") {
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return `${date.toISOString().replace("T", " ").slice(0, 16)} UTC`;
  }
  return String(value);
}

function formatMacroValue(value, unit = "") {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number") return `${formatNumber(value)}${unit}`;
  const text = String(value).trim();
  return text ? `${escapeHtml(text)}${unit}` : "-";
}

function getDateRangeUtc(startOffsetDays = 0, endOffsetDays = 1) {
  const now = new Date();
  const fromDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + startOffsetDays));
  const toDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + endOffsetDays));
  return {
    from: fromDate.toISOString().slice(0, 10),
    to: toDate.toISOString().slice(0, 10),
  };
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
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function cleanApiError(message) {
  return String(message || "Unknown error").slice(0, 500);
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
