import monitor from "./auto-monitor.js";

const BUILD_VERSION = "2026-08-27-kucoin-paper-cycle-v1";
const SYMBOL = "BTC-USDT";
const KUCOIN_TICKER = "https://api.kucoin.com/api/v1/market/orderbook/level1";
const STATE_URL = "https://paper.local/kucoin-btc-usdt";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/paper-health") {
      const state = await getState();
      return json({
        ok: true,
        version: BUILD_VERSION,
        mode: "paper-only",
        liveOrders: false,
        symbol: SYMBOL,
        schedule: "every 5 minutes",
        cycle: "BUY paper -> 5 minutes later SELL paper -> repeat",
        budgetUsdt: getBudget(env),
        state,
      });
    }

    return monitor.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    try {
      monitor.scheduled(event, env, ctx);
    } catch (error) {
      console.error("auto-monitor scheduled setup gagal", clean(error?.message));
    }

    ctx.waitUntil(runPaperCycle(event, env).catch(async (error) => {
      console.error("KuCoin paper cycle gagal", clean(error?.message));
      await notify(env,
        "⚠️ <b>KUCOIN PAPER CYCLE ERROR</b>\n" +
        escapeHtml(clean(error?.message || error))
      ).catch(() => {});
    }));
  },
};

async function runPaperCycle(event, env) {
  const price = await getKucoinPrice();
  const state = await getState();
  const now = new Date(event?.scheduledTime || Date.now()).toISOString();
  const budgetUsdt = getBudget(env);

  if (!state?.position) {
    const quantityBtc = budgetUsdt / price;
    const next = {
      position: "LONG",
      entryPrice: price,
      quantityBtc,
      budgetUsdt,
      openedAt: now,
      mode: "paper-only",
    };
    await setState(next);

    await notify(env, [
      "🟢 <b>PAPER BUY BTC/USDT</b>",
      "Mode: simulasi, tidak mengirim order ke KuCoin",
      `Harga: <b>${format(price)}</b> USDT`,
      `Modal simulasi: <b>${format(budgetUsdt)}</b> USDT`,
      `BTC simulasi: <b>${format(quantityBtc, 8)}</b>`,
      "Rencana: 5 menit berikutnya PAPER SELL.",
    ].join("\n"));
    return;
  }

  const entry = Number(state.entryPrice);
  const quantity = Number(state.quantityBtc);
  const exitValue = quantity * price;
  const pnlUsdt = exitValue - Number(state.budgetUsdt || budgetUsdt);
  const pnlPct = entry > 0 ? ((price - entry) / entry) * 100 : 0;

  await clearState();

  await notify(env, [
    "🔴 <b>PAPER SELL BTC/USDT</b>",
    "Mode: simulasi, tidak mengirim order ke KuCoin",
    `Entry: <b>${format(entry)}</b> USDT`,
    `Exit: <b>${format(price)}</b> USDT`,
    `PnL simulasi: <b>${signed(pnlUsdt)} USDT (${signed(pnlPct)}%)</b>`,
    "Rencana: 5 menit berikutnya PAPER BUY lagi.",
  ].join("\n"));
}

async function getKucoinPrice() {
  const url = new URL(KUCOIN_TICKER);
  url.searchParams.set("symbol", SYMBOL);

  const response = await fetch(url.toString(), {
    headers: { accept: "application/json" },
  });
  const payload = await response.json().catch(() => ({}));
  const price = Number(payload?.data?.price);

  if (!response.ok || payload?.code !== "200000" || !Number.isFinite(price) || price <= 0) {
    throw new Error(payload?.msg || payload?.message || `KuCoin ticker HTTP ${response.status}`);
  }
  return price;
}

function getBudget(env) {
  const value = Number(env.KUCOIN_PAPER_USDT || 0.985);
  if (!Number.isFinite(value) || value <= 0) return 0.985;
  return Math.min(value, 1000000);
}

async function getState() {
  const response = await caches.default.match(new Request(STATE_URL));
  if (!response) return null;
  return response.json().catch(() => null);
}

async function setState(state) {
  const response = new Response(JSON.stringify(state), {
    headers: {
      "content-type": "application/json",
      "cache-control": "max-age=86400",
    },
  });
  await caches.default.put(new Request(STATE_URL), response);
}

async function clearState() {
  await caches.default.delete(new Request(STATE_URL));
}

async function notify(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: String(env.TELEGRAM_CHAT_ID),
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
}

function format(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString("en-US", { maximumFractionDigits: decimals });
}

function signed(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n >= 0 ? "+" : ""}${n.toFixed(4)}`;
}

function clean(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 500)
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
