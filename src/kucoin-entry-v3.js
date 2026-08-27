import app from "./kucoin-vercel-one-tap-v2.js";

const BUILD_VERSION = "2026-08-27-kucoin-entry-v3";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/setup-webhook") {
      try {
        if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN belum ada di Cloudflare");
        const webhookUrl = `${url.origin}/telegram`;
        const payload = {
          url: webhookUrl,
          allowed_updates: ["message", "callback_query"],
          drop_pending_updates: false,
        };
        if (env.TELEGRAM_WEBHOOK_SECRET) payload.secret_token = env.TELEGRAM_WEBHOOK_SECRET;

        const response = await telegram(env, "setWebhook", payload);
        const info = await telegram(env, "getWebhookInfo", {});
        return json({
          ok: true,
          version: BUILD_VERSION,
          setWebhook: response,
          webhook: {
            url: info?.url || "",
            pendingUpdateCount: info?.pending_update_count || 0,
            lastErrorDate: info?.last_error_date || null,
            lastErrorMessage: info?.last_error_message || null,
            allowedUpdates: info?.allowed_updates || null,
          },
        });
      } catch (error) {
        return json({ ok: false, version: BUILD_VERSION, error: formatError(error) }, 500);
      }
    }

    if (request.method === "GET" && url.pathname === "/telegram-webhook-status") {
      try {
        const info = await telegram(env, "getWebhookInfo", {});
        return json({
          ok: true,
          version: BUILD_VERSION,
          webhook: {
            url: info?.url || "",
            pendingUpdateCount: info?.pending_update_count || 0,
            lastErrorDate: info?.last_error_date || null,
            lastErrorMessage: info?.last_error_message || null,
            allowedUpdates: info?.allowed_updates || null,
          },
        });
      } catch (error) {
        return json({ ok: false, version: BUILD_VERSION, error: formatError(error) }, 500);
      }
    }

    return app.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return app.scheduled(event, env, ctx);
  },
};

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
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.description || `Telegram HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
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
