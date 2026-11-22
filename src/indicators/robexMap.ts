/**
 * The Robex IA panel's BTC "map" (the zones its server sends and `adaptive_map.js` draws), as
 * near as candles alone get to it. The server's code is not visible, and it keeps its zones from
 * one update to the next on its own trade feed (some of its prices are no Coinbase candle's), so
 * this is a fit to snapshots of the site, not a clone. See `fixtures/robex-map-site.json` and the
 * test for how far off it is.
 *
 * What is read from the page (exact):
 *   - a zone is drawn when it has 3+ rejections (2+ for zones formed after a sharp move), the 2
 *     nearest on each side of the price: S1 S2 / R1 R2;
 *   - the two the bot trades on are PISO (floor) and TECHO (ceiling), drawn stronger, and keep
 *     their place in the numbering (PISO, S2);
 *   - each band runs from its first touch to the price, and its label prints the band's edge
 *     facing the price (PISO / TECHO: the bot's own number) and the touches;
 *   - yesterday's and today's high and low (UTC) as grey dotted lines.
 *
 * What is inferred from the snapshots (approximate):
 *   - zones come from 15m candles; 1h zones only beyond the 15m window's range;
 *   - every pivot high and low (one bar each side), swept from low to high and merged within
 *     0.5 ATR of the running mean: the zone's price is the mean, its band the pivots' range
 *     (at least ± 0.03 ATR);
 *   - rejections are counted as episodes: pivots on consecutive bars are one; 3+ to be drawn;
 *   - PISO is the top edge of the nearest drawn support, TECHO the nearest edge above the price
 *     of the nearest drawn resistance (both held on every snapshot).
 */
import type { Candle } from '../data/types'

type Bar = Pick<Candle, 'time' | 'open' | 'high' | 'low' | 'close'>

/** The plain mean of the last `period` true ranges (as the panel's sr_zones.js). */
function robexAtr(bars: readonly Bar[], period: number): number {
  if (bars.length < 2) return 0
  let sum = 0
  const from = Math.max(1, bars.length - period)
  for (let i = from; i < bars.length; i++) {
    const b = bars[i]
    const prev = bars[i - 1].close
    sum += Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev))
  }
  return sum / (bars.length - from)
}

export interface RobexMapSettings {
  /** Bars each side a pivot must top (or undercut); ties count. */
  pivotOrder: number
  /** Pivots within this many ATR of a zone's running mean join it. */
  mergeAtr: number
  /** Half the thinnest band, in ATR. */
  minHalfAtr: number
  /** Rejections a zone needs to be drawn. */
  minTouches: number
  /** Drawn zones on each side of the price. */
  perSide: number
  atrPeriod: number
  /** 1h zones beyond the 15m window's range. */
  hourly: boolean
}

/** Fitted to ten snapshots of the site's maps (BTC and six other coins, 2026-11-21 and 22; see the test). */
export const MAP_DEFAULTS: RobexMapSettings = {
  pivotOrder: 1,
  mergeAtr: 0.5,
  minHalfAtr: 0.03,
  minTouches: 3,
  perSide: 2,
  atrPeriod: 14,
  hourly: true,
}

export interface MapZone {
  side: 'support' | 'resistance'
  price: number
  low: number
  high: number
  /** Rejections: pivots on consecutive bars count once. */
  touches: number
  firstTime: number
  lastTime: number
  tf: '15m' | '1h'
  /** Most of its pivots were lows (a floor) or highs (a ceiling). */
  origin: 'piso' | 'techo'
}

export interface ShownZone {
  zone: MapZone
  /** S1 / S2 / R1 / R2, or PISO / TECHO for the two the bot trades on. */
  tag: string
  key: boolean
  /** The number on its label: the edge facing the price, or the bot's floor / ceiling. */
  labelPrice: number
}

export interface RobexMap {
  price: number
  zones: MapZone[]
  shown: ShownZone[]
  piso: number | null
  techo: number | null
}

/** Every zone in these bars. The newest bar (still forming) is the price, never a pivot. */
export function mapZones(bars: readonly Bar[], tf: MapZone['tf'], s: RobexMapSettings = MAP_DEFAULTS): MapZone[] {
  const n = bars.length
  const k = Math.max(1, Math.round(s.pivotOrder))
  if (n < 2 * k + 2) return []
  const atr = robexAtr(bars, s.atrPeriod)
  if (!(atr > 0)) return []
  const price = bars[n - 1].close

  const points: { price: number; index: number; kind: 'piso' | 'techo' }[] = []
  for (let i = k; i < n - 1 && i + k < n; i++) {
    let high = true
    let low = true
    for (let j = i - k; j <= i + k; j++) {
      if (bars[j].high > bars[i].high) high = false
      if (bars[j].low < bars[i].low) low = false
    }
    if (high) points.push({ price: bars[i].high, index: i, kind: 'techo' })
    if (low) points.push({ price: bars[i].low, index: i, kind: 'piso' })
  }
  points.sort((a, b) => a.price - b.price)

  const clusters: { sum: number; members: typeof points }[] = []
  for (const p of points) {
    const last = clusters[clusters.length - 1]
    if (last && Math.abs(p.price - last.sum / last.members.length) <= atr * s.mergeAtr) {
      last.sum += p.price
      last.members.push(p)
    } else clusters.push({ sum: p.price, members: [p] })
  }

  return clusters.map((c) => {
    const level = c.sum / c.members.length
    const prices = c.members.map((m) => m.price)
    let low = Math.min(...prices)
    let high = Math.max(...prices)
    const half = atr * s.minHalfAtr
    if (high - low < 2 * half) {
      const mid = (low + high) / 2
      low = mid - half
      high = mid + half
    }
    const indexes = [...new Set(c.members.map((m) => m.index))].sort((a, b) => a - b)
    const episodes: [number, number][] = []
    for (const i of indexes) {
      const last = episodes[episodes.length - 1]
      if (last && i - last[1] <= 1) last[1] = i
      else episodes.push([i, i])
    }
    const lows = c.members.filter((m) => m.kind === 'piso').length
    return {
      side: level < price ? 'support' : 'resistance',
      price: level,
      low,
      high,
      touches: episodes.length,
      firstTime: bars[episodes[0][0]].time,
      lastTime: bars[episodes[episodes.length - 1][1]].time,
      tf,
      origin: lows > c.members.length - lows ? 'piso' : 'techo',
    } satisfies MapZone
  })
}

/** The map for the newest 15m bar (and 1h bars for the zones beyond the 15m window). */
export function computeRobexMap(bars15: readonly Bar[], bars1h: readonly Bar[], settings: Partial<RobexMapSettings> = {}): RobexMap {
  const s = { ...MAP_DEFAULTS, ...settings }
  const empty: RobexMap = { price: NaN, zones: [], shown: [], piso: null, techo: null }
  if (!bars15.length) return empty
  const price = bars15[bars15.length - 1].close
  const zones = mapZones(bars15, '15m', s)
  if (s.hourly && bars1h.length) {
    const atr = robexAtr(bars15, s.atrPeriod)
    const lo = Math.min(...bars15.map((b) => b.low)) - atr / 2
    const hi = Math.max(...bars15.map((b) => b.high)) + atr / 2
    for (const z of mapZones(bars1h, '1h', s)) {
      if (z.price >= lo && z.price <= hi) continue
      zones.push({ ...z, side: z.price < price ? 'support' : 'resistance' })
    }
  }

  const strong = zones.filter((z) => z.touches >= s.minTouches)
  const nearest = (side: MapZone['side']) =>
    strong
      .filter((z) => z.side === side)
      .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))
      .slice(0, Math.max(0, s.perSide))
  const supports = nearest('support')
  const resistances = nearest('resistance')

  // The bot's floor: the top of the nearest support; its ceiling: the nearest edge above the price.
  let piso: number | null = null
  let pisoZone: MapZone | null = null
  for (const z of supports)
    for (const e of [z.low, z.high]) if (e < price && (piso === null || e > piso)) (piso = e), (pisoZone = z)
  let techo: number | null = null
  let techoZone: MapZone | null = null
  for (const z of resistances)
    for (const e of [z.low, z.high]) if (e > price && (techo === null || e < techo)) (techo = e), (techoZone = z)

  const name = (list: MapZone[], prefix: 'S' | 'R'): ShownZone[] =>
    list.map((zone, k) => {
      if (zone === pisoZone) return { zone, tag: 'PISO', key: true, labelPrice: piso! }
      if (zone === techoZone) return { zone, tag: 'TECHO', key: true, labelPrice: techo! }
      return { zone, tag: `${prefix}${k + 1}`, key: false, labelPrice: zone.side === 'support' ? zone.high : zone.low }
    })
  return { price, zones, shown: [...name(supports, 'S'), ...name(resistances, 'R')], piso, techo }
}
