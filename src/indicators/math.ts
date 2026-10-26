/**
 * Technical-analysis building blocks with Pine Script's semantics: arrays are oldest first,
 * NaN stands for Pine's `na`, and averages seed the way TradingView's built-ins do.
 */
import type { Candle } from '../data/types'

export type Series = number[]

const nan = (n: number): Series => new Array<number>(n).fill(NaN)

export type Source = 'open' | 'high' | 'low' | 'close' | 'hl2' | 'hlc3' | 'ohlc4' | 'hlcc4'
export const SOURCES: Source[] = ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'hlcc4']

export function source(bars: readonly Candle[], src: Source): Series {
  switch (src) {
    case 'open':
      return bars.map((b) => b.open)
    case 'high':
      return bars.map((b) => b.high)
    case 'low':
      return bars.map((b) => b.low)
    case 'hl2':
      return bars.map((b) => (b.high + b.low) / 2)
    case 'hlc3':
      return bars.map((b) => (b.high + b.low + b.close) / 3)
    case 'ohlc4':
      return bars.map((b) => (b.open + b.high + b.low + b.close) / 4)
    case 'hlcc4':
      return bars.map((b) => (b.high + b.low + 2 * b.close) / 4)
    default:
      return bars.map((b) => b.close)
  }
}

/** Index of the first finite value, or the length. */
function firstValid(src: Series): number {
  let i = 0
  while (i < src.length && !Number.isFinite(src[i])) i++
  return i
}

export function sma(src: Series, len: number): Series {
  const out = nan(src.length)
  let sum = 0,
    count = 0
  for (let i = 0; i < src.length; i++) {
    const v = src[i]
    if (!Number.isFinite(v)) {
      sum = 0
      count = 0
      continue
    }
    sum += v
    count++
    if (count > len) sum -= src[i - len]
    if (count >= len) out[i] = sum / len
  }
  return out
}

/** Exponential average with smoothing `alpha`, seeded with the simple average of the first `len`. */
function smoothed(src: Series, len: number, alpha: number): Series {
  const out = nan(src.length)
  const start = firstValid(src)
  if (start + len > src.length) return out
  let prev = 0
  for (let i = start; i < start + len; i++) prev += src[i]
  prev /= len
  out[start + len - 1] = prev
  for (let i = start + len; i < src.length; i++) {
    const v = src[i]
    if (!Number.isFinite(v)) continue
    prev = alpha * v + (1 - alpha) * prev
    out[i] = prev
  }
  return out
}

export const ema = (src: Series, len: number) => smoothed(src, len, 2 / (len + 1))
/** Wilder's moving average (ta.rma). */
export const rma = (src: Series, len: number) => smoothed(src, len, 1 / len)

export function wma(src: Series, len: number): Series {
  const out = nan(src.length)
  const norm = (len * (len + 1)) / 2
  for (let i = len - 1; i < src.length; i++) {
    let sum = 0
    for (let k = 0; k < len; k++) sum += src[i - k] * (len - k)
    out[i] = sum / norm
  }
  return out
}

export function hma(src: Series, len: number): Series {
  const half = wma(src, Math.max(1, Math.floor(len / 2)))
  const full = wma(src, len)
  return wma(
    half.map((h, i) => 2 * h - full[i]),
    Math.max(1, Math.round(Math.sqrt(len))),
  )
}

export function vwma(src: Series, volume: Series, len: number): Series {
  const pv = sma(
    src.map((v, i) => v * volume[i]),
    len,
  )
  const vol = sma(volume, len)
  return pv.map((v, i) => v / vol[i])
}

/** Population standard deviation over `len` (ta.stdev). */
export function stdev(src: Series, len: number): Series {
  const mean = sma(src, len)
  const out = nan(src.length)
  for (let i = len - 1; i < src.length; i++) {
    if (!Number.isFinite(mean[i])) continue
    let sum = 0
    for (let k = 0; k < len; k++) sum += (src[i - k] - mean[i]) ** 2
    out[i] = Math.sqrt(sum / len)
  }
  return out
}

export function highest(src: Series, len: number): Series {
  const out = nan(src.length)
  for (let i = len - 1; i < src.length; i++) {
    let m = -Infinity
    for (let k = 0; k < len; k++) m = Math.max(m, src[i - k])
    out[i] = m
  }
  return out
}

export function lowest(src: Series, len: number): Series {
  const out = nan(src.length)
  for (let i = len - 1; i < src.length; i++) {
    let m = Infinity
    for (let k = 0; k < len; k++) m = Math.min(m, src[i - k])
    out[i] = m
  }
  return out
}

export function change(src: Series, len = 1): Series {
  return src.map((v, i) => (i >= len ? v - src[i - len] : NaN))
}

export function trueRange(bars: readonly Candle[]): Series {
  return bars.map((b, i) =>
    i === 0
      ? b.high - b.low
      : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)),
  )
}

export function atr(bars: readonly Candle[], len: number): Series {
  return rma(trueRange(bars), len)
}

export function rsi(src: Series, len: number): Series {
  const diff = change(src)
  const up = rma(
    diff.map((d) => (Number.isFinite(d) ? Math.max(d, 0) : NaN)),
    len,
  )
  const down = rma(
    diff.map((d) => (Number.isFinite(d) ? Math.max(-d, 0) : NaN)),
    len,
  )
  return up.map((u, i) => {
    const d = down[i]
    if (!Number.isFinite(u) || !Number.isFinite(d)) return NaN
    return d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d)
  })
}

/** Raw stochastic of `src` against `high`/`low` over `len`. */
export function stoch(src: Series, high: Series, low: Series, len: number): Series {
  const hh = highest(high, len),
    ll = lowest(low, len)
  return src.map((v, i) => {
    const range = hh[i] - ll[i]
    return range === 0 ? NaN : (100 * (v - ll[i])) / range
  })
}

export type MaType = 'SMA' | 'EMA' | 'RMA' | 'WMA'

export function ma(type: MaType, src: Series, len: number): Series {
  switch (type) {
    case 'EMA':
      return ema(src, len)
    case 'RMA':
      return rma(src, len)
    case 'WMA':
      return wma(src, len)
    default:
      return sma(src, len)
  }
}

export function sum(src: Series, len: number): Series {
  return sma(src, len).map((v) => v * len)
}
