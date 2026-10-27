/**
 * The clone against TradingView itself: 75 bars of the real script's output, read off
 * tradingview.com (see the fixture's note). The first bars warm the averages up: TradingView had
 * months of history before them, the test has only these bars.
 */
import { describe, expect, it } from 'vitest'
import type { Candle } from '../data/types'
import tv from './fixtures/tux-tradingview.json'
import { calculateTux } from './tux'

const rows = tv.rows as (number | null)[][]
const bars: Candle[] = rows.map((r, i) => ({ time: i * 1800, open: r[0]!, high: r[1]!, low: r[2]!, close: r[3]!, volume: 0 }))
const v = calculateTux(bars, { factor: 3, pd: 7, length: 20, source: bars.map((b) => b.close) })
const col = (k: number) => rows.map((r) => r[k])

describe('TUX EMA Scalper+SuperTrend vs TradingView', () => {
  it('highest/lowest close of 8 bars, exactly', () => {
    for (let i = 7; i < rows.length; i++) {
      expect(v.highest[i], `high8 bar ${i}`).toBe(rows[i][10])
      expect(v.lowest[i], `low8 bar ${i}`).toBe(rows[i][11])
    }
  })

  it('EMA 20 converges onto TradingView’s', () => {
    for (let i = 60; i < rows.length; i++) expect(Math.abs(v.ema[i] - col(9)[i]!), `ema bar ${i}`).toBeLessThan(0.001)
  })

  it('SuperTrend line matches once the ATR has warmed up (the gap shrinks 6/7 a bar)', () => {
    for (let i = 61; i < rows.length; i++) expect(Math.abs(v.tsl[i] - col(4)[i]!), `tsl bar ${i}`).toBeLessThan(0.002)
  })

  it('every arrow, triangle and Buy/Sell label on the same bars', () => {
    const flags = (xs: boolean[]) => xs.map((x) => (x ? 1 : 0))
    const from = 20
    expect(flags(v.upArrow).slice(from)).toEqual(col(5).slice(from))
    expect(flags(v.downArrow).slice(from)).toEqual(col(6).slice(from))
    expect(v.entryUp.map((x) => (x ? 1 : null)).slice(from)).toEqual(col(7).slice(from))
    expect(v.entryDown.map((x) => (x ? -1 : null)).slice(from)).toEqual(col(8).slice(from))
    expect(flags(v.sell).slice(from)).toEqual(col(12).slice(from))
    expect(flags(v.buy).slice(from)).toEqual(col(13).slice(from))
  })

})
