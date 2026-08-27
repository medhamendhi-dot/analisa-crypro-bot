export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const token = process.env.TELEGRAM_API_KEY || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return res.status(500).json({
      ok: false,
      telegramTokenPresent: false,
      error: 'TELEGRAM_API_KEY atau TELEGRAM_BOT_TOKEN belum ada di Vercel',
      region: process.env.VERCEL_REGION || null,
    });
  }

  const base = `https://api.telegram.org/bot${token}`;
  try {
    const [meR, hookR] = await Promise.all([
      fetch(`${base}/getMe`),
      fetch(`${base}/getWebhookInfo`),
    ]);
    const me = await meR.json().catch(() => ({}));
    const hook = await hookR.json().catch(() => ({}));

    return res.status(200).json({
      ok: me?.ok === true && hook?.ok === true,
      region: process.env.VERCEL_REGION || null,
      telegramTokenPresent: true,
      bot: me?.ok ? {
        id: me.result?.id || null,
        username: me.result?.username || null,
        firstName: me.result?.first_name || null,
      } : null,
      webhook: hook?.ok ? {
        url: hook.result?.url || '',
        pendingUpdateCount: hook.result?.pending_update_count || 0,
        lastErrorDate: hook.result?.last_error_date || null,
        lastErrorMessage: hook.result?.last_error_message || null,
        maxConnections: hook.result?.max_connections || null,
        allowedUpdates: hook.result?.allowed_updates || null,
      } : null,
      telegramError: !me?.ok ? (me?.description || 'getMe gagal') : !hook?.ok ? (hook?.description || 'getWebhookInfo gagal') : null,
      expectedWebhookPath: '/telegram',
      note: 'Endpoint ini hanya membaca status bot dan webhook; token tidak pernah ditampilkan.'
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      telegramTokenPresent: true,
      region: process.env.VERCEL_REGION || null,
      error: String(error?.message || error),
    });
  }
}
