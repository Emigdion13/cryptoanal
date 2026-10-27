import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseInterval } from '../data/intervals'
import type { KalshiState } from '../data/kalshi'
import type { Candle } from '../data/types'

const state: { value: KalshiState } = { value: { status: 'loading', message: '', reply: null } }
vi.mock('../data/kalshi', async (original) => ({
  ...(await original<typeof import('../data/kalshi')>()),
  kalshiState: () => state.value,
}))
const { kalshiStrike } = await import('./kalshiStrike')
const { createInstance } = await import('./catalog')

const T0 = Date.parse('2026-10-27T18:00:00Z') / 1000
const bars: Candle[] = Array.from({ length: 25 }, (_, k) => ({
  time: T0 + k * 60,
  open: 100,
  high: 101,
  low: 99,
  close: k === 24 ? 105 : 100,
  volume: 1,
}))
const ctx = { interval: parseInterval('1')!, product: 'BTC-USD', feed: () => bars, timeToIndex: (t: number) => (t - T0) / 60 }

afterEach(() => vi.useRealTimers())

describe('Kalshi Strike', () => {
  it('with past windows on, steps through each window’s strike and badges the live one', () => {
    vi.useFakeTimers({ now: (T0 + 24 * 60 + 30) * 1000 })
    state.value = {
      status: 'live',
      message: '',
      reply: {
        product: 'BTC-USD',
        series: 'KXBTC15M',
        history: [{ ticker: 'a', start: T0, end: T0 + 900, strike: 98 }],
        current: { ticker: 'b', start: T0 + 900, end: T0 + 1800, strike: 102, yesBid: 0.7, yesAsk: 0.72, tieGoesUp: true },
        fetchedAt: 0,
        message: '',
      },
    }
    const inst = createInstance('kalshiStrike')
    const out = kalshiStrike.compute(bars, { ...inst.inputs, showHistory: true }, inst.styles, ctx)
    expect(out.values.strike.slice(0, 15).every((v) => v === 98)).toBe(true)
    expect(out.values.strike.slice(15).every((v) => v === 102)).toBe(true)
    const badge = out.drawings?.find((d) => d.type === 'text')
    expect(badge && 'text' in badge && badge.text).toBe('▲ UP +3.00 · 05:30 · Yes 71¢')
  })

  it('by default only the live strike, as a line across the chart', () => {
    vi.useFakeTimers({ now: (T0 + 24 * 60 + 30) * 1000 })
    const inst = createInstance('kalshiStrike')
    const out = kalshiStrike.compute(bars, inst.inputs, inst.styles, ctx)
    expect(out.values.strike.slice(0, 15).every(Number.isNaN)).toBe(true)
    expect(out.values.strike.slice(15).every((v) => v === 102)).toBe(true)
    expect(out.drawings?.find((d) => d.type === 'line')).toEqual(expect.objectContaining({ x1: 0, y1: 102, extendRight: true }))
  })

  it('says why instead of drawing a guessed strike', () => {
    state.value = { status: 'unavailable', message: 'Kalshi unavailable: HTTP 502', reply: null }
    const inst = createInstance('kalshiStrike')
    const out = kalshiStrike.compute(bars, inst.inputs, inst.styles, ctx)
    expect(out.values.strike.every(Number.isNaN)).toBe(true)
    expect(out.drawings).toEqual([expect.objectContaining({ text: 'Kalshi unavailable: HTTP 502' })])
  })
})
