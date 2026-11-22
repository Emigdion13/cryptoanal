import { describe, expect, it } from 'vitest'
import type { ForcedEvent } from '../data/forcedFlow'
import type { Candle } from '../data/types'
import { forcedMarkerTitle, placeForcedMarkers } from './ForcedFlowMarkers'

const bar = (time: number): Candle => ({ time, open: 100, high: 110, low: 90, close: 105, volume: 1 })
const event = (id: string, start: number, state: ForcedEvent['state'] = 'longs-liquidating', extra: Partial<ForcedEvent> = {}): ForcedEvent => ({
  id,
  state,
  start,
  end: start + 60,
  price: 100,
  priceChange: -0.0124,
  oiChange: -0.008,
  liquidatedUsd: 2_100_000,
  ...extra,
})

describe('placeForcedMarkers', () => {
  const bars = [bar(0), bar(300), bar(600)]

  it('puts each squeeze on the bar holding its start', () => {
    const placed = placeForcedMarkers([event('a', 310), event('b', 600, 'shorts-liquidating')], bars, 300)
    expect(placed.map((p) => [p.event.id, p.index])).toEqual([
      ['a', 1],
      ['b', 2],
    ])
  })

  it('never snaps onto a neighbour: before the first bar or past the last bar’s end is skipped', () => {
    expect(placeForcedMarkers([event('early', -10), event('late', 900)], bars, 300)).toEqual([])
  })

  it('keeps one marker per bar and side, the later one winning (live over replayed history)', () => {
    const placed = placeForcedMarkers(
      [event('hist', 320, 'longs-liquidating', { history: true }), event('live', 400), event('up', 350, 'shorts-liquidating')],
      bars,
      300,
    )
    expect(placed.map((p) => p.event.id).sort()).toEqual(['live', 'up'])
  })

  it('works on a long timeframe where several five-minute squeezes share a bar', () => {
    const placed = placeForcedMarkers([event('a', 3700), event('b', 5000)], [bar(0), bar(3600)], 3600)
    expect(placed.map((p) => [p.event.id, p.index])).toEqual([['b', 1]])
  })
})

describe('forcedMarkerTitle', () => {
  it('says what the squeeze was', () => {
    expect(forcedMarkerTitle(event('a', 0))).toBe('Long squeeze · price −1.24% · OI −0.80% in 5m · $2.1M force-closed')
    expect(forcedMarkerTitle(event('b', 0, 'shorts-liquidating', { priceChange: 0.02, oiChange: null, liquidatedUsd: 0, history: true }))).toBe(
      'Short squeeze · price +2.00% in 5m · from Kraken history',
    )
  })
})
