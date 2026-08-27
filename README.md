# Analisa Crypto Bot

Cloudflare Worker + Telegram bot untuk membaca market crypto, derivatives, data makro, berita terbaru, dan menghasilkan analisa probabilistik bullish/bearish dengan xAI.

## Fitur aktif

- Telegram webhook: `POST /telegram`
- Setup webhook: `GET /setup-webhook`
- Auto monitor setiap 5 menit
- MEXC + Binance public market data
- Finnhub Economic Calendar
- Coinalyze derivatives: Open Interest, funding, liquidation, long/short
- FRED macro snapshot: CPI YoY, Fed Funds, US 10Y yield
- You.com Search untuk berita terbaru
- xAI Responses API untuk menggabungkan semua data menjadi analisa
- KuCoin private API read-only health check

BingX demo auto-trader tidak lagi menjadi entry point Worker.

## Perintah Telegram

```text
/start
/analyzebtc
/newsbtc
/kucoin
```

`/kucoin` hanya mengecek autentikasi dan permission API KuCoin. Tidak ada endpoint order, withdrawal, transfer, atau auto-trading KuCoin di implementasi ini.

Analisa bersifat probabilistik dan bukan jaminan keuntungan atau nasihat keuangan.

## Deploy

Cloudflare build command boleh dikosongkan.

Deploy command:

```bash
npx wrangler deploy
```

Entry point Worker sekarang adalah `src/auto-monitor.js`.

## Cloudflare Secrets / Variables

Jangan commit API key ke repository.

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
TELEGRAM_WEBHOOK_SECRET

MEXC_API_KEY
MEXC_API_SECRET

KUCOIN_API_KEY
KUCOIN_API_SECRET
KUCOIN_API_PASSPHRASE

FINNHUB_API_KEY
COINALYZE_API_KEY
YOU_API_KEY
FRED_API_KEY
XAI_API_KEY
TWELVEDATA_API_KEY
```

Opsional:

```text
KUCOIN_API_KEY_VERSION=3
XAI_MODEL=grok-4.5
```

Untuk private REST KuCoin, dokumentasi KuCoin mewajibkan Key, Secret, Passphrase, dan API key version. Jika `KUCOIN_API_KEY_VERSION` tidak diisi, health check mencoba versi 3 lalu 2.

## Telegram webhook

Setelah redeploy, webhook Telegram yang sudah mengarah ke `/telegram` tetap dapat digunakan. Jika token/domain/webhook secret berubah, buka sekali:

```text
https://<worker-domain>/setup-webhook
```

## Keamanan

- Semua secret disimpan di Cloudflare, bukan GitHub.
- Bot tidak memiliki fungsi withdraw/transfer/order placement.
- `TELEGRAM_CHAT_ID` membatasi command ke chat yang dikonfigurasi.
- Input berita diperlakukan sebagai data tidak tepercaya; prompt xAI melarang mengikuti instruksi dari isi berita.
