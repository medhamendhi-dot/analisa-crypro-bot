# Analisa Crypto Bot

Cloudflare Worker + Telegram bot untuk membaca market crypto, derivatives, data makro, berita terbaru, dan menghasilkan analisa probabilistik bullish/bearish dengan xAI.

## Fitur aktif

- Telegram webhook: `POST /telegram`
- Setup webhook: `GET /setup-webhook`
- AI health check: `GET /ai-health`
- MEXC + Binance public market data
- Finnhub Economic Calendar
- Coinalyze derivatives: Open Interest, funding, liquidation, long/short
- FRED macro snapshot: CPI YoY, Fed Funds, US 10Y yield
- You.com Search untuk berita terbaru
- xAI Responses API untuk menggabungkan semua data menjadi analisa

## Perintah Telegram

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
/xai
/news BTC
/fred
/analyze BTC
/analisa BTC
```

`/xai` melakukan tes koneksi xAI.

`/news BTC` mengambil breaking/recent news melalui You.com.

`/fred` menampilkan snapshot makro terbaru dari FRED.

`/analyze BTC` atau `/analisa BTC` menggabungkan:

```text
MEXC + Binance
Coinalyze
Finnhub
FRED
You.com
   ↓
xAI
   ↓
BULLISH / BEARISH / NEUTRAL
Confidence 0-100%
Impact + horizon + alasan + risiko
```

Analisa bersifat probabilistik dan bukan jaminan keuntungan atau nasihat keuangan.

## Deploy

Cloudflare build command boleh dikosongkan.

Deploy command:

```bash
npx wrangler deploy
```

Entry point Worker sekarang adalah `src/app.js`; command lama diteruskan ke `src/index.js` sehingga fitur yang sudah ada tetap aktif.

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
FRED_API_KEY
XAI_API_KEY
```

Opsional:

```text
XAI_MODEL=grok-4.5
```

Jika `XAI_MODEL` tidak diisi, bot menggunakan `grok-4.5`.

Binance market data yang dipakai bot adalah public API sehingga tidak memerlukan `BINANCE_API_KEY` atau `BINANCE_API_SECRET`.

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
