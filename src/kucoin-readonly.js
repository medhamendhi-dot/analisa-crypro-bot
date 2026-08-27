const KUCOIN_BASE = "https://api.kucoin.com";

export async function getKucoinReadOnlyStatus(env) {
  const configured = {
    key: Boolean(env.KUCOIN_API_KEY),
    secret: Boolean(env.KUCOIN_API_SECRET),
    passphrase: Boolean(env.KUCOIN_API_PASSPHRASE),
  };

  if (!configured.key || !configured.secret) {
    return {
      ok: false,
      configured,
      authenticated: false,
      error: "KUCOIN_API_KEY / KUCOIN_API_SECRET belum lengkap",
    };
  }

  if (!configured.passphrase) {
    return {
      ok: false,
      configured,
      authenticated: false,
      error: "KUCOIN_API_PASSPHRASE belum dikonfigurasi. Private REST KuCoin memerlukannya untuk autentikasi.",
    };
  }

  const requestedVersion = String(env.KUCOIN_API_KEY_VERSION || "").trim();
  const versions = requestedVersion ? [requestedVersion] : ["3", "2"];
  let lastError = null;

  for (const version of versions) {
    try {
      const data = await kucoinSignedGet(env, "/api/v1/user/api-key", version);
      return {
        ok: true,
        configured,
        authenticated: true,
        apiVersion: data?.apiVersion ?? version,
        permission: String(data?.permission || ""),
        region: data?.region || null,
        siteType: data?.siteType || null,
        isMaster: Boolean(data?.isMaster),
        kycStatus: data?.kycStatus ?? null,
      };
    } catch (error) {
      lastError = error;
      if (!String(error?.message || "").includes("400009")) break;
    }
  }

  return {
    ok: false,
    configured,
    authenticated: false,
    error: clean(lastError?.message || "Autentikasi KuCoin gagal"),
  };
}

async function kucoinSignedGet(env, endpoint, keyVersion) {
  const timestamp = String(Date.now());
  const method = "GET";
  const body = "";
  const prehash = `${timestamp}${method}${endpoint}${body}`;

  const [signature, encryptedPassphrase] = await Promise.all([
    hmacBase64(env.KUCOIN_API_SECRET, prehash),
    hmacBase64(env.KUCOIN_API_SECRET, env.KUCOIN_API_PASSPHRASE),
  ]);

  const response = await fetch(`${KUCOIN_BASE}${endpoint}`, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "KC-API-KEY": env.KUCOIN_API_KEY,
      "KC-API-SIGN": signature,
      "KC-API-TIMESTAMP": timestamp,
      "KC-API-PASSPHRASE": encryptedPassphrase,
      "KC-API-KEY-VERSION": String(keyVersion),
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.code !== "200000") {
    const code = payload?.code || `HTTP ${response.status}`;
    const message = payload?.msg || payload?.message || "request gagal";
    throw new Error(`${code}: ${message}`);
  }

  return payload.data;
}

async function hmacBase64(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(String(message)));
  const bytes = new Uint8Array(signature);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function clean(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 500)
    .trim();
}
