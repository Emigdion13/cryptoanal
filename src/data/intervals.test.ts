import { describe, expect, it } from 'vitest'
import { aggregate, aggregateLast, baseGranularity, bucketStart, nextBucket, parseInterval } from './intervals'
import type { Candle } from './types'

const c = (time: number, open: number, high: number, low: number, close: number, volume = 1): Candle => ({
  time,
  open,
  high,
  low,
  close,
  volume,
})

describe('parseInterval', () => {
  it('reads what you type on TradingView', () => {
    expect(parseInterval('5')?.label).toBe('5m')
    expect(parseInterval('60')?.label).toBe('1h')
    expect(parseInterval('4h')?.id).toBe('240')
    expect(parseInterval('D')?.id).toBe('1D')
    expect(parseInterval('1440')?.id).toBe('1D')
    expect(parseInterval('W')?.id).toBe('1W')
    expect(parseInterval('M')?.id).toBe('1M')
  })

  it('reads seconds as TradingView spells them', () => {
    expect(parseInterval('5S')).toMatchObject({ id: '5S', label: '5s', name: '5 seconds', group: 'seconds', seconds: 5 })
    expect(parseInterval('45s')?.id).toBe('45S')
    expect(parseInterval('60S')?.id).toBe('1')
    expect(parseInterval('120s')?.id).toBe('2')
    expect(parseInterval('7S')).toBeNull()
    expect(parseInterval('90S')).toBeNull()
  })

  it('refuses intervals that do not split a day', () => {
    expect(parseInterval('7')).toBeNull()
    expect(parseInterval('0')).toBeNull()
    expect(parseInterval('2D')).toBeNull()
    expect(parseInterval('abc')).toBeNull()
  })
})

describe('baseGranularity', () => {
  it('uses the biggest Coinbase size that divides the interval', () => {
    expect(baseGranularity(parseInterval('15S')!)).toBe(1)
    expect(baseGranularity(parseInterval('3')!)).toBe(60)
    expect(baseGranularity(parseInterval('10')!)).toBe(300)
    expect(baseGranularity(parseInterval('45')!)).toBe(900)
    expect(baseGranularity(parseInterval('240')!)).toBe(3600)
    expect(baseGranularity(parseInterval('720')!)).toBe(21600)
    expect(baseGranularity(parseInterval('1W')!)).toBe(86400)
  })
})

describe('buckets', () => {
  it('starts weeks on Monday and months on the 1st (UTC)', () => {
    const week = parseInterval('W')!
    // Wed 2026-10-28 12:00 UTC → Mon 2026-10-26
    const wed = Date.UTC(2026, 9, 28, 12) / 1000
    expect(bucketStart(week, wed)).toBe(Date.UTC(2026, 9, 26) / 1000)
    const month = parseInterval('M')!
    expect(bucketStart(month, wed)).toBe(Date.UTC(2026, 9, 1) / 1000)
    expect(nextBucket(month, Date.UTC(2026, 11, 1) / 1000)).toBe(Date.UTC(2027, 0, 1) / 1000)
  })
})

describe('aggregate', () => {
  it('rolls 1h candles into 4h bars', () => {
    const h = 3600
    const base = [
      c(0, 10, 12, 9, 11),
      c(h, 11, 15, 10, 14),
      c(2 * h, 14, 14, 8, 9),
      c(3 * h, 9, 10, 7, 8),
      c(4 * h, 8, 9, 8, 9),
    ]
    const bars = aggregate(base, parseInterval('240')!)
    expect(bars).toEqual([c(0, 10, 15, 7, 8, 4), c(4 * h, 8, 9, 8, 9, 1)])
    expect(aggregateLast(base.slice(0, 3), parseInterval('240')!)).toEqual(c(0, 10, 15, 8, 9, 3))
  })
})
