import crypto from "node:crypto";

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  const apiKey = process.env.KUCOIN_API_KEY;
  const secret = process.env.KUCOIN_API_SECRET;
  const pass = process.env.KUCOIN_API_PASSPHRASE;
  const version = String(process.env.KUCOIN_API_KEY_VERSION || "3");

  if (!apiKey || !secret || !pass) {
    return res.status(200).json({
      ok: false,
      region: process.env.VERCEL_REGION || null,
      missing: ["KUCOIN_API_KEY", "KUCOIN_API_SECRET", "KUCOIN_API_PASSPHRASE"].filter((k) => !process.env[k]),
    });
  }

  const endpoint = "/api/v1/user/api-key";
  const ts = String(Date.now());
  const sign = crypto.createHmac("sha256", secret).update(`${ts}GET${endpoint}`).digest("base64");
  const pp = crypto.createHmac("sha256", secret).update(pass).digest("base64");

  const r = await fetch(`https://api.kucoin.com${endpoint}`, {
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "KC-API-KEY": apiKey,
      "KC-API-SIGN": sign,
      "KC-API-TIMESTAMP": ts,
      "KC-API-PASSPHRASE": pp,
      "KC-API-KEY-VERSION": version,
    },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.code !== "200000") {
    return res.status(200).json({ ok: false, region: process.env.VERCEL_REGION || null, apiVersion: Number(version), code: j?.code || r.status, message: j?.msg || j?.message || "request gagal" });
  }

  const d = j.data || {};
  return res.status(200).json({
    ok: true,
    region: process.env.VERCEL_REGION || null,
    apiVersion: Number(version),
    permission: d.permission || null,
    regionFromKuCoin: d.region || null,
    siteType: d.siteType || null,
    isMaster: d.isMaster ?? null,
    kycStatus: d.kycStatus ?? null,
    message: "Private KuCoin API authentication berhasil dari Vercel.",
  });
}
