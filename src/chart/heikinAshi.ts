import type { Candle } from '../data/types'

/** The Heikin Ashi bar for `bar`, given the Heikin Ashi bar before it. */
export function nextHeikinAshi(bar: Candle, prev: Candle | undefined): Candle {
  const close = (bar.open + bar.high + bar.low + bar.close) / 4
  const open = prev ? (prev.open + prev.close) / 2 : (bar.open + bar.close) / 2
  return {
    time: bar.time,
    open,
    high: Math.max(bar.high, open, close),
    low: Math.min(bar.low, open, close),
    close,
    volume: bar.volume,
  }
}

export function heikinAshi(bars: readonly Candle[]): Candle[] {
  const out: Candle[] = []
  for (const bar of bars) out.push(nextHeikinAshi(bar, out[out.length - 1]))
  return out
}
