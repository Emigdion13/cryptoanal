/**
 * Robex S/R Zones against the Robex IA panel itself: its own `computeZones` (sr_zones.js) run in
 * the page on the 15m candles its bot sent, and on Coinbase 1h candles, then the same candles here.
 */
import { describe, expect, it } from 'vitest'
import type { Candle } from '../data/types'
import type { IntervalDef } from '../data/intervals'
import fx from './fixtures/robex-sr-site.json'
import { computeRobexZones, dayKeys, robexAtr, robexSrZones } from './robexSr'
import { defaultStyles } from './catalog'

const toBars = (rows: number[][]): Candle[] => rows.map(([time, open, high, low, close]) => ({ time, open, high, low, close, volume: 0 }))
const sets: Record<string, Candle[]> = { '15m': toBars(fx.candles15m), '1h': toBars(fx.candles1h) }
const slice = (set: string, from: number, to: number) => sets[set].filter((b) => b.time >= from && b.time <= to)
const day = (iso: string) => Date.parse(iso) / 1000

describe('Robex S/R Zones vs the panel (sr_zones.js computeZones)', () => {
  it('the ATR of the bot\'s 300 candles, as the page printed it', () => {
    expect(robexAtr(sets['15m'], 14)).toBeCloseTo(461.3878571428577, 8)
  })

  for (const c of fx.cases) {
    const when = `${c.set} ${new Date(c.from * 1000).toISOString().slice(5, 16)} → ${new Date(c.to * 1000).toISOString().slice(5, 16)}`
    it(`same zones as the panel, ${when}`, () => {
      const zones = computeRobexZones(slice(c.set, c.from, c.to))
      expect(zones.map((z) => z.label)).toEqual(c.zones.map((z) => z[0]))
      zones.forEach((z, k) => {
        const [, level, top, bottom, touches, firstTime, lastTime, strength, range] = c.zones[k] as [string, ...number[]]
        expect(z.level, `${z.label} level`).toBeCloseTo(level, 6)
        expect(z.top, `${z.label} top`).toBeCloseTo(top, 6)
        expect(z.bottom, `${z.label} bottom`).toBeCloseTo(bottom, 6)
        expect(z.touches, `${z.label} touches`).toBe(touches)
        expect(z.firstTime, `${z.label} first touch`).toBe(firstTime)
        expect(z.lastTime, `${z.label} last touch`).toBe(lastTime)
        expect(z.strength, `${z.label} strength`).toBeCloseTo(strength, 8)
        expect(z.range ? 1 : 0, `${z.label} from the range`).toBe(range)
      })
    })
  }

  it('the panel on screen (all 300 bot candles): R1 60,030 from the range ceiling, S1 59,582 from the floor', () => {
    const [r1, s1] = computeRobexZones(sets['15m'])
    expect([r1.label, Math.round(r1.level), r1.touches, r1.range]).toEqual(['R1', 60030, 4, true])
    expect([s1.label, Math.round(s1.level), s1.touches, s1.range]).toEqual(['S1', 59582, 5, true])
  })
})

describe('Robex S/R Zones: the rules', () => {
  const flat = (n: number, price: number): Candle[] =>
    Array.from({ length: n }, (_, k) => ({ time: k * 900, open: price, high: price + 10, low: price - 10, close: price, volume: 0 }))

  it('a pivot needs `order` bars on both sides that do not top it; ties still count', () => {
    // One spike to 200 in the middle of a flat 100 ± 10, then a dip back under it.
    const bars = flat(30, 100)
    bars[15] = { ...bars[15], high: 200, close: 150 }
    bars[29] = { ...bars[29], close: 120 }
    const zones = computeRobexZones(bars, { perSide: 5 })
    const r = zones.find((z) => z.kind === 'resistance' && z.level > 150)!
    expect(r.level).toBe(200)
    expect(r.touches).toBe(1)
  })

  it('pivots within 0.5 ATR of the running mean are one level, priced at their mean', () => {
    const bars = flat(40, 100)
    bars[10] = { ...bars[10], high: 150 }
    bars[25] = { ...bars[25], high: 152 }
    const atr = robexAtr(bars, 14)
    expect(atr).toBeGreaterThan(4)
    const r = computeRobexZones(bars, { perSide: 5 }).find((z) => z.level > 140)!
    expect(r.touches).toBe(2)
    expect(r.level).toBe(151)
    expect([r.min, r.max, r.firstTime, r.lastTime]).toEqual([150, 152, 10 * 900, 25 * 900])
  })

  it('nothing for too few bars or a dead market', () => {
    expect(computeRobexZones(flat(10, 100))).toEqual([])
    expect(computeRobexZones(flat(40, 100).map((b) => ({ ...b, high: 100, low: 100 })))).toEqual([])
  })

  it('day keys: yesterday and today by UTC day, as the panel\'s map (Máx./Mín. ayer 62,562.15 / 57,655.17)', () => {
    const keys = Object.fromEntries(dayKeys(sets['15m']).map((k) => [k.name, k.price]))
    expect(keys['High yesterday']).toBe(62562.15)
    expect(keys['Low yesterday']).toBe(57655.17)
    expect(keys['Low today']).toBe(55106)
    // The panel showed 60,825.20 for today's high: its server missed Coinbase's 60,883.03 at 14:00 UTC.
    expect(keys['High today']).toBe(60883.03)
    const sameDay = sets['15m'].filter((b) => b.time >= day('2026-11-21T00:00:00Z'))
    expect(dayKeys(sameDay).map((k) => k.name)).toEqual(['High today', 'Low today'])
  })
})

describe('Robex S/R Zones: the indicator', () => {
  const m15: IntervalDef = { id: '15', label: '15m', name: '15 minutes', group: 'minutes', kind: 'fixed', seconds: 900, intraday: true }
  const m1: IntervalDef = { ...m15, id: '1', label: '1m', name: '1 minute', seconds: 60 }
  const inputs = Object.fromEntries(robexSrZones.inputs.map((i) => [i.key, i.default]))
  const ctx = (interval: IntervalDef, feed: (s: number) => Candle[] = () => []) => ({ interval, product: 'BTC-USD', feed, timeToIndex: () => 0 })

  it('reads 15m candles on another chart, its own bars on a 15m chart', () => {
    expect(robexSrZones.feeds!(inputs, m1)).toEqual([900])
    expect(robexSrZones.feeds!(inputs, m15)).toEqual([])
    expect(robexSrZones.feeds!({ ...inputs, timeframe: 'Chart' }, m1)).toEqual([])
  })

  it('draws each zone to the price axis with its label, as the panel', () => {
    const out = robexSrZones.compute(sets['15m'], inputs, defaultStyles(robexSrZones), ctx(m15))
    const labels = out.drawings!.filter((d) => d.type === 'text').map((d) => (d as { text: string }).text)
    expect(labels).toEqual(expect.arrayContaining(['R1 60,030 · 4', 'S1 59,582 · 5', 'High yesterday 62,562']))
    const boxes = out.drawings!.filter((d) => d.type === 'box')
    expect(boxes).toHaveLength(2)
    expect(boxes.every((b) => b.type === 'box' && b.extendRight && b.x2 === 'end')).toBe(true)
    expect(out.values.resistance.at(-1)).toBeCloseTo(60030.305, 6)
    expect(out.values.support.at(-1)).toBeCloseTo(59581.53, 6)
  })

  it('on a 1m chart, the same zones from the 15m feed', () => {
    const minute = Array.from({ length: 100 }, (_, k) => ({ time: 1795278600 - 6000 + k * 60, open: 1, high: 1, low: 1, close: 1, volume: 0 }))
    const out = robexSrZones.compute(minute, inputs, defaultStyles(robexSrZones), ctx(m1, (s) => (s === 900 ? sets['15m'] : [])))
    const labels = out.drawings!.filter((d) => d.type === 'text').map((d) => (d as { text: string }).text)
    expect(labels).toContain('R1 60,030 · 4')
    expect(labels).toContain('S1 59,582 · 5')
  })

  it('no drawings until the feed has loaded', () => {
    const out = robexSrZones.compute(sets['15m'].slice(0, 5), inputs, defaultStyles(robexSrZones), ctx(m1))
    expect(out.drawings).toEqual([])
  })
})
