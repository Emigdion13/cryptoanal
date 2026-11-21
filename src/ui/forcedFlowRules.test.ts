import { describe, expect, it } from 'vitest'
import { forcedBoxTransparency, forcedFlowProduct, formatNotional, newSqueezes } from './forcedFlowRules'
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
