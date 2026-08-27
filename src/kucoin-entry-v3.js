import app from "./kucoin-message-one-tap-v3.js";

const BUILD_VERSION = "2026-08-27-kucoin-entry-v5-reply-keyboard";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/setup-webhook") {
      try {
        const result = await ensureTradingWebhook(env, url.origin);
        return json({ ok: true, version: BUILD_VERSION, ...result });
      } catch (error) {
        return json({ ok: false, version: BUILD_VERSION, error: formatError(error) }, 500);
      }
    }

    if (request.method === "GET" && url.pathname === "/telegram-webhook-status") {
      try {
        const info = await telegram(env, "getWebhookInfo", {});
        return json({ ok: true, version: BUILD_VERSION, webhook: formatWebhookInfo(info) });
      } catch (error) {
        return json({ ok: false, version: BUILD_VERSION, error: formatError(error) }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      try {
        const clone = request.clone();
        const update = await clone.json().catch(() => null);
        const text = String(update?.message?.text || "").trim();
        const command = text.split(/\s+/)[0]?.toLowerCase().split("@")[0] || "";
        const tradingCommands = new Set(["/kucointrade", "/kucoincycle", "/kucoinproxy", "/kucoin"]);
        if (tradingCommands.has(command)) await ensureTradingWebhook(env, url.origin);
      } catch (error) {
        console.error("Webhook auto-repair failed", formatError(error));
      }
    }

    return app.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return app.scheduled(event, env, ctx);
  },
};

async function ensureTradingWebhook(env, origin) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN belum ada di Cloudflare");
  const payload = {
    url: `${origin}/telegram`,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  };
  if (env.TELEGRAM_WEBHOOK_SECRET) payload.secret_token = env.TELEGRAM_WEBHOOK_SECRET;
  const response = await telegram(env, "setWebhook", payload);
  const info = await telegram(env, "getWebhookInfo", {});
  return { setWebhook: response, webhook: formatWebhookInfo(info) };
}

function formatWebhookInfo(info) {
  return {
    url: info?.url || "",
    pendingUpdateCount: info?.pending_update_count || 0,
    lastErrorDate: info?.last_error_date || null,
    lastErrorMessage: info?.last_error_message || null,
    allowedUpdates: info?.allowed_updates || null,
  };
}

async function telegram(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN belum ada di Cloudflare");
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok || data?.ok === false) throw new Error(data?.description || `Telegram HTTP ${response.status}: ${text.slice(0, 300)}`);
  return data.result;
}

function formatError(value) {
  if (value instanceof Error) return value.message || String(value);
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
