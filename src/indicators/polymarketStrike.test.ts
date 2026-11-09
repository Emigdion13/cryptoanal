import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseInterval } from '../data/intervals'
import type { PolymarketState } from '../data/polymarket'
import type { Candle } from '../data/types'

const state: { value: PolymarketState } = { value: { status: 'loading', message: '', reply: null } }
vi.mock('../data/polymarket', async (original) => ({
  ...(await original<typeof import('../data/polymarket')>()),
  polymarketState: () => state.value,
}))
const { polymarketStrike } = await import('./polymarketStrike')
const { createInstance } = await import('./catalog')

const T0 = Date.parse('2026-11-06T11:30:00Z') / 1000
const bars: Candle[] = Array.from({ length: 9 }, (_, k) => ({
  time: T0 + k * 60,
  open: 100,
  high: 101,
  low: 99,
  close: k === 8 ? 105 : 100,
  volume: 1,
}))
const ctx = { interval: parseInterval('1')!, product: 'BTC-USD', feed: () => bars, timeToIndex: (t: number) => (t - T0) / 60 }
const NOW = (T0 + 8 * 60 + 30) * 1000
const live = (over: Partial<NonNullable<PolymarketState['reply']>> = {}): PolymarketState => ({
  status: 'live',
  message: '',
  reply: {
    product: 'BTC-USD',
    series: 'btc-up-or-down-5m',
    history: [{ slug: 'a', start: T0, end: T0 + 300, strike: 98 }],
    current: { slug: 'b', start: T0 + 300, end: T0 + 600, strike: 102, upPrice: 0.71 },
    basis: null,
    fetchedAt: 0,
    message: '',
    ...over,
  },
})
const badgeOf = (out: ReturnType<typeof polymarketStrike.compute>) => {
  const badge = out.drawings?.find((d) => d.type === 'text')
  return badge && 'text' in badge ? badge.text : null
}

afterEach(() => vi.useRealTimers())

describe('Polymarket Strike', () => {
  it('with past windows on, steps through each window’s strike and badges the live one', () => {
    vi.useFakeTimers({ now: NOW })
    state.value = live()
    const inst = createInstance('polymarketStrike')
    const out = polymarketStrike.compute(bars, { ...inst.inputs, showHistory: true }, inst.styles, ctx)
    expect(out.values.strike.slice(0, 5).every((v) => v === 98)).toBe(true)
    expect(out.values.strike.slice(5).every((v) => v === 102)).toBe(true)
    expect(badgeOf(out)).toBe('▲ UP +3.00 · 01:30 · Up 71¢ · beat 102.00')
  })

  it('by default only the live strike, as a line across the chart', () => {
    vi.useFakeTimers({ now: NOW })
    state.value = live()
    const inst = createInstance('polymarketStrike')
    const out = polymarketStrike.compute(bars, inst.inputs, inst.styles, ctx)
    expect(out.values.strike.slice(0, 5).every(Number.isNaN)).toBe(true)
    expect(out.values.strike.slice(5).every((v) => v === 102)).toBe(true)
    expect(out.drawings?.find((d) => d.type === 'line')).toEqual(expect.objectContaining({ x1: 0, y1: 102, extendRight: true }))
  })

  it('moves the line by how far Chainlink runs over Coinbase, and still shows Polymarket’s number', () => {
    vi.useFakeTimers({ now: NOW })
    state.value = live({ basis: { dollars: 1.5, samples: 48 } })
    const inst = createInstance('polymarketStrike')
    const out = polymarketStrike.compute(bars, inst.inputs, inst.styles, ctx)
    expect(out.values.strike.slice(5).every((v) => v === 100.5)).toBe(true)
    expect(badgeOf(out)).toBe('▲ UP +4.50 · 01:30 · Up 71¢ · beat 102.00')
    // Off: Polymarket's own number.
    const raw = polymarketStrike.compute(bars, { ...inst.inputs, lineUp: false }, inst.styles, ctx)
    expect(raw.values.strike.slice(5).every((v) => v === 102)).toBe(true)
  })

  it('calls a dead-even price UP, as the market resolves it', () => {
    vi.useFakeTimers({ now: NOW })
    state.value = live({ current: { slug: 'b', start: T0 + 300, end: T0 + 600, strike: 105, upPrice: null } })
    const inst = createInstance('polymarketStrike')
    expect(badgeOf(polymarketStrike.compute(bars, inst.inputs, inst.styles, ctx))).toBe('▲ UP +0.00 · 01:30 · beat 105.00')
  })

  it('draws no line once the strike on hand is last round’s', () => {
    vi.useFakeTimers({ now: (T0 + 600) * 1000 })
    state.value = { ...live(), status: 'waiting', message: 'Polymarket has not published this window’s strike yet.' }
    const inst = createInstance('polymarketStrike')
    const out = polymarketStrike.compute(bars, inst.inputs, inst.styles, ctx)
    expect(out.drawings?.some((d) => d.type === 'line')).toBe(false)
    expect(badgeOf(out)).toBe('Polymarket has not published this window’s strike yet.')
  })

  it('says why instead of drawing a guessed strike', () => {
    state.value = { status: 'unavailable', message: 'Polymarket unavailable: HTTP 502', reply: null }
    const inst = createInstance('polymarketStrike')
    const out = polymarketStrike.compute(bars, inst.inputs, inst.styles, ctx)
    expect(out.values.strike.every(Number.isNaN)).toBe(true)
    expect(out.drawings).toEqual([expect.objectContaining({ text: 'Polymarket unavailable: HTTP 502' })])
  })
})
