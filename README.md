# Analisa Crypto Bot

Cloudflare Worker + Telegram bot untuk membaca market crypto dan nantinya menggabungkan berita, data makro, derivatives, serta AI untuk memberi peringatan bullish/bearish.

## Fitur aktif

- Endpoint health check: `/` dan `/health`
- Webhook Telegram: `POST /telegram`
- Helper setup webhook: `GET /setup-webhook`
- `/start`
- `/status`
- `/price BTCUSDT` membandingkan harga MEXC + Binance
- `/mexc` untuk tes private read-only MEXC API
- `/binance BTCUSDT` untuk tes Binance Public Market API
- Data harga publik dari MEXC dan Binance tanpa memerlukan private API key
- Binance memakai `data-api.binance.vision` dengan fallback `api.binance.com`
- Jika `TELEGRAM_CHAT_ID` diisi, hanya chat tersebut yang dapat memakai bot
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

Untuk MEXC:

```text
MEXC_API_KEY = Access Key
MEXC_API_SECRET = Secret Key
```

Binance market data yang dipakai bot saat ini adalah public API, sehingga tidak memerlukan `BINANCE_API_KEY` maupun `BINANCE_API_SECRET`.

Bot saat ini hanya memakai private MEXC API untuk tes baca akun melalui `/mexc`. Kode tidak memiliki fungsi memasang order, withdraw, atau transfer.

## Menghubungkan webhook Telegram

Setelah Worker berhasil deploy, buka sekali:

```text
https://<worker-domain>/setup-webhook
```

Worker akan memanggil Telegram `setWebhook` dan mengarahkan update ke:

```text
https://<worker-domain>/telegram
```

Kemudian buka bot Telegram dan kirim:

```text
/start
/status
/mexc
/binance BTCUSDT
/price BTCUSDT
```

Jika `/mexc` menampilkan `MEXC API TERHUBUNG`, Access Key dan Secret Key berhasil dipakai.

Jika `/binance BTCUSDT` menampilkan `BINANCE PUBLIC API TERHUBUNG`, Binance market data sudah aktif tanpa API key.

## Keamanan

- Jangan aktifkan permission Withdraw/Transfer/Order Placing pada exchange untuk bot analisa.
- Semua API key rahasia disimpan sebagai Cloudflare Secret.
- `TELEGRAM_CHAT_ID` membatasi kontrol bot ke chat yang dikonfigurasi.
- Output analisa nantinya bersifat probabilistik, bukan jaminan harga akan naik atau turun.
