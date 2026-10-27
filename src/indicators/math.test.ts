import { describe, expect, it } from 'vitest'
import type { Candle } from '../data/types'
import { parseInterval } from '../data/intervals'
import { INDICATORS, createInstance, instanceTitle, INDICATOR_BY_TYPE } from './catalog'
import { ema, rma, rsi, sma, stdev, wma } from './math'

const close = [10, 11, 12, 11, 13, 14, 13, 15, 16, 15]

describe('moving averages', () => {
  it('sma waits for a full window', () => {
    expect(sma(close, 3).slice(0, 4)).toEqual([NaN, NaN, 11, 34 / 3])
  })

  it('ema and rma seed with the sma, then smooth', () => {
    const e = ema(close, 3)
    expect(e[2]).toBeCloseTo(11)
    expect(e[3]).toBeCloseTo(0.5 * 11 + 0.5 * 11)
    const r = rma(close, 3)
    expect(r[3]).toBeCloseTo(11 + (11 - 11) / 3)
    expect(r[4]).toBeCloseTo(11 + (13 - 11) / 3)
  })

  it('wma weighs the newest bar most', () => {
    expect(wma([1, 2, 3], 3)[2]).toBeCloseTo((1 + 4 + 9) / 6)
  })

  it('stdev is the population deviation', () => {
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9], 8)[7]).toBeCloseTo(2)
  })
})

describe('rsi', () => {
  it('is 100 when price only rises and 0 when it only falls', () => {
    const up = Array.from({ length: 30 }, (_, i) => i)
    expect(rsi(up, 14)[29]).toBe(100)
    expect(rsi(up.map((v) => -v), 14)[29]).toBe(0)
  })

  it('stays between 0 and 100', () => {
    const values = rsi(close.concat(close.map((v) => 30 - v)), 5).filter(Number.isFinite)
    expect(values.length).toBeGreaterThan(0)
    for (const v of values) expect(v >= 0 && v <= 100).toBe(true)
  })
})

describe('catalog', () => {
  const bars: Candle[] = Array.from({ length: 120 }, (_, i) => {
    const c = 100 + 10 * Math.sin(i / 7) + i * 0.1
    return { time: i * 60, open: c - 0.5, high: c + 1, low: c - 1, close: c, volume: 10 + (i % 5) }
  })

  it('every indicator computes a value per bar for every plot', () => {
    for (const def of INDICATORS) {
      const inst = createInstance(def.type)
      const ctx = { interval: parseInterval('1')!, product: 'BTC-USD', feed: () => bars, timeToIndex: (t: number) => t / 60 }
      const out = def.compute(bars, inst.inputs, inst.styles, ctx)
      if (!def.plots.length) expect(out.drawings, `${def.type} draws`).toBeDefined()
      // Indicators reading outside data (Kalshi) have nothing to show without it.
      if (def.external) continue
      for (const plot of def.plots) {
        const values = out.values[plot.key]
        expect(values, `${def.type}.${plot.key}`).toHaveLength(bars.length)
        expect(values.some(Number.isFinite), `${def.type}.${plot.key} has values`).toBe(true)
      }
    }
  })

  it('titles read like TradingView legends', () => {
    expect(instanceTitle(INDICATOR_BY_TYPE.get('rsi')!, createInstance('rsi'))).toBe('RSI 14 close')
    expect(instanceTitle(INDICATOR_BY_TYPE.get('macd')!, createInstance('macd'))).toBe('MACD 12 26 close 9')
  })
})
