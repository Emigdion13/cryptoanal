import { describe, expect, it } from 'vitest'
import { forcedBoxTransparency, forcedEventsFor, forcedFlowProduct, formatNotional, newSqueezes } from './forcedFlowRules'
import type { ForcedFlow } from '../data/forcedFlow'

describe('the Forced flow window', () => {
  it('reads the perpetuals of a dollar market, Coinbase or Chainlink', () => {
    expect(forcedFlowProduct({ base: 'BTC', quote: 'USD' })).toBe('BTC-USD')
    expect(forcedFlowProduct({ base: 'eth', quote: 'USDC' })).toBe('ETH-USD')
    expect(forcedFlowProduct({ base: 'BTC', quote: 'EUR' })).toBe(null)
  })
  it('keeps the transparency in steps of 5', () => {
    expect(forcedBoxTransparency(33)).toBe(35)
    expect(forcedBoxTransparency(140)).toBe(100)
    expect(forcedBoxTransparency('x')).toBe(0)
  })
  it('writes notionals as a trader scans them', () => {
    expect(formatNotional(1_234_567)).toBe('+$1.23M')
    expect(formatNotional(-20_000_000)).toBe('-$20.0M')
    expect(formatNotional(950)).toBe('+$950')
  })
  it('chimes only for live squeezes it has not seen', () => {
    const event = (id: string, history?: boolean) => ({ id, state: 'longs-liquidating', start: 0, end: 0, price: 1, priceChange: -0.01, oiChange: -0.01, liquidatedUsd: 0, history })
    const flow = { events: [event('a'), event('b', true), event('c')] } as unknown as ForcedFlow
    expect(newSqueezes(flow, new Set(['a']))).toEqual(['c'])
    expect(newSqueezes(null, new Set())).toEqual([])
  })
})

describe('forcedEventsFor', () => {
  const flow = (events: { id: string; history?: boolean }[], history: { id: string; history?: boolean }[] = []) =>
    ({ product: 'BTC-USD', events, history }) as unknown as Parameters<typeof forcedEventsFor>[0]

  it('marks the reading’s squeezes on charts of the same coin, history first', () => {
    const f = flow([{ id: 'live' }], [{ id: 'old', history: true }])
    expect(forcedEventsFor(f, { base: 'BTC', quote: 'USDC' }).map((e) => e.id)).toEqual(['old', 'live'])
  })

  it('marks nothing on another coin, a non-dollar quote, or with the window closed', () => {
    const f = flow([{ id: 'live' }])
    expect(forcedEventsFor(f, { base: 'ETH', quote: 'USD' })).toEqual([])
    expect(forcedEventsFor(f, { base: 'BTC', quote: 'EUR' })).toEqual([])
    expect(forcedEventsFor(null, { base: 'BTC', quote: 'USD' })).toEqual([])
  })
})
