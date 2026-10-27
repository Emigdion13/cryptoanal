/**
 * The LuxAlgo S/R clone against TradingView itself: the script page's chart (COINBASE:ETHUSD 4h)
 * sampled bar by bar from its legend, against the same Coinbase candles computed here.
 */
import { describe, expect, it } from 'vitest'
import type { Candle } from '../data/types'
import fx from './fixtures/luxsr-tradingview.json'
import { calculateLuxSr, pivots } from './luxSr'

const bars: Candle[] = (fx.candles as number[][]).map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }))
const tv = fx.tv as number[][]
const v = calculateLuxSr(bars, { leftBars: 15, rightBars: 15, volumeThresh: 20 })
const SHIFT = 16 // offset = −(rightBars + 1)

/** The bar TradingView's legend row describes, found by its OHLC. */
const indexOf = (row: number[]) =>
  bars.findIndex((b) => [b.open, b.high, b.low, b.close].every((x, k) => Math.abs(x - row[k]) < 0.005))

describe('Support and Resistance Levels with Breaks [LuxAlgo] vs TradingView', () => {
  it('finds every sampled bar in the Coinbase candles', () => {
    for (const row of tv) expect(indexOf(row), JSON.stringify(row)).toBeGreaterThan(0)
  })

  it('resistance and support, as plotted 16 bars back, on every sampled bar', () => {
    for (const row of tv) {
      const i = indexOf(row)
      expect(v.resistance[i + SHIFT], `resistance at ${new Date(bars[i].time * 1000).toISOString()}`).toBe(row[5])
      expect(v.support[i + SHIFT], `support at ${new Date(bars[i].time * 1000).toISOString()}`).toBe(row[6])
    }
  })

  it('no break label on the sampled bars, as on TradingView', () => {
    for (const row of tv) {
      const i = indexOf(row)
      expect([v.breakDown[i], v.breakUp[i], v.bullWick[i], v.bearWick[i]].map(Number)).toEqual(row.slice(7, 11))
    }
  })

  it('every break label TradingView prints, on the same bar and of the same kind', () => {
    for (const row of fx.breaks as number[][]) {
      const i = indexOf(row)
      expect(i, JSON.stringify(row)).toBeGreaterThan(0)
      expect([v.breakDown[i], v.breakUp[i], v.bullWick[i], v.bearWick[i]].map(Number)).toEqual(row.slice(4, 8))
    }
  })

  it('pivots: ties to the right still count, ties to the left do not (Pine)', () => {
    expect(pivots([1, 3, 2, 3, 1], 1, 1, true)).toEqual([NaN, NaN, 3, NaN, 3])
  })
})
