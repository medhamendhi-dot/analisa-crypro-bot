import app from "./kucoin-entry-v3.js";

const BUILD_VERSION = "2026-08-27-kucoin-entry-v4";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Route legacy /kucoin through the Vercel-backed /kucoinproxy handler
    // so it no longer calls KuCoin directly from the Cloudflare US egress IP.
    if (request.method === "POST" && url.pathname === "/telegram") {
      const clone = request.clone();
      const update = await clone.json().catch(() => null);
      const text = String(update?.message?.text || "").trim();
      const command = text.split(/\s+/)[0]?.toLowerCase().split("@")[0] || "";

      if (command === "/kucoin") {
        const rewritten = structuredClone(update);
        if (rewritten?.message) rewritten.message.text = "/kucoinproxy";
        const forwarded = new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(rewritten),
        });
        return app.fetch(forwarded, env, ctx);
      }
    }

    if (request.method === "GET" && url.pathname === "/kucoin-entry-version") {
      return new Response(JSON.stringify({ ok: true, version: BUILD_VERSION }), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }

    return app.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return app.scheduled(event, env, ctx);
  },
};
