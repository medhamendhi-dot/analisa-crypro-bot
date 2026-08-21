# Analisa Crypto Bot

Cloudflare Worker + Telegram bot untuk membaca market crypto dan nantinya menggabungkan berita, data makro, derivatives, serta AI untuk memberi peringatan bullish/bearish.

## Fitur awal

- Endpoint health check: `/` dan `/health`
- Webhook Telegram: `POST /telegram`
- `/start`
- `/status`
- `/price BTCUSDT`
- Data harga publik dari MEXC tanpa memerlukan private API key
- Secret Telegram webhook opsional

## Deploy

Cloudflare build command boleh dikosongkan.

Deploy command:

```bash
npx wrangler deploy
```

## Cloudflare Secrets / Variables

Jangan commit API key ke repository.

Tambahkan di Cloudflare Worker > Settings > Variables and Secrets:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
TELEGRAM_WEBHOOK_SECRET

MEXC_API_KEY
MEXC_API_SECRET

XAI_API_KEY
NEWS_API_KEY
TRADING_ECONOMICS_API_KEY
COINGLASS_API_KEY
FRED_API_KEY
```

`MEXC_API_KEY` dan `MEXC_API_SECRET` belum dibutuhkan untuk endpoint market publik saat ini. Simpan hanya bila nanti fitur akun privat benar-benar diperlukan.

## Set webhook Telegram

Setelah Worker berhasil deploy dan mendapat URL, webhook diarahkan ke:

```text
https://<worker-domain>/telegram
```

Jika memakai `TELEGRAM_WEBHOOK_SECRET`, gunakan nilai secret yang sama saat memanggil `setWebhook` Telegram agar request webhook dapat diverifikasi.

## Keamanan

- Jangan aktifkan permission Withdraw/Transfer/Order Placing pada exchange untuk bot analisa.
- Semua API key rahasia disimpan sebagai Cloudflare Secret.
- Output analisa nantinya bersifat probabilistik, bukan jaminan harga akan naik atau turun.
