const FINNHUB_BASE = "https://finnhub.io/api/v1";
const FRED_RELEASE_DATES = "https://api.stlouisfed.org/fred/releases/dates";
const YOU_SEARCH = "https://ydc-index.io/v1/search";
const XAI_RESPONSES = "https://api.x.ai/v1/responses";

export async function getFinnhubStatusText(env) {
  if (!env.FINNHUB_API_KEY) {
    return "❌ FINNHUB_API_KEY belum dikonfigurasi.\n\nBot tetap bisa memakai /macro melalui FRED + You.com.";
  }

  const { from, to } = dateRange(0, 1);
  const url = new URL(`${FINNHUB_BASE}/calendar/economic`);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set("token", env.FINNHUB_API_KEY);

  try {
    const response = await fetch(url.toString(), { headers: { accept: "application/json" } });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || data?.error) {
      const message = String(data?.error || data?.message || `HTTP ${response.status}`);
      if (response.status === 403 || /access|permission|premium|resource/i.test(message)) {
        return [
          "⚠️ FINNHUB ECONOMIC CALENDAR TIDAK TERSEDIA",
          "",
          "API key valid, tetapi endpoint Economic Calendar tidak diizinkan oleh paket Finnhub ini.",
          `Pesan Finnhub: ${message}`,
          "",
          "✅ Tidak menghambat bot.",
          "Perintah /macro memakai FRED + You.com + xAI sebagai fallback.",
        ].join("\n");
      }
      return `❌ Finnhub gagal: ${message}\n\nGunakan /macro; fallback FRED + You.com tetap tersedia.`;
    }

    const events = Array.isArray(data?.economicCalendar) ? data.economicCalendar : Array.isArray(data) ? data : [];
    return [
      "✅ FINNHUB ECONOMIC CALENDAR TERHUBUNG",
      "",
      `Periode: ${from} s/d ${to}`,
      `Jumlah event: ${events.length}`,
      "",
      "Jika endpoint ini gagal, /macro otomatis tetap memakai fallback.",
    ].join("\n");
  } catch (error) {
    return `❌ Finnhub gagal: ${clean(error?.message)}\n\nGunakan /macro; fallback FRED + You.com tetap tersedia.`;
  }
}

export async function getMacroFallbackText(env) {
  const { from, to } = dateRange(0, 3);

  const [fredR, webR] = await Promise.allSettled([
    getFredImportantReleases(env, from, to),
    searchMacroWebMulti(env, from, to),
  ]);

  const fred = fredR.status === "fulfilled" ? fredR.value : [];
  const web = webR.status === "fulfilled" ? webR.value : [];
  const errors = [];

  if (fredR.status === "rejected") errors.push(`FRED sementara gagal: ${clean(fredR.reason?.message)}`);
  if (webR.status === "rejected") errors.push(`You.com gagal: ${clean(webR.reason?.message)}`);

  if (!fred.length && !web.length) {
    return [
      "❌ Tidak berhasil mengambil data makro.",
      ...errors,
      "",
      "Pastikan FRED_API_KEY dan YOU_API_KEY benar di Cloudflare.",
    ].join("\n");
  }

  if (env.XAI_API_KEY) {
    try {
      const ai = await summarizeMacroWithXai(env, { from, to, fred, web, errors });
      if (ai) {
        return [
          "🏦 MACRO AS — FRED + YOU.COM + xAI",
          `Periode: ${from} s/d ${to}`,
          "",
          ai,
          "",
          fred.length ? "✅ FRED tersedia." : "⚠️ FRED sedang gagal; hasil sementara memakai You.com + xAI.",
          "Forecast/actual hanya ditampilkan jika ditemukan pada sumber. Jangan anggap estimasi sebagai kepastian.",
        ].join("\n");
      }
    } catch (error) {
      errors.push(`xAI: ${clean(error?.message)}`);
    }
  }

  const lines = [
    "🏦 MACRO AS — FALLBACK",
    `Periode: ${from} s/d ${to}`,
    "",
  ];

  if (fred.length) {
    lines.push("FRED — rilis penting:");
    fred.slice(0, 10).forEach((item) => lines.push(`• ${item.date} — ${item.name}`));
    lines.push("");
  }

  if (web.length) {
    lines.push("You.com — hasil makro terbaru:");
    web.slice(0, 8).forEach((item) => lines.push(`• ${item.title}`));
    lines.push("");
  }

  if (errors.length) {
    lines.push("Catatan sumber:");
    errors.forEach((e) => lines.push(`• ${e}`));
  }

  return lines.join("\n");
}

async function getFredImportantReleases(env, from, to) {
  if (!env.FRED_API_KEY) throw new Error("FRED_API_KEY belum dikonfigurasi");

  const url = new URL(FRED_RELEASE_DATES);
  url.searchParams.set("api_key", env.FRED_API_KEY);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("realtime_start", from);
  url.searchParams.set("realtime_end", to);
  url.searchParams.set("include_release_dates_with_no_data", "true");
  url.searchParams.set("sort_order", "asc");
  url.searchParams.set("limit", "200");

  const data = await fetchJsonWithRetry(url.toString(), {
    headers: { accept: "application/json" },
  }, 3, "FRED");

  if (data?.error_code) throw new Error(data?.error_message || `FRED error ${data.error_code}`);

  const releases = Array.isArray(data?.release_dates) ? data.release_dates : [];
  const important = /(consumer price|cpi|personal income|personal consumption|pce|employment situation|payroll|unemployment|jobless|federal open market|fomc|interest rate|gross domestic product|gdp|retail sales|producer price|ppi|ism|jolts|consumer confidence|treasury)/i;

  return releases
    .filter((r) => important.test(String(r?.release_name || "")))
    .map((r) => ({
      date: r.date || null,
      name: r.release_name || `Release ${r.release_id || ""}`.trim(),
      release_id: r.release_id || null,
    }))
    .slice(0, 30);
}

async function searchMacroWebMulti(env, from, to) {
  if (!env.YOU_API_KEY) throw new Error("YOU_API_KEY belum dikonfigurasi");

  const queries = [
    `US economic calendar ${from} ${to} CPI PPI retail sales GDP high impact`,
    `US CPI Core CPI release ${from} ${to} actual forecast previous consensus`,
    `US jobs NFP unemployment jobless claims release ${from} ${to} actual forecast previous`,
    `FOMC Federal Reserve Powell interest rate decision schedule ${from} ${to}`,
    `PCE inflation GDP BEA release schedule ${from} ${to} actual forecast previous`,
  ];

  const settled = await Promise.allSettled(queries.map((query) => youSearch(env, query, 6)));
  const all = [];
  const failures = [];

  for (const result of settled) {
    if (result.status === "fulfilled") all.push(...result.value);
    else failures.push(clean(result.reason?.message));
  }

  if (!all.length && failures.length) throw new Error(failures.join(" | "));
  return dedupeItems(all).slice(0, 20);
}

async function youSearch(env, query, count = 6) {
  const response = await fetch(YOU_SEARCH, {
    method: "POST",
    headers: {
      "X-API-Key": env.YOU_API_KEY,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ query, count }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || data?.error || `You.com HTTP ${response.status}`);

  const web = Array.isArray(data?.results?.web) ? data.results.web : [];
  const news = Array.isArray(data?.results?.news) ? data.results.news : [];
  return [...news, ...web].map((item) => ({
    title: String(item?.title || "Untitled"),
    description: extractDescription(item),
    url: item?.url || null,
    page_age: item?.page_age || item?.age || null,
  }));
}

async function fetchJsonWithRetry(url, options, attempts = 3, label = "API") {
  let lastError = null;

  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, options);
      const text = await response.text();
      let data = {};
      try { data = JSON.parse(text); } catch {}

      if (response.ok) return data;

      const message = data?.error_message || data?.message || `${label} HTTP ${response.status}`;
      if (response.status < 500 || i === attempts - 1) throw new Error(message);
      lastError = new Error(message);
    } catch (error) {
      lastError = error;
      if (i === attempts - 1) throw error;
    }

    await sleep(250 * (i + 1));
  }

  throw lastError || new Error(`${label} gagal`);
}

async function summarizeMacroWithXai(env, bundle) {
  const prompt = [
    "Anda menganalisis kalender makro AS untuk trader crypto.",
    "Gunakan HANYA data yang diberikan. Jangan mengarang waktu, actual, forecast, consensus, atau previous.",
    "Jika detail belum tersedia, tulis 'belum ditemukan'.",
    "Prioritaskan CPI/Core CPI, PCE, NFP/payroll, unemployment, FOMC/Fed rate, GDP, PPI, retail sales.",
    "Jika FRED gagal tetapi hasil web tersedia, tetap rangkum hasil web dan sebutkan ketidakpastian sumber.",
    "Jelaskan singkat mengapa event dapat meningkatkan volatilitas BTC, tetapi jangan menjamin arah harga.",
    "Buat output Bahasa Indonesia maksimal 12 baris, tanpa tabel Markdown.",
    "DATA:",
    JSON.stringify(bundle),
  ].join("\n");

  const response = await fetch(XAI_RESPONSES, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.XAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.XAI_MODEL || "grok-4.5",
      input: prompt,
      store: false,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || data?.message || `xAI HTTP ${response.status}`);

  const text = extractXaiText(data);
  return shorten(text, 2800);
}

function extractDescription(item) {
  if (typeof item?.description === "string") return shorten(item.description, 500);
  if (typeof item?.snippet === "string") return shorten(item.snippet, 500);
  if (Array.isArray(item?.snippets)) return shorten(item.snippets.join(" "), 500);
  return "";
}

function extractXaiText(data) {
  if (typeof data?.output_text === "string") return data.output_text.trim();
  const chunks = [];
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    if (item?.type !== "message") continue;
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === "output_text" && typeof content?.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}

function dedupeItems(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = String(item?.url || item?.title || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function dateRange(startOffsetDays, endOffsetDays) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + startOffsetDays));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + endOffsetDays));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clean(value) {
  return String(value || "Unknown error")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
}
