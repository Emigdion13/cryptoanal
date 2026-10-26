# CryptoAnal

A crypto chart that looks and moves like TradingView's — the charts and the feel, not the drawing tools.

It runs on [lightweight-charts](https://github.com/tradingview/lightweight-charts), TradingView's own open-source chart engine, with live Coinbase data (no API key).

## Run it

Needs Node 22 or newer.

```bash
npm install
npm run dev
```

Then open http://localhost:5190.

`npm run build` makes a static site in `dist/` that any static host can serve. `npm test` runs the unit tests.

## What's in it

- **TradingView's dark chart page:** black panels on a dark gray page, its candle colors, grid, crosshair and fonts (measured from tradingview.com).
- **The same feel:** the wheel zooms with the newest bar held in place (Ctrl+wheel zooms at the mouse), a vertical drag moves prices and takes the scale off auto, the wheel over the price axis stretches prices, and a flung drag glides.
- **Last-price label with a countdown** to the bar close, plus the volume label, on the price axis.
- **Legend** with OHLC, change and volume that follows the crosshair.
- **Intervals** 1m–12h, D, W, M. Star intervals in the menu to pin them to the toolbar. Type a number on the chart to change the interval (`5`, `60`, `4h`, `D`).
- **Chart types:** bars, candles, hollow candles, Heikin Ashi, line, line with markers, step line, area, baseline, columns.
- **Symbol search** over every Coinbase product. Start typing letters on the chart to open it.
- **Watchlist** with live prices and the day's change.
- **Indicators** (the `Indicators` button or `/`): Volume, SMA, EMA, WMA, HMA, VWMA, MA Cross, Bollinger Bands, Keltner, Donchian, Envelope, VWAP, Parabolic SAR, Supertrend, RSI, MACD, Stochastic, Stochastic RSI, CCI, Williams %R, Momentum, ROC, Awesome Oscillator, DMI, Aroon, ATR, BB %b, BB Width, OBV, MFI and CMF, with TradingView's default inputs and colors. Overlays sit on the price pane and the rest get their own panes (drag the separators to resize). Hover a legend row to hide, configure (Inputs / Style) or remove an indicator.
- **Split screen** (the layout button at top right): 1 to 8 charts, each with its own symbol, interval, chart type and indicators. Click a chart to make it active; the toolbar acts on it. "Sync in layout" links symbol, interval, crosshair and time between charts.
- **Bottom bar:** date ranges (1D … All) that switch the interval like TradingView, the UTC clock, and `%` / `log` / `auto` scale toggles.
- History loads as you scroll back; bars update live from Coinbase's trade feed.
- **Keyboard:** ←/→ scroll, ↑/↓ zoom, Alt+R resets the chart.

## Data

Candles come from Coinbase Exchange's public REST API, live trades and tickers from its public WebSocket feed. Coinbase serves 1m, 5m, 15m, 1h, 6h and 1D candles; the other intervals are built from the largest of those that divides them (4h from 1h, 1W from 1D). Times are UTC, as on TradingView for crypto.
