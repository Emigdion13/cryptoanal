/**
 * "TUX EMA Scalper+SuperTrend" by LARIANE (TradingView, protected source, 2019), cloned from
 * what it is built of and checked against TradingView's own output (fixtures/tux-tradingview.json):
 *
 *   TonyUX EMA Scalper by tux (open source, Pine v1):
 *     out = ema(src, len); plot(out, blue)
 *     plot(highest(close, 8)) / plot(lowest(close, 8))      — LARIANE colours: deep pink / light green
 *     bearish = cross(close, out) and close[1] > close       — "Sell", arrowdown above the bar
 *     bullish = cross(close, out) and close[1] < close       — "Buy", arrowup below the bar
 *   (cross means either direction: the bar's own close decides which label prints.)
 *
 *   Supertrend V1.0 (Factor 3, Pd 7; the "3 7" of the legend):
 *     Up = hl2 − Factor·atr(Pd);  Dn = hl2 + Factor·atr(Pd)
 *     TrendUp = close[1] > TrendUp[1] ? max(Up, TrendUp[1]) : Up
 *     TrendDown = close[1] < TrendDown[1] ? min(Dn, TrendDown[1]) : Dn
 *     Trend = close > TrendDown[1] ? 1 : close < TrendUp[1] ? −1 : nz(Trend[1], 1)
 *     Tsl = Trend == 1 ? TrendUp : TrendDown                 — green / red, width 2
 *     plotshape(cross(close, Tsl) and close > Tsl)           — small green triangle below the bar
 *     plotshape(cross(Tsl, close) and close < Tsl)           — small red triangle above the bar
 *     plotarrow(Trend flips up: 1 / down: −1)                — tall lime / red entry arrows
 *
 * Legacy Pine (v1) averages: ema and atr's rma start from the first value, not an SMA. Any
 * difference that makes fades within a few dozen bars, before the chart's visible history.
 */
import type { Candle } from '../data/types'

export interface TuxValues {
  tsl: number[]
  /** 1 up, −1 down. */
  trend: number[]
  upArrow: boolean[]
  downArrow: boolean[]
  entryUp: boolean[]
  entryDown: boolean[]
  ema: number[]
  highest: number[]
  lowest: number[]
  sell: boolean[]
  buy: boolean[]
}

/** Legacy Pine ema/rma: the first value seeds the average. */
function smooth(values: number[], alpha: number): number[] {
  let prev = NaN
  return values.map((v) => (prev = Number.isNaN(prev) ? v : alpha * v + (1 - alpha) * prev))
}

const gt = (a: number, b: number) => a > b // false when either is NaN, as Pine's na comparisons
const lt = (a: number, b: number) => a < b

/** Pine cross(a, b): a crossed b in either direction on this bar. */
function cross(a: number[], b: number[], i: number): boolean {
  if (i === 0) return false
  return (gt(a[i], b[i]) && !gt(a[i - 1], b[i - 1]) && !Number.isNaN(a[i - 1] - b[i - 1])) ||
    (lt(a[i], b[i]) && !lt(a[i - 1], b[i - 1]) && !Number.isNaN(a[i - 1] - b[i - 1]))
}

function window(values: number[], length: number, pick: (a: number, b: number) => number): number[] {
  return values.map((_, i) => {
    if (i < length - 1) return NaN
    let m = values[i]
    for (let k = i - length + 1; k < i; k++) m = pick(m, values[k])
    return m
  })
}

export function calculateTux(
  bars: readonly Candle[],
  settings: { factor: number; pd: number; length: number; source: number[] },
): TuxValues {
  const n = bars.length
  const close = bars.map((b) => b.close)
  const tr = bars.map((b, i) =>
    i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)),
  )
  const atr = smooth(tr, 1 / settings.pd)

  const tsl: number[] = []
  const trend: number[] = []
  let trendUp = NaN,
    trendDown = NaN
  for (let i = 0; i < n; i++) {
    const hl2 = (bars[i].high + bars[i].low) / 2
    const up = hl2 - settings.factor * atr[i]
    const dn = hl2 + settings.factor * atr[i]
    const prevClose = i > 0 ? close[i - 1] : NaN
    const prevUp = trendUp,
      prevDown = trendDown
    trendUp = gt(prevClose, prevUp) ? Math.max(up, prevUp) : up
    trendDown = lt(prevClose, prevDown) ? Math.min(dn, prevDown) : dn
    const t = gt(close[i], prevDown) ? 1 : lt(close[i], prevUp) ? -1 : (trend[i - 1] ?? 1)
    trend.push(t)
    tsl.push(t === 1 ? trendUp : trendDown)
  }

  const ema = smooth(settings.source, 2 / (settings.length + 1))
  const highest = window(close, 8, Math.max)
  const lowest = window(close, 8, Math.min)

  const out: TuxValues = {
    tsl,
    trend,
    upArrow: [],
    downArrow: [],
    entryUp: [],
    entryDown: [],
    ema,
    highest,
    lowest,
    sell: [],
    buy: [],
  }
  for (let i = 0; i < n; i++) {
    out.upArrow.push(cross(close, tsl, i) && close[i] > tsl[i])
    out.downArrow.push(cross(tsl, close, i) && close[i] < tsl[i])
    out.entryUp.push(i > 0 && trend[i] === 1 && trend[i - 1] === -1)
    out.entryDown.push(i > 0 && trend[i] === -1 && trend[i - 1] === 1)
    const crossed = cross(close, ema, i)
    out.sell.push(crossed && i > 0 && close[i - 1] > close[i])
    out.buy.push(crossed && i > 0 && close[i - 1] < close[i])
  }
  return out
}
