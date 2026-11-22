/**
 * Robex S/R Zones, Map mode, against the Robex IA panel's own maps: four snapshots of its BTC map
 * (2026-11-21 16:33, 2026-11-22 00:09, 00:15 and 00:24 UTC, sent to the page over its WebSocket)
 * and one each of ETH, SOL, XRP, DOGE, ZEC and NEAR (00:26 UTC, from the panel's public per-coin
 * endpoint), with the Coinbase candles of the same moments.
 *
 * The server keeps its zones between updates and builds them on its own trade feed, so this is
 * an approximation: the test pins how close it gets, so a change that makes it worse fails.
 */
import { describe, expect, it } from 'vitest'
import fx from './fixtures/robex-map-site.json'
import { computeRobexMap, mapZones, MAP_DEFAULTS } from './robexMap'
import { robexSrZones } from './robexSr'
import { defaultStyles } from './catalog'
import type { Candle } from '../data/types'
import type { IntervalDef } from '../data/intervals'

const toBars = (rows: number[][]): Candle[] => rows.map(([time, open, high, low, close]) => ({ time, open, high, low, close, volume: 0 }))
type SiteLevel = [string, number, number, number, number, number, number, number, string, string | null, string]
type Snapshot = (typeof fx.snapshots)[number]

/** What the page draws from a snapshot (adaptive_map.js): 3+ rejections, 2+ for "nuevo", 2 nearest per side. */
function siteDrawn(s: Snapshot, side: 'S' | 'R'): SiteLevel[] {
  return (s.levels as SiteLevel[])
    .filter((l) => l[0] === side && (l[5] >= 3 || (l[8] === 'nuevo' && l[5] >= 2)))
    .sort((a, b) => Math.abs(a[1] - s.price) - Math.abs(b[1] - s.price))
    .slice(0, 2)
}

const ours = (s: Snapshot) => computeRobexMap(toBars(s.candles15m).slice(-96), toBars(s.candles1h))

/**
 * Measured with the defaults: |our price − the site's| per drawn level, in % of the price, rounded
 * up (S1, S2, R1, R2), then the floor (PISO) and ceiling (TECHO) the bot trades on. 0.1% of BTC
 * is about $60. The nearest level a side and PISO / TECHO mostly land within 0.1%; the second
 * level a side often does not (the site reaches for older 15m or 1h zones there).
 */
const MEASURED: Record<string, { S: number[]; R: number[]; piso: number; techo: number }> = {
  'BTC 2026-11-21T16:33': { S: [0.067, 0.007], R: [0.515, 0.725], piso: 0.038, techo: 0.442 },
  'BTC 2026-11-22T00:09': { S: [0.005, 3.078], R: [0.002, 0.035], piso: 0.027, techo: 0.05 },
  'BTC 2026-11-22T00:15': { S: [0.006, 3.078], R: [0.017, 0.044], piso: 0.027, techo: 0.018 },
  'BTC 2026-11-22T00:24': { S: [0.276, 0.306], R: [0.228, 1.468], piso: 0.13, techo: 0.142 },
  'ETH 2026-11-22T00:26': { S: [0.057, 1.804], R: [0.176], piso: 2.101, techo: 0.024 },
  'SOL 2026-11-22T00:26': { S: [0.228, 0.035], R: [0.129, 0.041], piso: 0.107, techo: 0.143 },
  'XRP 2026-11-22T00:26': { S: [0.027, 0.253], R: [0.014, 3.37], piso: 0.062, techo: 2.901 },
  'DOGE 2026-11-22T00:26': { S: [0.022, 0.814], R: [0.071, 4.523], piso: 0.037, techo: 0.215 },
  'ZEC 2026-11-22T00:26': { S: [0.04], R: [0.074, 0.044], piso: 0.043, techo: 0.119 },
  'NEAR 2026-11-22T00:26': { S: [0.384, 0.944], R: [0.01, 0.935], piso: 0.194, techo: 0.033 },
}

describe("Robex S/R Zones (Map) vs the site's maps", () => {
  for (const s of fx.snapshots) {
    const name = `${s.coin} ${new Date(s.as_of * 1000).toISOString().slice(0, 16)}`
    const bound = MEASURED[name]
    it(`${name} UTC: each drawn zone within its measured distance of the site's`, () => {
      const m = ours(s)
      const pct = (a: number, b: number) => (100 * Math.abs(a - b)) / s.price
      for (const side of ['S', 'R'] as const) {
        const site = siteDrawn(s, side)
        const mine = m.shown.filter((z) => (z.zone.side === 'support') === (side === 'S'))
        expect(mine.length).toBeGreaterThanOrEqual(site.length)
        site.forEach((l, k) => expect(pct(mine[k].zone.price, l[1]), `${side}${k + 1} vs site ${l[1]}`).toBeLessThanOrEqual(bound[side][k]))
      }
      expect(pct(m.piso!, s.piso), 'PISO').toBeLessThanOrEqual(bound.piso)
      expect(pct(m.techo!, s.techo), 'TECHO').toBeLessThanOrEqual(bound.techo)
    })
  }

  it('the nearest zone a side is within 0.1% of the site on more than half the snapshots', () => {
    const first = Object.values(MEASURED).flatMap((b) => [b.S[0], b.R[0]])
    expect(first.filter((e) => e <= 0.1).length / first.length).toBeGreaterThan(0.5)
  })
})

describe('Robex S/R Zones (Map): the rules', () => {
  /** Flat 100 ± 1 bars, 15 minutes apart, with the given highs and lows set. */
  const flat = (n: number, set: Record<number, Partial<Candle>> = {}): Candle[] =>
    Array.from({ length: n }, (_, k) => ({ time: k * 900, open: 100, high: 101, low: 99, close: 100, volume: 0, ...set[k] }))

  it('pivots on consecutive bars are one rejection; apart, two', () => {
    const together = mapZones(flat(30, { 10: { high: 120 }, 11: { high: 120 } }), '15m').find((z) => z.price === 120)!
    expect(together.touches).toBe(1)
    const apart = mapZones(flat(30, { 10: { high: 120 }, 20: { high: 120 } }), '15m').find((z) => z.price === 120)!
    expect(apart.touches).toBe(2)
    expect([apart.firstTime, apart.lastTime]).toEqual([10 * 900, 20 * 900])
    expect(apart.origin).toBe('techo')
  })

  it('the forming bar is the price, never a pivot', () => {
    const bars = flat(30, { 29: { high: 150, close: 100 } })
    expect(mapZones(bars, '15m').some((z) => z.price === 150)).toBe(false)
  })

  it('a band is never thinner than ± 0.03 ATR', () => {
    const z = mapZones(flat(30, { 10: { high: 120 } }), '15m').find((x) => x.price === 120)!
    expect(z.high - z.low).toBeGreaterThan(0)
    expect((z.high + z.low) / 2).toBeCloseTo(120, 9)
  })

  it('PISO is the top of the nearest support, TECHO the nearest edge above the price; they keep their rank', () => {
    const m = ours(fx.snapshots[2])
    const tags = m.shown.map((z) => z.tag)
    expect(tags).toEqual(['PISO', 'S2', 'TECHO', 'R2'])
    const piso = m.shown[0]
    expect(m.piso).toBe(piso.zone.high)
    expect(piso.labelPrice).toBe(m.piso)
    const techo = m.shown[2]
    expect(m.techo).toBe([techo.zone.low, techo.zone.high].filter((e) => e > m.price).sort((a, b) => a - b)[0])
    // The others print the edge facing the price.
    expect(m.shown[1].labelPrice).toBe(m.shown[1].zone.high)
    expect(m.shown[3].labelPrice).toBe(m.shown[3].zone.low)
  })

  it('1h zones only beyond the 15m window\'s range', () => {
    const s = fx.snapshots[0]
    const m = ours(s)
    const b15 = toBars(s.candles15m).slice(-96)
    const lo = Math.min(...b15.map((b) => b.low))
    const hi = Math.max(...b15.map((b) => b.high))
    const hourly = m.zones.filter((z) => z.tf === '1h')
    expect(hourly.length).toBeGreaterThan(0)
    for (const z of hourly) expect(z.price < lo || z.price > hi).toBe(true)
  })

  it('defaults as fitted', () => {
    expect(MAP_DEFAULTS).toMatchObject({ pivotOrder: 1, mergeAtr: 0.5, minTouches: 3, perSide: 2 })
  })
})

describe('Robex S/R Zones (Map): the indicator', () => {
  const m15: IntervalDef = { id: '15', label: '15m', name: '15 minutes', group: 'minutes', kind: 'fixed', seconds: 900, intraday: true }
  const m1: IntervalDef = { ...m15, id: '1', label: '1m', name: '1 minute', seconds: 60 }
  const inputs = Object.fromEntries(robexSrZones.inputs.map((i) => [i.key, i.default]))
  const s = fx.snapshots[2]

  it('is the default, and reads 15m and 1h candles', () => {
    expect(inputs.mode).toBe('Map')
    expect(robexSrZones.feeds!(inputs, m1)).toEqual([900, 3600])
    expect(robexSrZones.feeds!(inputs, m15)).toEqual([3600])
  })

  it('draws the zones as the site does: PISO / TECHO filled, 8–16 px bands with edges', () => {
    const minute = Array.from({ length: 60 }, (_, k) => ({ time: s.as_of - 3600 + k * 60, open: 1, high: 1, low: 1, close: 1, volume: 0 }))
    const feed = (sec: number) => (sec === 900 ? toBars(s.candles15m) : sec === 3600 ? toBars(s.candles1h) : [])
    const out = robexSrZones.compute(minute, inputs, defaultStyles(robexSrZones), { interval: m1, product: 'BTC-USD', feed, timeToIndex: () => 0 })
    const texts = out.drawings!.filter((d) => d.type === 'text').map((d) => d as { text: string; bg?: string })
    const m = ours(s)
    const label = (tag: string) => texts.find((t) => t.text.startsWith(`${tag}  `))!
    expect(label('PISO').text).toBe(`PISO  ${Math.round(m.piso!).toLocaleString('en-US')} · ${m.shown[0].zone.touches}`)
    expect(label('PISO').bg).toBe('#26a69a')
    expect(label('TECHO').bg).toBe('#ef5350')
    expect(label('S2').bg).toBe('rgba(11, 14, 21, 0.92)')
    const boxes = out.drawings!.filter((d) => d.type === 'box')
    expect(boxes).toHaveLength(4)
    for (const b of boxes) expect(b).toMatchObject({ maxPx: 16, x2: 'end' })
    expect(boxes.map((b) => (b as { minPx: number }).minPx)).toEqual([10, 8, 10, 8])
  })
})
