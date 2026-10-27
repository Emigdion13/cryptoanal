/**
 * L&L Capital's TMO Scalper (the MTF scalping variant of Mobius's True Momentum Oscillator),
 * ported from btcAnalyzerV2 (src/lib/tmo-scalper.ts, as of 4fad720): three timeframes of TMO main/signal
 * pairs, gated cross arrows, and the extreme-only arrows. Legend (1, 5, 30, 14, 5, 3, 3, 2, 9, −9).
 */
import type { Candle } from '../../data/types'

/** Original Pine colors; TMO 1 crosses wear the published "TMO 1 Up / Down Signal" pair. */
export const TMO_COLORS = {
  tmo1Bull: '#27c22e',
  bear: '#ff0000',
  bull: '#27c22e',
  tmo2Bull: '#006400',
  tmo2Bear: '#800000',
  extremeBull: '#7cfc00',
  extremeBear: '#ff4081',
  zero: '#2a2e39',
} as const

/** The original's hard-coded display scale: plot(15*Main/tmolength). */
export const TMO_DISPLAY_SCALE = 15
/** The published hline levels ±15. */
export const TMO_CUTOFF = 15
/**
 * The published OB/OS fills run from the ±15 cutoffs to the hidden ±10 "OB Line" / "OS Line"
 * hlines; every fill (those two and each wheel's Main-to-Signal cloud) is color.new(…, 75).
 */
export const TMO_FILL_EDGE = 10
export const TMO_FILL_OPACITY = 0.25

/** The published TimeFrame options Coinbase data can build, with their length in seconds. */
export const TMO_RESOLUTIONS: Record<string, number> = {
  '1': 60,
  '2': 120,
  '3': 180,
  '5': 300,
  '10': 600,
  '15': 900,
  '20': 1200,
  '30': 1800,
  '45': 2700,
  '60': 3600,
  '120': 7200,
  '180': 10800,
  '240': 14400,
  D: 86400,
  '2D': 172800,
  '3D': 259200,
  '4D': 345600,
  W: 604800,
  '2W': 1209600,
  '3W': 1814400,
}

export interface TmoScalperSettings {
  tmoLength: number
  calcLength: number
  smoothLength: number
  signalOffset: number
  extremeOb: number
  extremeOs: number
}

type Values = (number | null)[]

const bucket = (time: number, seconds: number) => {
  const offset = seconds % 604800 === 0 ? 4 * 86400 : 0
  return Math.floor((time - offset) / seconds) * seconds + offset
}

const pineEma = (values: number[], length: number) => {
  const alpha = 2 / (length + 1)
  let previous = values[0]
  return values.map((value, i) => (previous = i === 0 ? value : alpha * value + (1 - alpha) * previous))
}

/**
 * The published recurrence on one timeframe's own candles:
 * data = Σ over i = 1..length−1 of sign(close − open[i]); EMA = ema(data, calc);
 * Main = ema(EMA, smooth); Signal = ema(Main, smooth). EMAs seeded with their first value.
 */
export function tmoNative(candles: readonly Candle[], s: TmoScalperSettings) {
  const data = candles.map((candle, i) => {
    let sum = 0
    for (let k = 1; k <= s.tmoLength - 1; k++) {
      const open = candles[i - k]?.open
      if (open === undefined) continue
      if (candle.close > open) sum += 1
      else if (candle.close < open) sum -= 1
    }
    return sum
  })
  const main = pineEma(pineEma(data, s.calcLength), s.smoothLength)
  return { times: candles.map((c) => c.time), main, signal: pineEma(main, s.smoothLength) }
}

/**
 * request.security(gaps_off, lookahead_off) as TradingView draws it on a loaded chart: a bigger
 * timeframe's bucket shows only from the chart bar that closes it (bars before still show the
 * previous bucket), so the line steps on each bucket's last bar; the newest bar shows its bucket
 * as it stands, moving tick by tick. A smaller timeframe reports its latest bar at or before the
 * chart bar.
 */
function project(native: ReturnType<typeof tmoNative>, chart: readonly Candle[], tfSeconds: number, chartSeconds: number) {
  const main: Values = []
  const signal: Values = []
  let cursor = -1
  for (let index = 0; index < chart.length; index++) {
    const candle = chart[index]
    let boundary = candle.time
    if (tfSeconds >= chartSeconds) {
      const start = bucket(candle.time, tfSeconds)
      const closesBucket = candle.time + chartSeconds >= start + tfSeconds
      // start − 1 admits only native bars that opened before this bucket: the previous one.
      boundary = closesBucket || index === chart.length - 1 ? start : start - 1
    }
    while (cursor + 1 < native.times.length && native.times[cursor + 1] <= boundary) cursor++
    main.push(cursor < 0 ? null : native.main[cursor])
    signal.push(cursor < 0 ? null : native.signal[cursor])
  }
  return { main, signal }
}

const crossOver = (a: Values, b: Values, i: number) =>
  i > 0 && a[i] !== null && b[i] !== null && a[i - 1] !== null && b[i - 1] !== null && a[i]! > b[i]! && a[i - 1]! <= b[i - 1]!
const crossUnder = (a: Values, b: Values, i: number) =>
  i > 0 && a[i] !== null && b[i] !== null && a[i - 1] !== null && b[i - 1] !== null && a[i]! < b[i]! && a[i - 1]! >= b[i - 1]!

export interface TmoScalperValues {
  main: [Values, Values, Values]
  signal: [Values, Values, Values]
  /** TMO 1 crosses gated by TMO 2, and TMO 2 crosses gated by TMO 3, at main ∓ offset. */
  bull1: Values
  bear1: Values
  bull2: Values
  bear2: Values
  /** The same crosses, only while the wheel itself is past its extreme level. */
  bull1Extreme: Values
  bear1Extreme: Values
  bull2Extreme: Values
  bear2Extreme: Values
}

/** `sources` are each timeframe's own bars (the chart's when it is the chart's resolution). */
export function calculateTmoScalper(
  chart: readonly Candle[],
  sources: [readonly Candle[], readonly Candle[], readonly Candle[]],
  seconds: [number, number, number],
  chartSeconds: number,
  s: TmoScalperSettings,
): TmoScalperValues {
  const scale = (values: Values) => values.map((v) => (v === null ? null : (TMO_DISPLAY_SCALE * v) / s.tmoLength))
  const legs = sources.map((source, k) => {
    if (!source.length) return { main: chart.map(() => null), signal: chart.map(() => null) }
    const p = project(tmoNative(source, s), chart, seconds[k], chartSeconds)
    return { main: scale(p.main), signal: scale(p.signal) }
  })
  const [m1, m2, m3] = legs.map((l) => l.main)
  const [s1, s2, s3] = legs.map((l) => l.signal)
  const out: TmoScalperValues = {
    main: [m1, m2, m3],
    signal: [s1, s2, s3],
    bull1: [],
    bear1: [],
    bull2: [],
    bear2: [],
    bull1Extreme: [],
    bear1Extreme: [],
    bull2Extreme: [],
    bear2Extreme: [],
  }
  for (let i = 0; i < chart.length; i++) {
    // A wheel's cross only counts while the next bigger wheel is turning the same way.
    const up1 = crossOver(m1, s1, i) && (m2[i] ?? -Infinity) > (s2[i] ?? Infinity)
    const down1 = crossUnder(m1, s1, i) && (m2[i] ?? Infinity) < (s2[i] ?? -Infinity)
    const up2 = crossOver(m2, s2, i) && (m3[i] ?? -Infinity) > (s3[i] ?? Infinity)
    const down2 = crossUnder(m2, s2, i) && (m3[i] ?? Infinity) < (s3[i] ?? -Infinity)
    out.bull1.push(up1 ? m1[i]! - s.signalOffset : null)
    out.bear1.push(down1 ? m1[i]! + s.signalOffset : null)
    out.bull2.push(up2 ? m2[i]! - s.signalOffset : null)
    out.bear2.push(down2 ? m2[i]! + s.signalOffset : null)
    out.bull1Extreme.push(up1 && m1[i]! < s.extremeOs ? m1[i]! - s.signalOffset : null)
    out.bear1Extreme.push(down1 && m1[i]! > s.extremeOb ? m1[i]! + s.signalOffset : null)
    out.bull2Extreme.push(up2 && m2[i]! < s.extremeOs ? m2[i]! - s.signalOffset : null)
    out.bear2Extreme.push(down2 && m2[i]! > s.extremeOb ? m2[i]! + s.signalOffset : null)
  }
  return out
}
