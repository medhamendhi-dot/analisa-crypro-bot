const MEXC_BASE = "https://api.mexc.com/api/v3";
const BINANCE_BASE = "https://data-api.binance.vision/api/v3";
const BINANCE_FALLBACK_BASE = "https://api.binance.com/api/v3";
const FINNHUB_BASE = "https://finnhub.io/api/v1";
const COINALYZE_BASE = "https://api.coinalyze.net/v1";

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
        coinalyzeConfigured: Boolean(env.COINALYZE_API_KEY),
        youConfigured: Boolean(env.YOU_API_KEY),
        xaiConfigured: Boolean(env.XAI_API_KEY),
        fredConfigured: Boolean(env.FRED_API_KEY),
      });
    }

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
  if (env.TELEGRAM_CHAT_ID && chatId !== String(env.TELEGRAM_CHAT_ID)) return;

  const text = message.text.trim();
  const [rawCommand, rawArg] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().split("@")[0];

  if (command === "/start") {
    return sendTelegram(env, chatId,
      "🤖 <b>Analisa Crypto Bot</b>\n\n" +
      "Sumber aktif: MEXC, Binance, Finnhub, dan Coinalyze.\n\n" +
      "Perintah:\n" +
      "• /price BTCUSDT — harga MEXC + Binance\n" +
      "• /binance BTCUSDT — tes Binance\n" +
      "• /mexc — tes MEXC private read-only\n" +
      "• /finnhub — tes Finnhub\n" +
      "• /macro — event makro AS\n" +
      "• /coinalyze BTC — tes Coinalyze\n" +
      "• /derivatives BTC — OI, funding, liquidation, long/short\n" +
      "• /status — status semua API\n\n" +
      "⚠️ Data dan analisa bukan jaminan keuntungan."
    );
  }

  if (command === "/status") {
    return sendTelegram(env, chatId, [
      "⚙️ <b>Status API</b>",
      `Telegram Bot: ${yesNo(env.TELEGRAM_BOT_TOKEN)}`,
      `Telegram Chat ID: ${yesNo(env.TELEGRAM_CHAT_ID)}`,
      `MEXC API: ${yesNo(env.MEXC_API_KEY && env.MEXC_API_SECRET)}`,
      "Binance Public API: ✅ tanpa API key",
      `Finnhub: ${yesNo(env.FINNHUB_API_KEY)}`,
      `Coinalyze: ${yesNo(env.COINALYZE_API_KEY)}`,
      `You.com: ${yesNo(env.YOU_API_KEY)}`,
      `xAI: ${yesNo(env.XAI_API_KEY)}`,
      `FRED: ${yesNo(env.FRED_API_KEY)}`,
    ].join("\n"));
  }

  if (command === "/mexc") {
    try {
      const account = await getMexcAccount(env);
      const nonZero = Array.isArray(account.balances)
        ? account.balances.filter((b) => Number(b.free) > 0 || Number(b.locked) > 0).length
        : 0;
      return sendTelegram(env, chatId,
        "✅ <b>MEXC API TERHUBUNG</b>\n\n" +
        `Aset dengan saldo: ${nonZero}\n` +
        "Bot hanya melakukan operasi baca."
      );
    } catch (error) {
      return sendTelegram(env, chatId, `❌ <b>MEXC API gagal</b>\n${escapeHtml(cleanApiError(error.message))}`);
    }
  }

  if (command === "/binance") {
    const symbol = normalizeSymbol(rawArg || "BTCUSDT");
    try {
      const ticker = await getBinanceTicker(symbol);
      return sendTelegram(env, chatId, formatTicker("BINANCE", symbol, ticker));
    } catch (error) {
      return sendTelegram(env, chatId, `❌ <b>Binance API gagal</b>\n${escapeHtml(cleanApiError(error.message))}`);
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
        `Periode: ${from} s/d ${to}\n` +
        `Semua event: ${events.length}\n` +
        `Event AS: ${usEvents.length}\n` +
        `Event penting: ${important.length}`
      );
    } catch (error) {
      return sendTelegram(env, chatId, `❌ <b>Finnhub API gagal</b>\n${escapeHtml(cleanApiError(error.message))}`);
    }
  }

  if (command === "/macro") {
    try {
      const { from, to } = getDateRangeUtc(0, 1);
      const events = (await getFinnhubEconomicCalendar(env, from, to))
        .filter(isUnitedStatesEvent)
        .filter(isImportantMacroEvent)
        .sort(sortEconomicEvents)
        .slice(0, 12);

      if (!events.length) {
        return sendTelegram(env, chatId, `📅 <b>MACRO AS</b>\n\nTidak ada event utama untuk ${from} s/d ${to}.`);
      }

      const lines = ["📅 <b>MACRO AS — EVENT PENTING</b>", `Periode: ${from} s/d ${to}`, ""];
      events.forEach((event, index) => {
        const unit = event.unit ? ` ${event.unit}` : "";
        lines.push(
          `<b>${index + 1}. ${escapeHtml(event.event || "Economic event")}</b>`,
          `Waktu: ${escapeHtml(formatFinnhubTime(event.time))}`,
          `Impact: ${formatImpact(event.impact)}`,
          `Previous: ${formatMacroValue(event.prev, unit)}`,
          `Estimate: ${formatMacroValue(event.estimate, unit)}`,
          `Actual: ${formatMacroValue(event.actual, unit)}`,
          ""
        );
      });
      lines.push("Sumber: Finnhub Economic Calendar.");
      return sendTelegram(env, chatId, lines.join("\n"));
    } catch (error) {
      return sendTelegram(env, chatId, `❌ <b>Gagal membaca kalender makro</b>\n${escapeHtml(cleanApiError(error.message))}`);
    }
  }

  if (command === "/coinalyze") {
    const asset = normalizeAsset(rawArg || "BTC");
    try {
      const market = await getCoinalyzeMarket(env, asset);
      return sendTelegram(env, chatId,
        "✅ <b>COINALYZE API TERHUBUNG</b>\n\n" +
        `Aset: <b>${escapeHtml(asset)}</b>\n` +
        `Market dipilih: <code>${escapeHtml(market.symbol)}</code>\n` +
        `Exchange: ${escapeHtml(market.exchange || "-")}\n` +
        `Pair exchange: ${escapeHtml(market.symbol_on_exchange || "-")}\n` +
        `Perpetual: ${market.is_perpetual ? "ya" : "tidak"}\n\n` +
        "Gunakan /derivatives BTC untuk membaca data futures."
      );
    } catch (error) {
      return sendTelegram(env, chatId, `❌ <b>Coinalyze API gagal</b>\n${escapeHtml(cleanApiError(error.message))}`);
    }
  }

  if (command === "/derivatives") {
    const asset = normalizeAsset(rawArg || "BTC");
    try {
      const market = await getCoinalyzeMarket(env, asset);
      const symbol = market.symbol;
      const now = Math.floor(Date.now() / 1000);
      const from = now - 24 * 60 * 60;

      const [oiR, fundingR, liqR, lsR] = await Promise.allSettled([
        coinalyzeRequest(env, "/open-interest", { symbols: symbol, convert_to_usd: "true" }),
        coinalyzeRequest(env, "/funding-rate", { symbols: symbol }),
        coinalyzeRequest(env, "/liquidation-history", {
          symbols: symbol, interval: "1hour", from: String(from), to: String(now), convert_to_usd: "true",
        }),
        coinalyzeRequest(env, "/long-short-ratio-history", {
          symbols: symbol, interval: "1hour", from: String(from), to: String(now),
        }),
      ]);

      const oi = firstArrayValue(oiR);
      const funding = firstArrayValue(fundingR);
      const liq = firstArrayValue(liqR);
      const longShort = firstArrayValue(lsR);

      const liqHistory = Array.isArray(liq?.history) ? liq.history : [];
      const longLiquidated = liqHistory.reduce((sum, x) => sum + finiteOrZero(x?.l), 0);
      const shortLiquidated = liqHistory.reduce((sum, x) => sum + finiteOrZero(x?.s), 0);

      const lsHistory = Array.isArray(longShort?.history) ? longShort.history : [];
      const latestLs = lsHistory.length ? lsHistory[lsHistory.length - 1] : null;

      const lines = [
        `📈 <b>DERIVATIVES ${escapeHtml(asset)}</b>`,
        `Market: <code>${escapeHtml(symbol)}</code>`,
        "",
        `<b>Open Interest:</b> ${oi ? `${formatMoney(Number(oi.value))}` : "tidak tersedia"}`,
        `<b>Funding Rate:</b> ${funding ? `${formatFunding(Number(funding.value))}` : "tidak tersedia"}`,
        "",
        "<b>Liquidation 24 jam</b>",
        `Long liquidated: ${liqHistory.length ? formatMoney(longLiquidated) : "tidak tersedia"}`,
        `Short liquidated: ${liqHistory.length ? formatMoney(shortLiquidated) : "tidak tersedia"}`,
      ];

      if (latestLs) {
        lines.push(
          "",
          "<b>Long / Short terbaru</b>",
          `Ratio: ${formatNumber(Number(latestLs.r))}`,
          `Long: ${formatPercentLike(latestLs.l)}`,
          `Short: ${formatPercentLike(latestLs.s)}`
        );
      } else {
        lines.push("", "<b>Long / Short:</b> tidak tersedia untuk market ini");
      }

      const bias = derivativesBias({ funding: funding?.value, longLiquidated, shortLiquidated, latestLs });
      lines.push("", `<b>Bias data awal:</b> ${bias}`, "Sumber derivatives: Coinalyze.");
      return sendTelegram(env, chatId, lines.join("\n"));
    } catch (error) {
      return sendTelegram(env, chatId, `❌ <b>Gagal membaca derivatives</b>\n${escapeHtml(cleanApiError(error.message))}`);
    }
  }

  if (command === "/price") {
    const symbol = normalizeSymbol(rawArg || "BTCUSDT");
    const [mexcResult, binanceResult] = await Promise.allSettled([
      getMexcTicker(symbol),
      getBinanceTicker(symbol),
    ]);

    if (mexcResult.status === "rejected" && binanceResult.status === "rejected") {
      return sendTelegram(env, chatId,
        `❌ Gagal mengambil ${escapeHtml(symbol)} dari MEXC dan Binance.`
      );
    }

    const lines = [`📊 <b>${escapeHtml(symbol)}</b>`];
    let mexcPrice = null;
    let binancePrice = null;

    if (mexcResult.status === "fulfilled") {
      const ticker = mexcResult.value;
      mexcPrice = Number(ticker.lastPrice);
      lines.push("", "<b>MEXC</b>", ...tickerLines(ticker));
    } else {
      lines.push("", `<b>MEXC</b>: ❌ ${escapeHtml(cleanApiError(mexcResult.reason?.message))}`);
    }

    if (binanceResult.status === "fulfilled") {
      const ticker = binanceResult.value;
      binancePrice = Number(ticker.lastPrice);
      lines.push("", "<b>BINANCE</b>", ...tickerLines(ticker));
    } else {
      lines.push("", `<b>BINANCE</b>: ❌ ${escapeHtml(cleanApiError(binanceResult.reason?.message))}`);
    }

    if (Number.isFinite(mexcPrice) && Number.isFinite(binancePrice) && binancePrice !== 0) {
      const difference = mexcPrice - binancePrice;
      const differencePct = (difference / binancePrice) * 100;
      lines.push("", `<b>Selisih:</b> ${formatSigned(differencePct)}% (${difference > 0 ? "+" : ""}${formatNumber(difference)} USDT)`);
    }

    lines.push("", "Sumber: MEXC + Binance public market data");
    return sendTelegram(env, chatId, lines.join("\n"));
  }

  return sendTelegram(env, chatId,
    "Perintah belum dikenal. Gunakan /start untuk melihat menu."
  );
}

async function setupTelegramWebhook(env, origin) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN belum dikonfigurasi");
  const payload = {
    url: `${origin}/telegram`,
    allowed_updates: ["message"],
    drop_pending_updates: false,
  };
  if (env.TELEGRAM_WEBHOOK_SECRET) payload.secret_token = env.TELEGRAM_WEBHOOK_SECRET;

  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram HTTP ${response.status}`);
  return { ok: true, description: data.description || "Webhook set" };
}

async function getMexcTicker(symbol) {
  const response = await fetch(`${MEXC_BASE}/ticker/24hr?symbol=${encodeURIComponent(symbol)}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`MEXC HTTP ${response.status}`);
  const data = await response.json();
  if (!data?.lastPrice) throw new Error("Ticker MEXC tidak ditemukan");
  return data;
}

async function getBinanceTicker(symbol) {
  let lastError;
  for (const base of [BINANCE_BASE, BINANCE_FALLBACK_BASE]) {
    try {
      const response = await fetch(`${base}/ticker/24hr?symbol=${encodeURIComponent(symbol)}`, {
        headers: { accept: "application/json" },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.msg || `Binance HTTP ${response.status}`);
      if (!data?.lastPrice) throw new Error("Ticker Binance tidak ditemukan");
      return data;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Binance API tidak tersedia");
}

async function getFinnhubEconomicCalendar(env, from, to) {
  if (!env.FINNHUB_API_KEY) throw new Error("FINNHUB_API_KEY belum dikonfigurasi");
  const url = new URL(`${FINNHUB_BASE}/calendar/economic`);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set("token", env.FINNHUB_API_KEY);

  const response = await fetch(url.toString(), { headers: { accept: "application/json" } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error) throw new Error(data?.error || data?.message || `Finnhub HTTP ${response.status}`);
  return Array.isArray(data?.economicCalendar) ? data.economicCalendar : Array.isArray(data) ? data : [];
}

async function coinalyzeRequest(env, path, params = {}) {
  if (!env.COINALYZE_API_KEY) throw new Error("COINALYZE_API_KEY belum dikonfigurasi");
  const url = new URL(`${COINALYZE_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetch(url.toString(), {
    headers: {
      accept: "application/json",
      api_key: env.COINALYZE_API_KEY,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.message || data?.error || `Coinalyze HTTP ${response.status}`;
    throw new Error(detail);
  }
  return data;
}

async function getCoinalyzeMarket(env, asset) {
  const markets = await coinalyzeRequest(env, "/future-markets");
  if (!Array.isArray(markets)) throw new Error("Daftar futures Coinalyze tidak valid");

  const candidates = markets
    .filter((m) => String(m.base_asset || "").toUpperCase() === asset)
    .filter((m) => String(m.quote_asset || "").toUpperCase() === "USDT")
    .filter((m) => m.is_perpetual === true)
    .map((m) => ({
      market: m,
      score:
        (/binance/i.test(String(m.exchange || "")) ? 20 : 0) +
        (String(m.symbol || "").endsWith(".A") ? 15 : 0) +
        (/USDT/i.test(String(m.symbol_on_exchange || "")) ? 5 : 0) +
        (m.has_long_short_ratio_data ? 2 : 0) +
        (String(m.margined || "").toUpperCase() === "STABLE" ? 1 : 0),
    }))
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) throw new Error(`Futures perpetual ${asset}/USDT tidak ditemukan di Coinalyze`);
  return candidates[0].market;
}

async function getMexcAccount(env) {
  if (!env.MEXC_API_KEY || !env.MEXC_API_SECRET) {
    throw new Error("MEXC_API_KEY atau MEXC_API_SECRET belum dikonfigurasi");
  }
  const query = `timestamp=${Date.now()}&recvWindow=5000`;
  const signature = await hmacSha256Hex(env.MEXC_API_SECRET, query);
  const response = await fetch(`${MEXC_BASE}/account?${query}&signature=${signature}`, {
    headers: { "X-MEXC-APIKEY": env.MEXC_API_KEY, accept: "application/json" },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.code < 0) throw new Error(data?.msg || `MEXC HTTP ${response.status}`);
  return data;
}

async function hmacSha256Hex(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sendTelegram(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN belum dikonfigurasi");
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
}

function firstArrayValue(result) {
  if (result.status !== "fulfilled") return null;
  return Array.isArray(result.value) && result.value.length ? result.value[0] : null;
}

function derivativesBias({ funding, longLiquidated, shortLiquidated, latestLs }) {
  let score = 0;
  const fr = Number(funding);
  if (Number.isFinite(fr)) {
    if (fr > 0.03) score -= 1;
    if (fr < -0.03) score += 1;
  }
  if (shortLiquidated > longLiquidated * 1.5) score += 1;
  if (longLiquidated > shortLiquidated * 1.5) score -= 1;
  const longPct = Number(latestLs?.l);
  if (Number.isFinite(longPct)) {
    if (longPct > 60) score -= 1;
    if (longPct < 40) score += 1;
  }
  if (score >= 2) return "🟢 cenderung bullish";
  if (score <= -2) return "🔴 cenderung bearish";
  return "⚪ netral / belum kuat";
}

function formatTicker(name, symbol, ticker) {
  return `✅ <b>${name} API TERHUBUNG</b>\n\n📊 <b>${escapeHtml(symbol)}</b>\n${tickerLines(ticker).join("\n")}`;
}

function tickerLines(ticker) {
  const price = Number(ticker.lastPrice);
  const change = Number(ticker.priceChangePercent);
  const volume = Number(ticker.quoteVolume);
  const arrow = change > 0 ? "🟢" : change < 0 ? "🔴" : "⚪";
  return [
    `Harga: <b>${formatNumber(price)}</b> USDT`,
    `${arrow} 24 jam: <b>${formatSigned(change)}%</b>`,
    `Volume: ${formatCompact(volume)} USDT`,
  ];
}

function isUnitedStatesEvent(event) {
  const country = String(event?.country || "").trim().toUpperCase();
  return country === "US" || country === "USA" || country === "UNITED STATES";
}

function isImportantMacroEvent(event) {
  const name = String(event?.event || "").toLowerCase();
  const importantName = /(cpi|consumer price|core inflation|inflation|pce|personal consumption|nonfarm|non-farm|payroll|employment change|unemployment|jobless|fomc|fed funds|federal reserve|interest rate|rate decision|powell|gdp|retail sales|ppi|producer price|ism|jolts|consumer confidence)/i.test(name);
  return importantName || normalizeImpact(event?.impact) >= 3;
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
    const date = new Date(value > 1e12 ? value : value * 1000);
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
  return { from: fromDate.toISOString().slice(0, 10), to: toDate.toISOString().slice(0, 10) };
}

function normalizeSymbol(input) {
  return String(input).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 24);
}

function normalizeAsset(input) {
  return String(input).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || "BTC";
}

function yesNo(value) {
  return value ? "✅ siap" : "❌ belum";
}

function finiteOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatMoney(value) {
  if (!Number.isFinite(value)) return "-";
  return `$${formatCompact(value)}`;
}

function formatFunding(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value > 0 ? "+" : ""}${value.toFixed(5)}%`;
}

function formatPercentLike(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n.toFixed(2)}%`;
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

function cleanApiError(message) {
  return String(message || "Unknown error").slice(0, 500);
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
