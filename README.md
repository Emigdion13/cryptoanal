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
  - **CM_Williams_Vix_Fix (22, 20, 2, 50, 0.85, 1.01)** (ChrisMoody): Larry Williams' synthetic VIX, the fear index for any asset — lime bars are fear spikes (WVF at or over its Bollinger upper band or its percentile range high), read as potential bottoms. The upper band and range lines are off until switched on in Style. Its window calls a fresh spike ▲ POTENTIAL BOTTOM, a run of them ▲ BOTTOM SIGNAL HOLDS, within 15% of a trigger ⚠ NEAR TRIGGER, otherwise QUIET.
  - **Zeiierman Trend Pressure** (© Zeiierman, CC BY-NC-SA 4.0): Z-Pulse, Z-Trend and the bull/bear Pressure Core on a 0 to −100 scale, the moving pressure levels, the extreme-only gradient, exhaustion dots, and boxes on the candles over the bars pressure held (▾ / ▴ where it let go). Its window, and its phone tile, call UPPER PRESSURE, LOWER PRESSURE or NEUTRAL, with a pulse / trend cross when there is one.
  - Both checked against V2's own code (`src/indicators/v2/fixtures/pressure-golden.json`): every value, state and box.
  - **RSI** and **Stochastic RSI (14, 14, 3, 3)** are TradingView's built-ins, the same numbers V2 shows.
  - **MSB-OB ZigZag (Market Structure)**: the swing-high to swing-low zig-zag.
  - **Smart Money Concepts [LuxAlgo]**: BOS/CHoCH, swing labels, strong/weak highs and lows, order blocks, EQH/EQL, fair value gaps, previous day/week/month highs and lows, premium/discount zones — every LuxAlgo setting, in sections.
  - **Bayesian/nQQE/BankFunds**: tartigradia's Pine v5 combo, as V2 ported it (quirks included): red Break Down, green Break Up and blue Prime areas, the nQQE area from 50 (lime above 60, red below 40, yellow between), the banker bodies and yellow entry block, and long/short circles on Prime. Bill Williams confirmation is optional. Checked against V2's own code (`src/indicators/v2/fixtures/bayes-golden.json`): every value, colour and signal.
- **TUX EMA Scalper+SuperTrend (3, 7, 20, close)**: a clone of LARIANE's TradingView script (protected source), rebuilt from its two public parts — TonyUX EMA Scalper (EMA 20, highest/lowest close of 8, Buy/Sell on any EMA cross by the bar's direction) and Supertrend V1.0 (Factor 3, Pd 7, its triangles and tall entry arrows) — with the script's colours, widths and transparency, and the same 10-value legend. Checked against TradingView's own output (`src/indicators/fixtures/tux-tradingview.json`): every arrow and label on the same bars, the lines to the cent.
- **Support and Resistance Levels with Breaks [LuxAlgo] (15, 15, 20)**: a clone of LuxAlgo's open-source script — pivot-high resistance (red) and pivot-low support (blue) drawn `rightBars + 1` bars back, gaps where a level moves, and the "B" break labels (volume oscillator above the threshold) and Bull/Bear Wick labels. Checked against TradingView's own output (`src/indicators/fixtures/luxsr-tradingview.json`): both levels to the cent on every sampled bar and every break label on the same bar.
- **Robex S/R Zones (15m, 300, 3, 1)**: the support and resistance of the Robex IA panel (panel.robexiajd.com), rebuilt from its `sr_zones.js`. It is worked out on 15-minute candles on any chart interval, as the panel does (Candles: 15m, 5m, 1h or the chart's own), over the last 300 bars (the panel's bot sends 300):
  - pivot highs and lows with 3 bars each side, all swept from low to high and merged when within 0.5 ATR (the plain mean of 14 true ranges) of a level's running mean; the level is the mean of its pivots and the touches are how many pivots there were;
  - the last 12 bars' floor and ceiling (3+ lows or highs within 0.2 ATR that no later close broke) join a level or become one;
  - the nearest level on each side of the price is shown, those with 2+ touches first.

  Each zone is a band (its pivots' spread, 0.12–0.4 ATR thick) from its first touch to the price axis, red rgb(255,69,105) above and green rgb(0,230,118) below, with a badge such as `R1 60,030 · 4`. Optional: a line at the exact level, 2+ levels per side, and yesterday's and today's UTC high and low as grey dotted lines. Nothing carries over between updates: every bar starts again from the window, so a level goes when its pivots leave it or the price crosses it. Volume is not used. Checked against the panel's own `computeZones`, run in the page on the candles its bot sent (`src/indicators/fixtures/robex-sr-site.json`): every level, zone edge, touch count and first/last touch on 13 windows of 15m and 1h candles. On BTC the panel now shows its server's "map" instead, which is computed out of sight: the fixture keeps one snapshot of it for reference, but it is not cloned.
- **Kalshi Strike (15m up/down)**: the strike of Kalshi's 15-minute market for BTC, ETH, SOL, XRP, DOGE, HYPE or BNB — Kalshi's own published `floor_strike` (the 60-second CF Benchmarks average it settles on), never a Coinbase estimate. The live window's strike as an amber line across the chart to the price axis, and a badge: ▲ UP / ▼ DOWN, distance from the strike, time left in the window, and Kalshi's Yes price. Optional: past windows' strikes as a step line (about 10 days back, "Show past windows"), ± target lines in Style. Needs the dev server (Kalshi refuses browser requests, so `/api/kalshi/strike` asks for the page).
- **Polymarket US 5m (phone page, `/polymarket.html`)**: real buys and sales on Polymarket US's 5-minute BTC Up/Down rounds (the US exchange, polymarket.us, which settles on CF Benchmarks' BRTI), behind the same phone sign-in. **Trade** shows the clock, the price to beat and BTC now, buys Up or Down ($5 / $15 / $30 or another amount) as a limit order that fills at once or not at all, at most 2¢ over the best price, and lists what is held with Sell now. Every buy leaves its auto-sell on the book at the top profit less 10% (changeable or off on the page). Down is the round's Yes side sold, so every price sent is a Yes price; before the first order of each kind a preview checks that Polymarket US reads it as meant, and nothing is sent otherwise. **Plays** counts the plays made from this page and what they earned. The key: make one at polymarket.us/developer, save its Secret Key in a file on this computer, and give the Key ID and the file's path in ⚙ → Polymarket US trading, where real-money orders are switched on (off until then) and **Check orders** previews all four kinds without placing anything. Kept in `~/.cryptoanal/polymarket-us.json` (the key's path, never the secret) and `polymarket-us-plays.json`.
- **Status line** (the gear at top right), as TradingView's chart settings: switch off the logo, the symbol's title, the OHLC values, the bar change, or the indicators' titles, arguments and values in the legends of every chart — e.g. no "Bitcoin / U.S. Dollar" or "BTC" names on the chart.
- **Split screen** (the layout button at top right): 1 to 8 charts, each with its own symbol, interval, chart type and indicators. Click a chart to make it active; the toolbar acts on it. "Sync in layout" links symbol, interval, crosshair and time between charts. Drag the borders between charts to resize them (double-click a border to even it out); each layout remembers its sizes.
- **Floating windows** (V2's oscillator windows): every indicator with a pane of its own — RSI, MACD, Stochastic, Stoch RSI, CM_Ult_MacD_MTF, TMO Scalper, TMO [LuxAlgo], RSI Divergence, CCI and the rest — is either docked in its pane or floating, never both: floating it takes the pane away and docking it (the pane button on the card) puts the pane back. The floating card sits over the chart: a zoomed mini chart of its last bars (scaled around zero for MACD-style oscillators, levels shown once the scale reaches them), its values for the bar under the crosshair (or under the mouse in the card), and the call it is read for — overbought / oversold, a fresh signal, a cross, rising / falling. ± sets the bars, drag the plot (or ‹ ›) to walk back through history, minimize it to one line. Open one from its legend row's window button, the toolbar **Floating** menu, or **Alt+1…9** (Alt+0 for all). Overlays such as TUX, Support and Resistance or SMC mean something only on the candles, so they have none. Where each card sits, its bars and its minimized state are saved with the layout.
- **Forced flow** (Floating → Forced flow, or **Alt+F**), from btcAnalyzerV2: is the move on the chart leverage being force-closed? It reads the perpetual futures of the active chart's coin (BTC, ETH, SOL…; a Chainlink chart reads its coin's): open interest from OKX, Kraken, Deribit, Hyperliquid and Coinbase International every 15 s, funding, and liquidation prints streamed from OKX, Kraken, Deribit, Gate.io and Bitget (OKX's full list re-read every 30 s). Over the last five minutes it says **Longs being liquidated** or **Shorts being squeezed** ($100K+ force-closed on one side in a minute, or a big move with open interest falling past its 10th percentile), **New longs / shorts opening** (open interest past its 90th), **Big move, leverage steady**, or **No forced flow**; the thresholds are calibrated from five days of OKX five-minute history. Under it: price and open interest over 5m, liquidations in the last minute, funding (and which side is crowded), Coinbase spot taker flow against the perp premium (who led the move), Deribit options for the coming week (max pain, put/call, the biggest strikes), the latest prints and squeezes. It explains a move; it does not call the next one: in btcAnalyzerV2's 180-day backtest forced moves retraced no more often than any other move of the same size (the ⓘ panel has the numbers). Binance and Bybit refuse US connections, so totals are a floor. The bell chimes for each new squeeze; the transparency bar fades it, and the ⚡ brings it back while something is happening. Needs the dev server (`/api/forced-flow`, which reads the venues only while the window is open). Where it sits and its settings are saved with the workspace.
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
