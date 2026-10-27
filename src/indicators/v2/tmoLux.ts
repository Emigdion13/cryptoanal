/**
 * LuxAlgo's "Triangular Momentum Oscillator & Real Time Divergences" (TMO [LuxAlgo]), ported from
 * btcAnalyzerV2 (src/lib/triangular-momentum-oscillator.ts). © LuxAlgo — CC BY-NC-SA 4.0. Not to
 * be confused with L&L Capital's TMO Scalper.
 *
 * - osc = mom(sma(sma(src, length), length), length): the momentum of a triangular average.
 * - A peak is crossunder(change(osc), 0), a trough crossover(change(osc), 0): the bar the
 *   oscillator turns, one bar after its extreme.
 * - Bearish divergence: a peak above zero lower than the previous peak while the length-bar
 *   highest source is higher than it was then; bullish is the mirror. Known on the turn bar.
 * - A line joins the previous turn to the divergence; Pine keeps the newest 50.
 */
import type { Candle } from '../../data/types'
import { highest, lowest, sma } from '../math'

export const TMO_LUX_COLORS = {
  /** Rising above zero; bullish circle, label and line. */
  up: '#00c42b',
  /** Falling above zero. */
  upFading: '#4ee567',
  /** Falling below zero; bearish circle, label and line. */
  down: '#ff441f',
  /** Rising below zero. */
  downFading: '#c03920',
} as const

const NA = 'rgba(0, 0, 0, 0)'
export const TMO_LUX_MAX_LINES = 50

/** The script's correlation gradient, −1 (red) to +1 (green), as it is pushed on the first bar. */
// prettier-ignore
const GRADIENT: readonly string[] = [
  '#FF1100', '#FF1200', '#FF1400', '#FF1500', '#FF1700', '#FF1800', '#FF1A00', '#FF1B00', '#FF1D00', '#FF1F00',
  '#FF2000', '#FF2200', '#FF2300', '#FF2500', '#FF2600', '#FF2800', '#FF2900', '#FF2B00', '#FF2D00', '#FF2E00',
  '#FF3000', '#FF3100', '#FF3300', '#FF3400', '#FF3600', '#FF3700', '#FF3900', '#FF3B00', '#FF3C00', '#FF3E00',
  '#FF3F00', '#FF4100', '#FF4200', '#FF4400', '#FF4500', '#FF4700', '#FF4900', '#FF4A00', '#FF4C00', '#FF4D00',
  '#FF4F00', '#FF5000', '#FF5200', '#FF5300', '#FF5500', '#FF5700', '#FF5800', '#FF5A00', '#FF5B00', '#FF5D00',
  '#FF5E00', '#FF6000', '#FF6200', '#FF6300', '#FF6500', '#FF6600', '#FF6800', '#FF6900', '#FF6B00', '#FF6C00',
  '#FF6E00', '#FF7000', '#FF7100', '#FF7300', '#FF7400', '#FF7600', '#FF7700', '#FF7900', '#FF7A00', '#FF7C00',
  '#FF7E00', '#FF7F00', '#FF8100', '#FF8200', '#FF8400', '#FF8500', '#FF8700', '#FF8800', '#FF8A00', '#FF8C00',
  '#FF8D00', '#FF8F00', '#FF9000', '#FF9200', '#FF9300', '#FF9500', '#FF9600', '#FF9800', '#FF9A00', '#FF9B00',
  '#FF9D00', '#FF9E00', '#FFA000', '#FFA100', '#FFA300', '#FFA400', '#FFA600', '#FFA800', '#FFA900', '#FFAB00',
  '#FDAC00', '#FBAD02', '#F9AE03', '#F7AE04', '#F5AF06', '#F3B007', '#F1B108', '#EFB20A', '#EDB30B', '#EBB30C',
  '#E9B40E', '#E7B50F', '#E4B610', '#E2B712', '#E0B813', '#DEB814', '#DCB916', '#DABA17', '#D8BB18', '#D6BC1A',
  '#D4BD1B', '#D2BD1C', '#D0BE1E', '#CEBF1F', '#CCC020', '#C9C122', '#C7C223', '#C5C224', '#C3C326', '#C1C427',
  '#BFC528', '#BDC62A', '#BBC72B', '#B9C72C', '#B7C82E', '#B5C92F', '#B3CA30', '#B0CB32', '#AECC33', '#ACCC34',
  '#AACD36', '#A8CE37', '#A6CF38', '#A4D03A', '#A2D13B', '#A0D13C', '#9ED23E', '#9CD33F', '#9AD440', '#98D542',
  '#95D643', '#93D644', '#91D746', '#8FD847', '#8DD948', '#8BDA4A', '#89DB4B', '#87DB4C', '#85DC4E', '#83DD4F',
  '#81DE50', '#7FDF52', '#7CE053', '#7AE054', '#78E156', '#76E257', '#74E358', '#72E45A', '#70E55B', '#6EE55C',
  '#6CE65E', '#6AE75F', '#68E860', '#66E962', '#64EA63', '#61EA64', '#5FEB66', '#5DEC67', '#5BED68', '#59EE6A',
  '#57EF6B', '#55EF6C', '#53F06E', '#51F16F', '#4FF270', '#4DF372', '#4BF473', '#48F474', '#46F576', '#44F677',
  '#42F778', '#40F87A', '#3EF97B', '#3CF97C', '#3AFA7E', '#38FB7F', '#36FC80', '#34FD82', '#32FE83', '#30FF85',
]


export interface TmoLuxLine {
  kind: 'bull' | 'bear'
  fromIndex: number
  fromValue: number
  toIndex: number
  toValue: number
}

export interface TmoLuxValues {
  osc: (number | null)[]
  bull: boolean[]
  bear: boolean[]
  colors: string[]
  /** Divergence lines still alive after the newest bar, oldest first. */
  lines: TmoLuxLine[]
}

/** Pine correlation(a, b, length): Pearson over the window, na if any value is missing. */
function correlation(a: (number | null)[], b: number[], length: number): (number | null)[] {
  return a.map((_, i) => {
    if (i < length - 1) return null
    let sa = 0,
      sb = 0
    for (let k = i - length + 1; k <= i; k++) {
      const x = a[k]
      if (x === null) return null
      sa += x
      sb += b[k]
    }
    const ma = sa / length,
      mb = sb / length
    let cov = 0,
      va = 0,
      vb = 0
    for (let k = i - length + 1; k <= i; k++) {
      const dx = a[k]! - ma,
        dy = b[k] - mb
      cov += dx * dy
      va += dx * dx
      vb += dy * dy
    }
    const d = Math.sqrt(va * vb)
    return d > 0 ? Math.min(1, Math.max(-1, cov / d)) : null
  })
}

/** simple_css: na when the oscillator is flat or exactly zero. */
export function tmoLuxSimpleColor(osc: number | null, previous: number | null): string {
  if (osc === null || previous === null) return NA
  if (osc > previous && osc > 0) return TMO_LUX_COLORS.up
  if (osc < previous && osc > 0) return TMO_LUX_COLORS.upFading
  if (osc < previous && osc < 0) return TMO_LUX_COLORS.down
  if (osc > previous && osc < 0) return TMO_LUX_COLORS.downFading
  return NA
}

const correlationColor = (value: number | null) =>
  value === null ? NA : GRADIENT[Math.min(199, Math.max(0, Math.round((0.5 * value + 0.5) * 199)))]

const nullable = (values: number[]) => values.map((v) => (Number.isFinite(v) ? v : null))

export function calculateTmoLux(
  candles: readonly Candle[],
  src: number[],
  length: number,
  showLines: boolean,
  correlationColors: boolean,
): TmoLuxValues {
  const up = nullable(highest(src, length))
  const dn = nullable(lowest(src, length))
  const triangular = nullable(sma(sma(src, length), length))
  const osc = triangular.map((value, i) => {
    const before = i >= length ? triangular[i - length] : null
    return value === null || before === null ? null : value - before
  })
  const change = osc.map((value, i) => (value === null || i === 0 || osc[i - 1] === null ? null : value - osc[i - 1]!))
  const peak = change.map((v, i) => v !== null && i > 0 && change[i - 1] !== null && v < 0 && change[i - 1]! >= 0)
  const trough = change.map((v, i) => v !== null && i > 0 && change[i - 1] !== null && v > 0 && change[i - 1]! <= 0)
  const above = (a: number | null | undefined, b: number | null | undefined) => a != null && b != null && a > b

  const bull: boolean[] = []
  const bear: boolean[] = []
  const lines: TmoLuxLine[] = []
  let lastPeak: number | null = null
  let lastTrough: number | null = null
  for (let i = 0; i < osc.length; i++) {
    const value = osc[i]
    // valuewhen(cond, x, 1) on a cond bar is the previous occurrence.
    const previousPeak = lastPeak
    const previousTrough = lastTrough
    if (peak[i]) lastPeak = i
    if (trough[i]) lastTrough = i
    const isBear =
      peak[i] && previousPeak !== null && above(value, 0) && above(osc[previousPeak], value) && above(up[i], up[previousPeak])
    const isBull =
      trough[i] && previousTrough !== null && above(0, value) && above(value, osc[previousTrough]) && above(dn[previousTrough], dn[i])
    bear.push(isBear)
    bull.push(isBull)
    if (showLines && (isBull || isBear)) {
      const from = isBull ? previousTrough! : previousPeak!
      lines.push({ kind: isBull ? 'bull' : 'bear', fromIndex: from, fromValue: osc[from]!, toIndex: i, toValue: value! })
    }
  }
  const cor = correlation(osc, candles.map((c) => c.close), length)
  return {
    osc,
    bull,
    bear,
    colors: osc.map((v, i) => (correlationColors ? correlationColor(v === null ? null : cor[i]) : tmoLuxSimpleColor(v, i > 0 ? osc[i - 1] : null))),
    lines: lines.slice(-TMO_LUX_MAX_LINES),
  }
}
