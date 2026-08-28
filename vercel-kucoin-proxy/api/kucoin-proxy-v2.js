import crypto from "node:crypto";

const KUCOIN_BASE = "https://api.kucoin.com";
const SYMBOL = "BTC-USDT";
const BUILD_VERSION = "2026-08-28-kucoin-margin-disabled";
const ORDER_TIMEOUT_MS = 4500;
const READ_TIMEOUT_MS = 4500;
const VERIFY_TIMEOUT_MS = 2500;
const BUY_FUNDS_RATIO = 0.995;
const MARGIN_TRADING_ENABLED = false;

export default async function handler(req, res) {
  const startedAt = Date.now();
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
      trading: {
        marginEnabled: MARGIN_TRADING_ENABLED,
        orderCreation: "DISABLED",
      },
      timeouts: { orderMs: ORDER_TIMEOUT_MS, readMs: READ_TIMEOUT_MS, verifyMs: VERIFY_TIMEOUT_MS },
      buyFundsRatio: BUY_FUNDS_RATIO,
      note: "Health only. Margin orders are disabled. No order is sent by GET.",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed", region });
  }

  // Emergency kill switch: do not allow this proxy to create any isolated-margin order.
  // This check happens before credentials/signature validation so every POST order attempt
  // is rejected immediately and cannot reach KuCoin.
  const requestedMethod = String(req.body?.method || "").toUpperCase();
  const requestedEndpoint = String(req.body?.endpoint || "");
  if (requestedMethod === "POST" && requestedEndpoint === "/api/v3/hf/margin/order") {
    return res.status(403).json({
      ok: false,
      error: "KUCOIN MARGIN TRADING DINONAKTIFKAN. Tidak ada order margin yang akan dikirim.",
      code: "MARGIN_TRADING_DISABLED",
      region,
      version: BUILD_VERSION,
      durationMs: Date.now() - startedAt,
    });
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

  const cfg = { apiKey, secret, passphraseRaw, apiVersion };
  const primaryTimeout = method === "POST" ? ORDER_TIMEOUT_MS : READ_TIMEOUT_MS;

  let outboundBody = body;
  let requestedFunds = null;
  let submittedFunds = null;
  if (method === "POST" && endpoint === "/api/v3/hf/margin/order" && body?.side === "buy" && typeof body?.funds === "string") {
    requestedFunds = Number(body.funds);
    const adjusted = roundDown(requestedFunds * BUY_FUNDS_RATIO, 6);
    if (!(adjusted > 0)) {
      return res.status(400).json({ ok: false, error: "Dana BUY terlalu kecil setelah buffer fee", region, version: BUILD_VERSION });
    }
    submittedFunds = adjusted;
    outboundBody = { ...body, funds: String(adjusted) };
  }

  try {
    const data = await kucoinPrivate(cfg, method, endpoint, outboundBody, primaryTimeout);
    return res.status(200).json({
      ok: true,
      data,
      region,
      version: BUILD_VERSION,
      durationMs: Date.now() - startedAt,
      requestedFunds,
      submittedFunds,
    });
  } catch (error) {
    if (method === "POST" && endpoint === "/api/v3/hf/margin/order" && outboundBody?.clientOid && isAmbiguousFailure(error)) {
      try {
        const verifyEndpoint = `/api/v3/hf/margin/orders/client-order/${encodeURIComponent(outboundBody.clientOid)}?symbol=${SYMBOL}`;
        const found = await kucoinPrivate(cfg, "GET", verifyEndpoint, null, VERIFY_TIMEOUT_MS);
        if (found?.id) {
          return res.status(200).json({
            ok: true,
            data: { orderId: found.id, clientOid: outboundBody.clientOid, recovered: true },
            region,
            version: BUILD_VERSION,
            durationMs: Date.now() - startedAt,
            recovery: "Order ditemukan via clientOid setelah respons upstream ambigu.",
            requestedFunds,
            submittedFunds,
          });
        }
      } catch (verifyError) {
        return res.status(502).json({
          ok: false,
          error: `Order belum dapat dikonfirmasi. Order request: ${formatError(error)} | Verifikasi clientOid: ${formatError(verifyError)}`,
          region,
          version: BUILD_VERSION,
          durationMs: Date.now() - startedAt,
          ambiguous: true,
          clientOid: outboundBody.clientOid,
          requestedFunds,
          submittedFunds,
        });
      }
    }

    return res.status(502).json({
      ok: false,
      error: formatError(error),
      region,
      version: BUILD_VERSION,
      durationMs: Date.now() - startedAt,
      upstreamStatus: Number(error?.upstreamStatus || 0) || null,
      ambiguous: Boolean(error?.ambiguous),
      requestedFunds,
      submittedFunds,
    });
  }
}

function isAllowed(method, endpoint, body) {
  if (method === "GET" && endpoint === "/api/v1/user/api-key") return true;
  if (method === "GET" && endpoint === "/api/v3/isolated/accounts?symbol=BTC-USDT&quoteCurrency=USDT&queryType=ISOLATED") return true;
  if (method === "GET" && /^\/api\/v3\/hf\/margin\/orders\/client-order\/[A-Za-z0-9_-]+\?symbol=BTC-USDT$/.test(endpoint)) return true;

  if (method === "POST" && endpoint === "/api/v3/hf/margin/order") {
    if (!MARGIN_TRADING_ENABLED) return false;
    if (!body || body.symbol !== SYMBOL || body.type !== "market" || body.isIsolated !== true) return false;
    if (body.autoBorrow !== false || body.autoRepay !== false) return false;
    if (!["buy", "sell"].includes(String(body.side))) return false;
    if (typeof body.clientOid !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(body.clientOid)) return false;

    if (body.side === "buy") {
      return typeof body.funds === "string" && Number(body.funds) > 0 && !("size" in body);
    }
    return typeof body.size === "string" && Number(body.size) > 0 && !("funds" in body);
  }

  return false;
}

async function kucoinPrivate(cfg, method, endpoint, bodyObj, timeoutMs) {
  const body = bodyObj == null ? "" : JSON.stringify(bodyObj);
  const timestamp = String(Date.now());
  const prehash = `${timestamp}${method}${endpoint}${body}`;
  const signature = crypto.createHmac("sha256", cfg.secret).update(prehash).digest("base64");
  const passphrase = crypto.createHmac("sha256", cfg.secret).update(cfg.passphraseRaw).digest("base64");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${KUCOIN_BASE}${endpoint}`, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "kucoin-vercel-proxy/5",
        "KC-API-KEY": cfg.apiKey,
        "KC-API-SIGN": signature,
        "KC-API-TIMESTAMP": timestamp,
        "KC-API-PASSPHRASE": passphrase,
        "KC-API-KEY-VERSION": cfg.apiVersion,
      },
      body: body || undefined,
      signal: controller.signal,
    });
  } catch (error) {
    const wrapped = new Error(error?.name === "AbortError" ? `KuCoin upstream timeout setelah ${timeoutMs}ms` : `KuCoin fetch gagal: ${formatError(error)}`);
    wrapped.ambiguous = method === "POST";
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch {}

  if (!response.ok || payload?.code !== "200000") {
    const code = payload?.code || `HTTP ${response.status}`;
    const message = payload?.msg || payload?.message || text || "request gagal";
    const wrapped = new Error(`${code}: ${formatError(message)}`);
    wrapped.upstreamStatus = response.status;
    wrapped.ambiguous = method === "POST" && response.status >= 500;
    throw wrapped;
  }
  return payload.data;
}

function isAmbiguousFailure(error) {
  return Boolean(error?.ambiguous || Number(error?.upstreamStatus || 0) >= 500 || /timeout|fetch gagal|HTTP 5\d\d/i.test(formatError(error)));
}

function safeEqualHex(a, b) {
  if (!/^[a-f0-9]+$/i.test(a) || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

function roundDown(value, decimals) {
  const f = 10 ** decimals;
  return Math.floor(Number(value) * f + 1e-12) / f;
}

function formatError(value) {
  if (value instanceof Error) return value.message || String(value);
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}
