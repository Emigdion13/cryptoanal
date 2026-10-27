/**
 * "Support and Resistance Levels with Breaks [LuxAlgo]" (TradingView, open source, Pine v4;
 * © LuxAlgo, CC BY-NC-SA 4.0), cloned line for line:
 *
 *   highUsePivot = fixnan(pivothigh(leftBars, rightBars)[1])
 *   lowUsePivot  = fixnan(pivotlow(leftBars, rightBars)[1])
 *   plot(highUsePivot, color = change(highUsePivot) ? na : #FF0000, linewidth 3, offset = −(rightBars + 1))
 *   plot(lowUsePivot,  color = change(lowUsePivot)  ? na : #233dee, linewidth 3, offset = −(rightBars + 1))
 *   osc = 100 · (ema(volume, 5) − ema(volume, 10)) / ema(volume, 10)
 *   "B" (labeldown, red, above):    crossunder(close, low)  and not (open − close < high − open) and osc > thresh
 *   "B" (labelup, green, below):    crossover(close, high)  and not (open − low > close − open)  and osc > thresh
 *   "Bull Wick" (labelup, green):   crossover(close, high)  and open − low > close − open
 *   "Bear Wick" (labeldown, red):   crossunder(close, low)  and open − close < high − open
 *
 * Checked against TradingView's own output on the script page's chart (COINBASE:ETHUSD 4h).
 */
import type { Candle } from '../data/types'
import type { Drawing, IndicatorDef } from './types'

export interface LuxSrValues {
  /** Raw levels on the bar they are known (before the plot's offset). */
  resistance: number[]
  support: number[]
  osc: number[]
  breakDown: boolean[]
  breakUp: boolean[]
  bullWick: boolean[]
  bearWick: boolean[]
}

/**
 * Pine's pivothigh/pivotlow: on bar i, the value of bar i − right when it is strictly above
 * (below) the `left` bars before it and at least as high (low) as the `right` bars after it —
 * ties to its right still make it the pivot, ties to its left do not.
 */
export function pivots(values: number[], left: number, right: number, high: boolean): number[] {
  const out = new Array<number>(values.length).fill(NaN)
  for (let i = left + right; i < values.length; i++) {
    const p = i - right
    const v = values[p]
    let ok = true
    for (let k = p - left; k < p && ok; k++) ok = high ? v > values[k] : v < values[k]
    for (let k = p + 1; k <= i && ok; k++) ok = high ? v >= values[k] : v <= values[k]
    if (ok) out[i] = v
  }
  return out
}

/** Pine v4 ema: SMA seed, then the usual recursion. */
function ema(values: number[], length: number): number[] {
  const alpha = 2 / (length + 1)
  let prev = NaN
  let sum = 0
  return values.map((v, i) => {
    if (i < length - 1) {
      sum += v
      return NaN
    }
    if (i === length - 1) return (prev = (sum + v) / length)
    return (prev = alpha * v + (1 - alpha) * prev)
  })
}

/** fixnan(x[1]): the previous bar's value, or the last one before it that was not na. */
function fixnanPrevious(values: number[]): number[] {
  let last = NaN
  return values.map((_, i) => {
    const v = i > 0 ? values[i - 1] : NaN
    if (!Number.isNaN(v)) last = v
    return last
  })
}

const crossover = (a: number[], b: number[], i: number) => i > 0 && a[i] > b[i] && a[i - 1] <= b[i - 1]
const crossunder = (a: number[], b: number[], i: number) => i > 0 && a[i] < b[i] && a[i - 1] >= b[i - 1]

export function calculateLuxSr(
  bars: readonly Candle[],
  settings: { leftBars: number; rightBars: number; volumeThresh: number },
): LuxSrValues {
  const { leftBars, rightBars, volumeThresh } = settings
  const high = bars.map((b) => b.high)
  const low = bars.map((b) => b.low)
  const close = bars.map((b) => b.close)
  const resistance = fixnanPrevious(pivots(high, leftBars, rightBars, true))
  const support = fixnanPrevious(pivots(low, leftBars, rightBars, false))
  const volume = bars.map((b) => b.volume)
  const short = ema(volume, 5)
  const long = ema(volume, 10)
  const osc = short.map((s, i) => (100 * (s - long[i])) / long[i])
  const out: LuxSrValues = { resistance, support, osc, breakDown: [], breakUp: [], bullWick: [], bearWick: [] }
  bars.forEach((b, i) => {
    const down = crossunder(close, support, i)
    const up = crossover(close, resistance, i)
    const bearish = b.open - b.close < b.high - b.open
    const bullish = b.open - b.low > b.close - b.open
    out.breakDown.push(down && !bearish && osc[i] > volumeThresh)
    out.breakUp.push(up && !bullish && osc[i] > volumeThresh)
    out.bullWick.push(up && bullish)
    out.bearWick.push(down && bearish)
  })
  return out
}

// ── the indicator ───────────────────────────────────────────────────────────

/** Pine v4's color.red / color.green, which the labels use. */
const V4_RED = '#ff5252'
const V4_GREEN = '#4caf50'

/** Plotted `offset` bars back, as Pine's plot(offset = −n): bar i shows the value of bar i + n. */
const shiftBack = <T,>(values: T[], n: number, missing: T): T[] => values.map((_, i) => values[i + n] ?? missing)

export const luxSrBreaks: IndicatorDef = {
  type: 'luxSrBreaks',
  name: 'Support and Resistance Levels with Breaks [LuxAlgo]',
  short: 'Support and Resistance Levels with Breaks [LuxAlgo]',
  category: 'Price Action',
  overlay: true,
  format: 'price',
  inputs: [
    { key: 'toggleBreaks', label: 'Show Breaks', type: 'bool', default: true },
    { key: 'leftBars', label: 'Left Bars', type: 'int', default: 15, min: 1, max: 500 },
    { key: 'rightBars', label: 'Right Bars', type: 'int', default: 15, min: 1, max: 500 },
    { key: 'volumeThresh', label: 'Volume Threshold', type: 'float', default: 20, min: -1000, max: 1000 },
  ],
  plots: [
    { key: 'resistance', title: 'Resistance', kind: 'line', color: '#ff0000', width: 3 },
    { key: 'support', title: 'Support', kind: 'line', color: '#233dee', width: 3 },
    { key: 'breakDown', title: 'Break', kind: 'value', color: V4_RED },
    { key: 'breakUp', title: 'Break', kind: 'value', color: V4_GREEN },
    { key: 'bullWick', title: 'Break', kind: 'value', color: V4_GREEN },
    { key: 'bearWick', title: 'Break', kind: 'value', color: V4_RED },
  ],
  compute: (bars, i, st) => {
    const right = Math.max(1, Math.round(Number(i.rightBars)))
    const v = calculateLuxSr(bars, {
      leftBars: Math.max(1, Math.round(Number(i.leftBars))),
      rightBars: right,
      volumeThresh: Number(i.volumeThresh),
    })
    const shift = right + 1
    // color = change(level) ? na : colour — the line breaks where the level moves.
    const colors = (raw: number[], color: string) =>
      shiftBack(raw.map((x, k) => (k > 0 && x !== raw[k - 1] ? 'rgba(0, 0, 0, 0)' : color)), shift, 'rgba(0, 0, 0, 0)')
    const on = Boolean(i.toggleBreaks)
    const flags = (xs: boolean[]) => xs.map((x) => (on && x ? 1 : 0))
    const drawings: Drawing[] = []
    if (on)
      bars.forEach((b, x) => {
        const label = (shape: 'labelUp' | 'labelDown', text: string, key: string) =>
          st[key]?.visible !== false &&
          drawings.push({ type: 'shape', shape, x, y: shape === 'labelUp' ? b.low : b.high, offset: 4, color: st[key].color, text })
        if (v.breakDown[x]) label('labelDown', 'B', 'breakDown')
        if (v.breakUp[x]) label('labelUp', 'B', 'breakUp')
        if (v.bullWick[x]) label('labelUp', 'Bull Wick', 'bullWick')
        if (v.bearWick[x]) label('labelDown', 'Bear Wick', 'bearWick')
      })
    return {
      values: {
        resistance: shiftBack(v.resistance, shift, NaN),
        support: shiftBack(v.support, shift, NaN),
        breakDown: flags(v.breakDown),
        breakUp: flags(v.breakUp),
        bullWick: flags(v.bullWick),
        bearWick: flags(v.bearWick),
      },
      colors: { resistance: colors(v.resistance, st.resistance.color), support: colors(v.support, st.support.color) },
      drawings,
    }
  },
}
