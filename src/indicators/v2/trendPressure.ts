/**
 * Zeiierman's "Trend Pressure (Zeiierman)" (Pine v6), ported from btcAnalyzerV2
 * (src/lib/zeiierman-trend-pressure.ts). © Zeiierman — CC BY-NC-SA 4.0.
 *
 * Everything lives on a 0 to −100 scale (Williams %R-style readings of where the close sits in
 * its range):
 * - Z-Pulse: the fast range reading blended with its own stochastic, smoothed.
 * - Z-Trend: fast, mid and macro range readings weighted together, held by directional
 *   persistence and updated slower when the horizons agree and price moves efficiently.
 * - Pressure Core: candle anatomy (close in range, body, wicks, 5-bar change) at a reactive (21)
 *   and a regime (112) horizon, bull / bear / neutral coloured.
 * - Exhaustion: pulse and trend both past the upper (or lower) pressure level for a few bars
 *   confirms upper (lower) pressure; both coming back past it by the rebound releases it. A box
 *   on the price chart spans the bars it held.
 */
import type { Candle } from '../../data/types'

export interface TrendPressureSettings {
  pulseRange: number
  pulseStochastic: number
  pulseSmoothing: number
  trendRange: number
  macroTrend: number
  trendSmoothing: number
  trendPersistence: number
  exhaustionZone: number
  sensitivity: number
  reactiveSmoothing: number
  regimeWeight: number
  maxBoxes: number
}

export const TREND_PRESSURE_DEFAULTS: Readonly<TrendPressureSettings> = {
  pulseRange: 21,
  pulseStochastic: 9,
  pulseSmoothing: 7,
  trendRange: 55,
  macroTrend: 120,
  trendSmoothing: 5,
  trendPersistence: 9,
  exhaustionZone: 20,
  sensitivity: 7,
  reactiveSmoothing: 16,
  regimeWeight: 0.65,
  maxBoxes: 60,
}

export const TREND_PRESSURE_COLORS = {
  cold: '#2962ff',
  hot: '#e6283e',
  pulse: '#e5e7eb',
  trend: '#8baeff',
  coreBull: '#40e3c3',
  coreBear: '#df5141',
  coreNeutral: '#c0c0c0',
  equilibrium: '#777777',
} as const

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
type Values = (number | null)[]

/** Pine ta.ema seeded on the first value; na does not reset it. */
function ema(values: Values, length: number): Values {
  let previous: number | null = null
  const alpha = 2 / (length + 1)
  return values.map((v) => {
    if (v === null) return null
    previous = previous === null ? v : previous + alpha * (v - previous)
    return previous
  })
}

/** V2's window extreme: over the bars there are (a short window at the start), skipping na. */
function extreme(values: Values, k: number, sign: 1 | -1): Values {
  return values.map((_, i) => {
    let best: number | null = null
    for (let j = Math.max(0, i - k + 1); j <= i; j++) {
      const v = values[j]
      if (v !== null && (best === null || sign * v > sign * best)) best = v
    }
    return best
  })
}
const highest = (values: Values, k: number) => extreme(values, k, 1)
const lowest = (values: Values, k: number) => extreme(values, k, -1)

function sma(values: Values, k: number): Values {
  return values.map((_, i) => {
    if (i < k - 1) return null
    let sum = 0
    for (let j = i - k + 1; j <= i; j++) {
      const v = values[j]
      if (v === null) return null
      sum += v
    }
    return sum / k
  })
}

export interface PressureBox {
  start: number
  end: number
  top: number
  bottom: number
  side: 'upper' | 'lower'
}

export interface TrendPressureValues {
  pulse: Values
  trend: Values
  core: Values
  /** 'bull', 'bear' or 'neutral' per bar. */
  coreTone: ('bull' | 'bear' | 'neutral')[]
  upper: number
  lower: number
  upperActive: boolean[]
  lowerActive: boolean[]
  upperStart: boolean[]
  lowerStart: boolean[]
  upperRelease: boolean[]
  lowerRelease: boolean[]
  crossUp: boolean[]
  crossDown: boolean[]
  boxes: PressureBox[]
  upperReleasePrice: Values
  lowerReleasePrice: Values
}

/** `tick` is the market's price increment (Pine's syminfo.mintick). */
export function calculateTrendPressure(candles: readonly Candle[], s: TrendPressureSettings, tick = 1e-8): TrendPressureValues {
  if (!(tick > 0) || !Number.isFinite(tick)) tick = 1e-8
  const high = candles.map((c) => c.high),
    low = candles.map((c) => c.low)
  const close = candles.map((c) => c.close)
  const wr = (k: number) => {
    const hi = highest(high, k),
      lo = lowest(low, k)
    return close.map((v, i) => (100 * (v - hi[i]!)) / Math.max(hi[i]! - lo[i]!, tick))
  }
  const fast = wr(s.pulseRange),
    mid = wr(s.trendRange),
    macro = wr(s.macroTrend)
  const rfHi = highest(fast, s.pulseStochastic),
    rfLo = lowest(fast, s.pulseStochastic)
  const raw = fast.map((v, i) => clamp(v * 0.72 + (-100 + (100 * (v - rfLo[i]!)) / Math.max(rfHi[i]! - rfLo[i]!, 1e-10)) * 0.28, -100, 0))
  const pulse = s.pulseSmoothing > 1 ? ema(raw, s.pulseSmoothing) : raw
  const weight = 1 - 0.18 - 0.72
  const consensus = fast.map((v, i) => clamp(v * weight + mid[i] * 0.18 + macro[i] * 0.72, -100, 0))
  const agreement = fast.map((v, i) => 1 - clamp((Math.abs(v - mid[i]) + Math.abs(mid[i] - macro[i]) + Math.abs(v - macro[i])) / 300, 0, 1))
  const change = close.map((v, i) => (i ? Math.abs(v - close[i - 1]) : null))
  const path = sma(change, s.trendRange)
  const efficiency = close.map((v, i) =>
    i < s.trendRange || path[i] === null ? 0 : clamp(Math.abs(v - close[i - s.trendRange]) / Math.max(path[i]! * s.trendRange, tick), 0, 1),
  )
  let upHold = 0,
    downHold = 0
  const target = consensus.map((v) => {
    upHold = v > -30 ? Math.min(1, upHold * 0.93 + 0.07) : upHold * 0.94
    downHold = v < -70 ? Math.min(1, downHold * 0.93 + 0.07) : downHold * 0.94
    return clamp(v + s.trendPersistence * (upHold - downHold), -100, 0)
  })
  const smoothedTarget = ema(target, 2)
  const base = 2 / (s.trendSmoothing + 1)
  const trend: Values = []
  smoothedTarget.forEach((v, i) => {
    if (i === 0) {
      trend.push(v)
      return
    }
    const prev = trend[i - 1]!
    const side = macro[i] > -50 ? 1 : macro[i] < -50 ? -1 : 0
    const pull = (side === 1 && v! < prev) || (side === -1 && v! > prev)
    const lock = clamp(0.15 + agreement[i] * efficiency[i] * 0.92, 0, 0.97)
    const alpha = pull ? Math.max(0.015, base * (1 - lock)) : Math.max(base * 0.75, 0.03)
    trend.push(clamp(prev + alpha * (v! - prev), -100, 0))
  })
  // Pine `prs(k)`: the same candle anatomy at the reactive (21) and regime (112) horizons.
  const pressureAt = (k: number): number[] => {
    const hi = highest(high, k),
      lo = lowest(low, k)
    return candles.map((c, i) => {
      const range = Math.max(hi[i]! - lo[i]!, tick)
      const candleRange = Math.max(c.high - c.low, tick)
      const upperWick = c.high - Math.max(c.open, c.close)
      const lowerWick = Math.min(c.open, c.close) - c.low
      return clamp(
        (((c.close - lo[i]!) / range) * 0.42 +
          (((c.high + c.low + c.close) / 3 - lo[i]!) / range) * 0.23 +
          ((c.close - c.open) / candleRange + 1) * 0.5 * 0.13 +
          ((lowerWick - upperWick) / candleRange + 1) * 0.5 * 0.12 +
          ((c.close - (close[i - 5] ?? c.close)) / range + 1) * 0.5 * 0.1) *
          100,
        0,
        100,
      )
    })
  }
  const pressure = pressureAt(21)
  const reactive = ema(pressure, s.reactiveSmoothing)
  const regime = ema(pressureAt(112), 3)
  const core = pressure.map((_, i) => regime[i]! * s.regimeWeight + reactive[i]! * (1 - s.regimeWeight) - 100)
  const coreTone = core.map((v, i) => (v! > -50 && regime[i]! > 50 ? 'bull' : v! < -50 && regime[i]! < 50 ? 'bear' : 'neutral') as 'bull' | 'bear' | 'neutral')

  const d = s.sensitivity - 5,
    zone = clamp(s.exhaustionZone - d * 4, 8, 42)
  const rebound = clamp(8 + d * 1.75, 1, 18),
    upper = -zone,
    lower = -100 + zone
  const confirm = s.sensitivity <= 5 ? 1 : s.sensitivity <= 7 ? 2 : s.sensitivity <= 9 ? 3 : 4
  let state = 0,
    upperCount = 0,
    lowerCount = 0
  const upperActive: boolean[] = [],
    lowerActive: boolean[] = [],
    upperStart: boolean[] = [],
    lowerStart: boolean[] = []
  const upperRelease: boolean[] = [],
    lowerRelease: boolean[] = [],
    crossUp: boolean[] = [],
    crossDown: boolean[] = []
  const boxes: PressureBox[] = []
  const upperReleasePrice: Values = [],
    lowerReleasePrice: Values = []
  let activeBox: PressureBox | null = null
  candles.forEach((c, i) => {
    const p = pulse[i],
      t = trend[i]
    upperCount = p !== null && t !== null && p >= upper && t >= upper ? upperCount + 1 : 0
    lowerCount = p !== null && t !== null && p <= lower && t <= lower ? lowerCount + 1 : 0
    const before = state
    if (!state) {
      if (upperCount >= confirm) state = 1
      else if (lowerCount >= confirm) state = -1
    } else if (p !== null && t !== null) {
      const fast = s.sensitivity <= 2
      if (state === 1 && (fast ? p < upper - rebound || t < upper - rebound : p < upper - rebound && t < upper - rebound)) state = 0
      else if (state === -1 && (fast ? p > lower + rebound || t > lower + rebound : p > lower + rebound && t > lower + rebound)) state = 0
    }
    upperActive.push(state === 1)
    lowerActive.push(state === -1)
    upperStart.push(state === 1 && before !== 1)
    lowerStart.push(state === -1 && before !== -1)
    upperRelease.push(state === 0 && before === 1)
    lowerRelease.push(state === 0 && before === -1)
    upperReleasePrice.push(state === 0 && before === 1 && activeBox ? activeBox.top : null)
    lowerReleasePrice.push(state === 0 && before === -1 && activeBox ? activeBox.bottom : null)
    crossUp.push(i > 0 && p !== null && pulse[i - 1] !== null && p > t! && pulse[i - 1]! <= trend[i - 1]!)
    crossDown.push(i > 0 && p !== null && pulse[i - 1] !== null && p < t! && pulse[i - 1]! >= trend[i - 1]!)
    if (state !== before && state !== 0) {
      activeBox = { start: i, end: i, top: c.high, bottom: c.low, side: state === 1 ? 'upper' : 'lower' }
      boxes.push(activeBox)
    } else if (activeBox && state !== 0) {
      activeBox.end = i
      activeBox.top = Math.max(activeBox.top, c.high)
      activeBox.bottom = Math.min(activeBox.bottom, c.low)
    } else if (state === 0) activeBox = null
  })
  return {
    pulse,
    trend,
    core,
    coreTone,
    upper,
    lower,
    upperActive,
    lowerActive,
    upperStart,
    lowerStart,
    upperRelease,
    lowerRelease,
    crossUp,
    crossDown,
    boxes: boxes.slice(-s.maxBoxes),
    upperReleasePrice,
    lowerReleasePrice,
  }
}
