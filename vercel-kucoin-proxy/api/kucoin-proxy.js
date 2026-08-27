import crypto from "node:crypto";

const KUCOIN_BASE = "https://api.kucoin.com";
const SYMBOL = "BTC-USDT";

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const apiKey = process.env.KUCOIN_API_KEY;
  const secret = process.env.KUCOIN_API_SECRET;
  const passphraseRaw = process.env.KUCOIN_API_PASSPHRASE;
  const apiVersion = String(process.env.KUCOIN_API_KEY_VERSION || "3");
  if (!apiKey || !secret || !passphraseRaw) {
    return res.status(500).json({ ok: false, error: "KuCoin secrets belum lengkap di Vercel" });
  }

  const ts = String(req.headers["x-kc-proxy-ts"] || "");
  const signature = String(req.headers["x-kc-proxy-sign"] || "");
  if (!/^\d{13}$/.test(ts) || Math.abs(Date.now() - Number(ts)) > 90_000) {
    return res.status(401).json({ ok: false, error: "Proxy timestamp tidak valid/kedaluwarsa" });
  }

  const method = String(req.body?.method || "").toUpperCase();
  const endpoint = String(req.body?.endpoint || "");
  const body = req.body?.body ?? null;
  const canonicalBody = body == null ? "" : JSON.stringify(body);
  const signed = `${ts}\n${method}\n${endpoint}\n${canonicalBody}`;
  const expected = crypto.createHmac("sha256", secret).update(signed).digest("hex");
  if (!safeEqualHex(signature, expected)) {
    return res.status(401).json({ ok: false, error: "Proxy signature tidak valid" });
  }

  if (!isAllowed(method, endpoint, body)) {
    return res.status(403).json({ ok: false, error: "Endpoint/parameter tidak diizinkan oleh KuCoin proxy" });
  }

  try {
    const data = await kucoinPrivate({ apiKey, secret, passphraseRaw, apiVersion }, method, endpoint, body);
    return res.status(200).json({ ok: true, data, region: process.env.VERCEL_REGION || null });
  } catch (error) {
    return res.status(502).json({ ok: false, error: String(error?.message || error), region: process.env.VERCEL_REGION || null });
  }
}

function isAllowed(method, endpoint, body) {
  if (method === "GET" && endpoint === "/api/v1/user/api-key") return true;
  if (method === "GET" && endpoint === "/api/v3/isolated/accounts?symbol=BTC-USDT&quoteCurrency=USDT&queryType=ISOLATED") return true;
  if (method === "GET" && /^\/api\/v3\/hf\/margin\/orders\/[A-Za-z0-9_-]+\?symbol=BTC-USDT$/.test(endpoint)) return true;

  if (method === "POST" && endpoint === "/api/v3/hf/margin/order") {
    if (!body || body.symbol !== SYMBOL || body.type !== "market" || body.isIsolated !== true) return false;
    if (body.autoBorrow !== false || body.autoRepay !== false) return false;
    if (!["buy", "sell"].includes(String(body.side))) return false;

    if (body.side === "buy") {
      return typeof body.funds === "string" && Number(body.funds) > 0 && !("size" in body);
    }
    if (body.side === "sell") {
      return typeof body.size === "string" && Number(body.size) > 0 && !("funds" in body);
    }
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

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.code !== "200000") {
    throw new Error(`${payload?.code || `HTTP ${response.status}`}: ${payload?.msg || payload?.message || "request gagal"}`);
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
