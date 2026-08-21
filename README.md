# Analisa Crypto Bot

Cloudflare Worker + Telegram bot untuk membaca market crypto, data makro, derivatives, berita, dan nantinya AI untuk memberi peringatan bullish/bearish.

## Fitur aktif

- Endpoint health check: `/` dan `/health`
- Webhook Telegram: `POST /telegram`
- Helper setup webhook: `GET /setup-webhook`
- `/start`
- `/status`
- `/price BTCUSDT` membandingkan harga MEXC + Binance
- `/mexc` untuk tes private read-only MEXC API
- `/binance BTCUSDT` untuk tes Binance Public Market API
- `/finnhub` untuk tes Finnhub Economic Calendar
- `/macro` untuk membaca event makro AS penting hari ini + besok
- `/coinalyze BTC` untuk tes Coinalyze dan memilih market futures perpetual
- `/derivatives BTC` untuk Open Interest, Funding Rate, liquidations 24 jam, dan long/short ratio
- Filter event seperti CPI/inflasi, PCE, NFP/payroll, unemployment/jobless, FOMC/Fed, rate decision, GDP, retail sales, PPI, ISM dan JOLTS
- Data harga publik dari MEXC dan Binance tanpa memerlukan private API key
- Jika `TELEGRAM_CHAT_ID` diisi, hanya chat tersebut yang dapat memakai bot

## Deploy

Cloudflare build command boleh dikosongkan.

Deploy command:

```bash
npx wrangler deploy
```

## Cloudflare Secrets / Variables

Jangan commit API key ke repository.

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
TELEGRAM_WEBHOOK_SECRET

MEXC_API_KEY
MEXC_API_SECRET

FINNHUB_API_KEY
COINALYZE_API_KEY
YOU_API_KEY
XAI_API_KEY
FRED_API_KEY
```

Binance market data yang dipakai bot adalah public API sehingga tidak memerlukan `BINANCE_API_KEY` atau `BINANCE_API_SECRET`.

`COINALYZE_API_KEY` dipakai untuk futures/derivatives. Bot memilih perpetual USDT yang paling sesuai dan memprioritaskan market Binance bila tersedia.

## Telegram

Setelah deploy, buka sekali:

```text
https://<worker-domain>/setup-webhook
```

Kemudian tes:

```text
/start
/status
/price BTCUSDT
/mexc
/binance BTCUSDT
/finnhub
/macro
/coinalyze BTC
/derivatives BTC
```

## Keamanan

- Jangan aktifkan Withdraw/Transfer/Order Placing pada exchange untuk bot analisa.
- Semua API key rahasia disimpan sebagai Cloudflare Secret.
- `TELEGRAM_CHAT_ID` membatasi kontrol bot ke chat yang dikonfigurasi.
- Bias derivatives adalah sinyal awal berbasis data, bukan prediksi pasti atau nasihat keuangan.
