import crypto from "node:crypto";

const KUCOIN_BASE = "https://api.kucoin.com";
const SYMBOL = "BTC-USDT";
const BUILD_VERSION = "2026-08-27-kucoin-proxy-v2";

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");

  const apiKey = process.env.KUCOIN_API_KEY;
  const secret = process.env.KUCOIN_API_SECRET;
  const passphraseRaw = process.env.KUCOIN_API_PASSPHRASE;
  const proxySecret = process.env.KUCOIN_PROXY_SECRET || secret;
  const apiVersion = String(process.env.KUCOIN_API_KEY_VERSION || "3");
  const region = process.env.VERCEL_REGION || null;

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      version: BUILD_VERSION,
      service: "kucoin-proxy-v2",
      region,
      configured: {
        apiKey: Boolean(apiKey),
        apiSecret: Boolean(secret),
        passphrase: Boolean(passphraseRaw),
        proxySecret: Boolean(proxySecret),
        apiVersion,
      },
      note: "Health only. No order is sent by GET.",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed", region });
  }

  if (!apiKey || !secret || !passphraseRaw || !proxySecret) {
    return res.status(500).json({ ok: false, error: "KuCoin/proxy secrets belum lengkap di Vercel", region });
  }

  const ts = String(req.headers["x-kc-proxy-ts"] || "");
  const signature = String(req.headers["x-kc-proxy-sign"] || "");
  if (!/^\d{13}$/.test(ts) || Math.abs(Date.now() - Number(ts)) > 90_000) {
    return res.status(401).json({ ok: false, error: "Proxy timestamp tidak valid/kedaluwarsa", region });
  }

  const method = String(req.body?.method || "").toUpperCase();
  const endpoint = String(req.body?.endpoint || "");
  const body = req.body?.body ?? null;
  const canonicalBody = body == null ? "" : JSON.stringify(body);
  const signed = `${ts}\n${method}\n${endpoint}\n${canonicalBody}`;
  const expected = crypto.createHmac("sha256", proxySecret).update(signed).digest("hex");

  if (!safeEqualHex(signature, expected)) {
    return res.status(401).json({ ok: false, error: "Proxy signature tidak valid. Pastikan KUCOIN_PROXY_SECRET atau KUCOIN_API_SECRET sama di Cloudflare dan Vercel.", region });
  }

  if (!isAllowed(method, endpoint, body)) {
    return res.status(403).json({ ok: false, error: `Endpoint/parameter tidak diizinkan: ${method} ${endpoint}`, region });
  }

  try {
    const data = await kucoinPrivate({ apiKey, secret, passphraseRaw, apiVersion }, method, endpoint, body);
    return res.status(200).json({ ok: true, data, region, version: BUILD_VERSION });
  } catch (error) {
    return res.status(502).json({ ok: false, error: formatError(error), region, version: BUILD_VERSION });
  }
}

function isAllowed(method, endpoint, body) {
  if (method === "GET" && endpoint === "/api/v1/user/api-key") return true;
  if (method === "GET" && endpoint === "/api/v3/isolated/accounts?symbol=BTC-USDT&quoteCurrency=USDT&queryType=ISOLATED") return true;

  if (method === "POST" && endpoint === "/api/v3/hf/margin/order") {
    if (!body || body.symbol !== SYMBOL || body.type !== "market" || body.isIsolated !== true) return false;
    if (body.autoBorrow !== false || body.autoRepay !== false) return false;
    if (!["buy", "sell"].includes(String(body.side))) return false;

    if (body.side === "buy") {
      return typeof body.funds === "string" && Number(body.funds) > 0 && !("size" in body);
    }
    return typeof body.size === "string" && Number(body.size) > 0 && !("funds" in body);
  }

  return false;
}

async function kucoinPrivate(cfg, method, endpoint, bodyObj) {
  const body = bodyObj == null ? "" : JSON.stringify(bodyObj);
  const timestamp = String(Date.now());
  const prehash = `${timestamp}${method}${endpoint}${body}`;
  const signature = crypto.createHmac("sha256", cfg.secret).update(prehash).digest("base64");
  const passphrase = crypto.createHmac("sha256", cfg.secret).update(cfg.passphraseRaw).digest("base64");

  const response = await fetch(`${KUCOIN_BASE}${endpoint}`, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "KC-API-KEY": cfg.apiKey,
      "KC-API-SIGN": signature,
      "KC-API-TIMESTAMP": timestamp,
      "KC-API-PASSPHRASE": passphrase,
      "KC-API-KEY-VERSION": cfg.apiVersion,
    },
    body: body || undefined,
  });

  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch {}

  if (!response.ok || payload?.code !== "200000") {
    const code = payload?.code || `HTTP ${response.status}`;
    const message = payload?.msg || payload?.message || text || "request gagal";
    throw new Error(`${code}: ${formatError(message)}`);
  }
  return payload.data;
}

function safeEqualHex(a, b) {
  if (!/^[a-f0-9]+$/i.test(a) || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

function formatError(value) {
  if (value instanceof Error) return value.message || String(value);
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}
