/**
 * ChrisMoody's original CM_MacD_Ult_MTF (April 2014), ported from btcAnalyzerV2
 * (src/lib/cm-ult-macd.ts): Pine v1 EMAs seeded with the first value, an SMA signal, the
 * 4-colour histogram, lime/red MACD line and the cross dots, on the chart's resolution or
 * another one (Pine v1 security, gaps off, lookahead on).
 *
 * Difference from V2: every bar is treated as historical. V2 also tracked the bars that arrived
 * live in a session and recomputed the open higher-timeframe bar on each of them; here an open
 * bar always shows its latest value, as V2 shows it after a reload.
 */
import type { Candle } from '../../data/types'

export const CM_COLORS = {
  aqua: '#00ffff',
  blue: '#0000ff',
  red: '#ff0000',
  maroon: '#800000',
  yellow: '#ffff00',
  gray: '#808080',
  lime: '#00ff00',
  white: '#ffffff',
} as const

/** V2's resolution choices, in seconds. */
export const CM_RESOLUTIONS: Record<string, number> = {
  '1': 60,
  '3': 180,
  '5': 300,
  '15': 900,
  '30': 1800,
  '60': 3600,
  '120': 7200,
  '240': 14400,
  D: 86400,
  W: 604800,
}

type Values = (number | null)[]

export interface CmMacdValues {
  macd: Values
  signal: Values
  histogram: Values
  /** The histogram one bar before on the MACD's own resolution: what each bar's colour is judged against. */
  histogramPrevious: Values
}

/** Legacy Pine v1/v2 ema(): seeded with the first value, not an SMA. */
export function pineEma(values: number[], length: number): number[] {
  const alpha = 2 / (length + 1)
  let previous = values[0]
  return values.map((value, i) => (previous = i === 0 ? value : alpha * value + (1 - alpha) * previous))
}

function sma(values: Values, period: number): Values {
  let sum = 0,
    valid = 0
  return values.map((value, i) => {
    if (value !== null && Number.isFinite(value)) {
      sum += value
      valid++
    }
    if (i >= period) {
      const old = values[i - period]
      if (old !== null && Number.isFinite(old)) {
        sum -= old
        valid--
      }
    }
    return i >= period - 1 && valid === period ? sum / period : null
  })
}

function nativeValues(candles: readonly Candle[], fastLength: number, slowLength: number, signalLength: number) {
  const closes = candles.map((c) => c.close)
  const fast = pineEma(closes, fastLength)
  const slow = pineEma(closes, slowLength)
  const macd = fast.map((value, i) => value - slow[i])
  const signal = sma(macd, signalLength)
  return { macd, signal, histogram: macd.map((value, i) => (signal[i] === null ? null : value - signal[i]!)) }
}

const bucket = (time: number, seconds: number) => {
  const offset = seconds % 604800 === 0 ? 4 * 86400 : 0
  return Math.floor((time - offset) / seconds) * seconds + offset
}

/**
 * MACD on `source` (bars of `sourceSeconds`), projected onto the chart's bars (`chartSeconds`).
 * Higher resolution: each chart bar takes its bucket's value. Lower: the first intrabar of the
 * chart bar (v1's historical security), the latest one on the newest bar.
 */
export function calculateCmMacd(
  chart: readonly Candle[],
  source: readonly Candle[],
  chartSeconds: number,
  sourceSeconds: number,
  lengths: { fast: number; slow: number; signal: number },
): CmMacdValues {
  const empty = () => chart.map(() => null)
  if (!source.length || !chart.length) return { macd: empty(), signal: empty(), histogram: empty(), histogramPrevious: empty() }
  const native = nativeValues(source, lengths.fast, lengths.slow, lengths.signal)
  if (source === chart)
    return {
      macd: native.macd,
      signal: native.signal,
      histogram: native.histogram,
      histogramPrevious: native.histogram.map((_, i) => native.histogram[i - 1] ?? null),
    }
  const result: CmMacdValues = { macd: [], signal: [], histogram: [], histogramPrevious: [] }
  const append = (i: number | null, previous: number | null) => {
    result.macd.push(i === null ? null : native.macd[i])
    result.signal.push(i === null ? null : native.signal[i])
    result.histogram.push(i === null ? null : native.histogram[i])
    result.histogramPrevious.push(previous)
  }
  let cursor = -1
  const lastChart = chart[chart.length - 1]
  for (const candle of chart) {
    if (sourceSeconds > chartSeconds) {
      const start = bucket(candle.time, sourceSeconds)
      while (cursor + 1 < source.length && source[cursor + 1].time <= start) cursor++
      if (cursor < 0) append(null, null)
      else append(cursor, native.histogram[cursor - 1] ?? null)
    } else {
      while (cursor + 1 < source.length && source[cursor + 1].time < candle.time) cursor++
      let selected = cursor
      if (cursor + 1 < source.length && source[cursor + 1].time < candle.time + chartSeconds) selected = cursor + 1
      if (candle === lastChart)
        while (selected + 1 < source.length && source[selected + 1].time < candle.time + chartSeconds) selected++
      // No coverage implied for chart bars older than the loaded lower-timeframe window.
      if (selected < 0 || candle.time < source[0].time) append(null, result.histogram[result.histogram.length - 1] ?? null)
      else append(selected, result.histogram[result.histogram.length - 1] ?? null)
    }
  }
  return result
}

export function cmHistogramColor(value: number | null, previous: number | null, change = true): string {
  if (!change) return CM_COLORS.gray
  if (value !== null && previous !== null) {
    if (value > previous && value > 0) return CM_COLORS.aqua
    if (value < previous && value > 0) return CM_COLORS.blue
    if (value < previous && value <= 0) return CM_COLORS.red
    if (value > previous && value <= 0) return CM_COLORS.maroon
  }
  // Strict comparisons in the original: flat and unavailable comparisons are yellow.
  return CM_COLORS.yellow
}

/** Cross dots: where MACD crosses its signal, plotted on the signal. */
export function cmCrosses(values: CmMacdValues): Values {
  const { macd, signal } = values
  return macd.map((value, i) => {
    if (i === 0 || value === null || signal[i] === null || macd[i - 1] === null || signal[i - 1] === null) return null
    const delta = value - signal[i]!
    const previous = macd[i - 1]! - signal[i - 1]!
    return (delta > 0 && previous <= 0) || (delta < 0 && previous >= 0) ? signal[i] : null
  })
}
