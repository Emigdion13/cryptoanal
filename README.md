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
- **From btcAnalyzerV2** (same math, checked against V2's own code on the same candles):
  - **MACD** with V2's divergences (regular and hidden, bull and bear) on top of TradingView's MACD.
  - **CM_Ult_MacD_MTF** (ChrisMoody): 4-colour histogram, lime/red MACD line, cross dots, divergences, on the chart's resolution or another one.
  - **TMO Scalper**: three timeframes (1m / 5m / 30m by default) with the gated ▲▼ arrows, the extreme-only arrows, the OB/OS zones and each timeframe's Main-to-Signal cloud.
  - **TMO [LuxAlgo]** (Triangular Momentum Oscillator & Real Time Divergences): the 4-colour momentum histogram (or the price-correlation gradient), Buy/Sell turns and divergence lines.
  - **RSI Divergence**: RSI 14 with regular and hidden divergences.
  - **RSI** and **Stochastic RSI (14, 14, 3, 3)** are TradingView's built-ins, the same numbers V2 shows.
  - **MSB-OB ZigZag (Market Structure)**: the swing-high to swing-low zig-zag.
  - **Smart Money Concepts [LuxAlgo]**: BOS/CHoCH, swing labels, strong/weak highs and lows, order blocks, EQH/EQL, fair value gaps, previous day/week/month highs and lows, premium/discount zones — every LuxAlgo setting, in sections.
- **TUX EMA Scalper+SuperTrend (3, 7, 20, close)**: a clone of LARIANE's TradingView script (protected source), rebuilt from its two public parts — TonyUX EMA Scalper (EMA 20, highest/lowest close of 8, Buy/Sell on any EMA cross by the bar's direction) and Supertrend V1.0 (Factor 3, Pd 7, its triangles and tall entry arrows) — with the script's colours, widths and transparency, and the same 10-value legend. Checked against TradingView's own output (`src/indicators/fixtures/tux-tradingview.json`): every arrow and label on the same bars, the lines to the cent.
- **Support and Resistance Levels with Breaks [LuxAlgo] (15, 15, 20)**: a clone of LuxAlgo's open-source script — pivot-high resistance (red) and pivot-low support (blue) drawn `rightBars + 1` bars back, gaps where a level moves, and the "B" break labels (volume oscillator above the threshold) and Bull/Bear Wick labels. Checked against TradingView's own output (`src/indicators/fixtures/luxsr-tradingview.json`): both levels to the cent on every sampled bar and every break label on the same bar.
- **Kalshi Strike (15m up/down)**: the strike of Kalshi's 15-minute market for BTC, ETH, SOL, XRP, DOGE, HYPE or BNB — Kalshi's own published `floor_strike` (the 60-second CF Benchmarks average it settles on), never a Coinbase estimate. Past windows' strikes as an amber step line (about 10 days back), the live one run to the price axis, and a badge: ▲ UP / ▼ DOWN, distance from the strike, time left in the window, and Kalshi's Yes price. Optional ± target lines in Style. Needs the dev server (Kalshi refuses browser requests, so `/api/kalshi/strike` asks for the page).
- **Split screen** (the layout button at top right): 1 to 8 charts, each with its own symbol, interval, chart type and indicators. Click a chart to make it active; the toolbar acts on it. "Sync in layout" links symbol, interval, crosshair and time between charts. Drag the borders between charts to resize them (double-click a border to even it out); each layout remembers its sizes.
- **Floating windows** (V2's oscillator windows): every indicator with a pane of its own — RSI, MACD, Stochastic, Stoch RSI, CM_Ult_MacD_MTF, TMO Scalper, TMO [LuxAlgo], RSI Divergence, CCI and the rest — is either docked in its pane or floating, never both: floating it takes the pane away and docking it (the pane button on the card) puts the pane back. The floating card sits over the chart: a zoomed mini chart of its last bars (scaled around zero for MACD-style oscillators, levels shown once the scale reaches them), its values for the bar under the crosshair (or under the mouse in the card), and the call it is read for — overbought / oversold, a fresh signal, a cross, rising / falling. ± sets the bars, drag the plot (or ‹ ›) to walk back through history, minimize it to one line. Open one from its legend row's window button, the toolbar **Floating** menu, or **Alt+1…9** (Alt+0 for all). Overlays such as TUX, Support and Resistance or SMC mean something only on the candles, so they have none. Where each card sits, its bars and its minimized state are saved with the layout.
- **Saved layouts** (the layout name and Save button at top right), as on TradingView: Save (Ctrl+S), Rename, Make a copy, New layout, Load layout (`.`), Autosave. A layout keeps its charts, symbols, intervals, indicators and their settings, split and pane sizes, and sync options.
- **Bottom bar:** date ranges (1D … All) that switch the interval like TradingView, the UTC clock, and `%` / `log` / `auto` scale toggles.
- History loads as you scroll back; bars update live from Coinbase's trade feed.
- **Keyboard:** ←/→ scroll, ↑/↓ zoom, Alt+R resets the chart.

## Data

Candles come from Coinbase Exchange's public REST API, live trades and tickers from its public WebSocket feed. Coinbase serves 1m, 5m, 15m, 1h, 6h and 1D candles; the other intervals are built from the largest of those that divides them (4h from 1h, 1W from 1D). Times are UTC, as on TradingView for crypto.

## Where layouts are saved

`npm run dev` (and `npm run preview`) keep your settings and saved layouts in one file, `~/.cryptoanal/workspace.json` (set `CRYPTOANAL_STORE` to use another path). The file is the only copy, so another port, another browser or cleared site data all open the same layouts. The previous version is kept as `workspace.json.bak`. Changes are saved a moment after you make them, one layout at a time, so two open tabs don't overwrite each other's layouts. If a save fails, the Save button says **Not saved** and it keeps retrying until the dev server is back.

The dev server always runs on port 5190 (`strictPort`): if that port is busy it stops instead of quietly moving to another one.

After pulling changes to `server/` or `vite.config.ts`, restart `npm run dev`.

Built as a static site (`npm run build`, no dev server), the app keeps everything in the browser's storage instead.
