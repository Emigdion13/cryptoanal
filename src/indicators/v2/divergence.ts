/**
 * MACD histogram divergences, ported from btcAnalyzerV2 (src/lib/macd-divergence.ts) and shared
 * by MACD and CM_Ult_MacD_MTF. Consecutive confirmed pivots of the histogram are compared with
 * the price pivots on the same bars:
 *
 *   Regular bullish  price lower low   + histogram higher low   (reversal up)
 *   Regular bearish  price higher high + histogram lower high   (reversal down)
 *   Hidden  bullish  price higher low  + histogram lower low    (uptrend continues)
 *   Hidden  bearish  price lower high  + histogram higher high  (downtrend continues)
 *
 * A pivot is confirmed only after `pivotLookback` bars on each side, so the newest bars never
 * carry one; the mark sits on the confirming (second) pivot, as on TradingView.
 */
import type { Candle } from '../../data/types'
import type { Drawing, InputDef, InputValue } from '../types'

export const DIVERGENCE_COLORS = {
  regularBullish: '#26a69a',
  regularBearish: '#ef5350',
  hiddenBullish: '#66bb6a',
  hiddenBearish: '#ff7043',
} as const

export interface DivergenceSettings {
  showRegular: boolean
  showHidden: boolean
  /** Bars on each side of a histogram pivot required to confirm it. */
  pivotLookback: number
  /** Most bars between two compared pivots. */
  rangeUpper: number
  /** Fewest bars between two compared pivots. */
  rangeLower: number
  showLines: boolean
  showLabels: boolean
}

export interface Divergence {
  bullish: boolean
  hidden: boolean
  fromIndex: number
  toIndex: number
  fromValue: number
  toValue: number
  color: string
  label: string
}

const GROUP = 'Divergence'

/** The divergence inputs, the same on both MACDs. */
export const DIVERGENCE_INPUTS: InputDef[] = [
  { key: 'divRegular', label: 'Regular divergences', type: 'bool', default: true, group: GROUP },
  { key: 'divHidden', label: 'Hidden divergences', type: 'bool', default: true, group: GROUP },
  { key: 'divLookback', label: 'Pivot lookback', type: 'int', default: 5, min: 1, max: 1000, hideInTitle: true, group: GROUP },
  { key: 'divRangeUpper', label: 'Max bars between pivots', type: 'int', default: 60, min: 1, max: 1000, hideInTitle: true, group: GROUP },
  { key: 'divRangeLower', label: 'Min bars between pivots', type: 'int', default: 5, min: 1, max: 1000, hideInTitle: true, group: GROUP },
  { key: 'divLines', label: 'Show lines', type: 'bool', default: true, group: GROUP },
  { key: 'divLabels', label: 'Show labels', type: 'bool', default: true, group: GROUP },
]

export function divergenceSettings(i: Record<string, InputValue>): DivergenceSettings {
  return {
    showRegular: Boolean(i.divRegular),
    showHidden: Boolean(i.divHidden),
    pivotLookback: Number(i.divLookback),
    rangeUpper: Math.max(Number(i.divRangeUpper), Number(i.divRangeLower)),
    rangeLower: Number(i.divRangeLower),
    showLines: Boolean(i.divLines),
    showLabels: Boolean(i.divLabels),
  }
}

/**
 * Confirmed pivot lows/highs: strictly lower (higher) than the `lookback` bars on each side;
 * ties are not pivots, and bars without enough neighbours never are.
 */
export function pivotIndices(values: (number | null)[], lookback: number): { lows: boolean[]; highs: boolean[] } {
  const n = values.length
  const lows = new Array<boolean>(n).fill(false)
  const highs = new Array<boolean>(n).fill(false)
  if (lookback < 1) return { lows, highs }
  for (let i = lookback; i < n - lookback; i++) {
    const value = values[i]
    if (value === null || !Number.isFinite(value)) continue
    let isLow = true
    let isHigh = true
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue
      const other = values[j]
      if (other === null || !Number.isFinite(other)) {
        isLow = false
        isHigh = false
        break
      }
      if (other <= value) isLow = false
      if (other >= value) isHigh = false
    }
    lows[i] = isLow
    highs[i] = isHigh
  }
  return { lows, highs }
}

export function detectMacdDivergences(
  candles: readonly Candle[],
  histogram: (number | null)[],
  settings: DivergenceSettings,
): Divergence[] {
  if (!settings.showRegular && !settings.showHidden) return []
  const { lows, highs } = pivotIndices(histogram, settings.pivotLookback)
  const results: Divergence[] = []
  const inRange = (from: number, to: number) => to - from >= settings.rangeLower && to - from <= settings.rangeUpper

  let previousLow = -1
  for (let i = 0; i < histogram.length; i++) {
    if (!lows[i]) continue
    if (previousLow >= 0 && inRange(previousLow, i)) {
      const histFrom = histogram[previousLow]!,
        histTo = histogram[i]!
      const priceFrom = candles[previousLow].low,
        priceTo = candles[i].low
      const base = { bullish: true, fromIndex: previousLow, toIndex: i, fromValue: histFrom, toValue: histTo }
      if (settings.showRegular && priceTo < priceFrom && histTo > histFrom)
        results.push({ ...base, hidden: false, color: DIVERGENCE_COLORS.regularBullish, label: 'Bull' })
      else if (settings.showHidden && priceTo > priceFrom && histTo < histFrom)
        results.push({ ...base, hidden: true, color: DIVERGENCE_COLORS.hiddenBullish, label: 'H Bull' })
    }
    previousLow = i
  }

  let previousHigh = -1
  for (let i = 0; i < histogram.length; i++) {
    if (!highs[i]) continue
    if (previousHigh >= 0 && inRange(previousHigh, i)) {
      const histFrom = histogram[previousHigh]!,
        histTo = histogram[i]!
      const priceFrom = candles[previousHigh].high,
        priceTo = candles[i].high
      const base = { bullish: false, fromIndex: previousHigh, toIndex: i, fromValue: histFrom, toValue: histTo }
      if (settings.showRegular && priceTo > priceFrom && histTo < histFrom)
        results.push({ ...base, hidden: false, color: DIVERGENCE_COLORS.regularBearish, label: 'Bear' })
      else if (settings.showHidden && priceTo < priceFrom && histTo > histFrom)
        results.push({ ...base, hidden: true, color: DIVERGENCE_COLORS.hiddenBearish, label: 'H Bear' })
    }
    previousHigh = i
  }
  return results.sort((a, b) => a.toIndex - b.toIndex)
}

/** V2's look: a line between the two histogram pivots (dashed when hidden), the label at the second. */
export function divergenceDrawings(divergences: Divergence[], settings: DivergenceSettings): Drawing[] {
  const out: Drawing[] = []
  for (const d of divergences) {
    if (settings.showLines)
      out.push({
        type: 'line',
        x1: d.fromIndex,
        y1: d.fromValue,
        x2: d.toIndex,
        y2: d.toValue,
        color: d.color,
        width: 1.5,
        dash: d.hidden ? [4, 3] : undefined,
      })
    if (settings.showLabels)
      out.push({ type: 'text', x: d.toIndex, y: d.toValue, text: d.label, color: d.color, size: 9, weight: 400, dy: d.bullish ? 10 : -9 })
  }
  return out
}

/** Histogram values with NaN as null, the way the detector reads them. */
export const asNullable = (values: number[]): (number | null)[] => values.map((v) => (Number.isFinite(v) ? v : null))
