/**
 * Robex S/R Zones: the support and resistance of the Robex IA panel (panel.robexiajd.com),
 * rebuilt from how its `sr_zones.js` works (the panel's own calculation, done in the browser) and
 * drawn the way the panel draws it. Worked out on 15-minute candles whatever the chart's
 * interval, as the panel does, so the levels are the same on 1m, 5m or 15m.
 *
 *   ATR       the plain mean of the last 14 true ranges (not Wilder's).
 *   pivots    a bar no bar within `pivotOrder` on either side tops (highs) or undercuts (lows);
 *             ties still count, and one bar can be both.
 *   levels    every pivot price, highs and lows together, swept from low to high: a price within
 *             0.5 ATR of the running mean of the level below it joins it. A level's price is the
 *             mean of its pivots, its touches how many there were.
 *   range     the floor and the ceiling of the last 12 bars: 3+ lows (highs) within 0.2 ATR of
 *             one another that no later close broke by more than 0.2 ATR. It joins a level
 *             within 0.2 ATR (taking the larger touch count) or becomes a level of its own.
 *   zone      the level ± half its pivots' spread, at least 0.12 ATR and at most 0.4 ATR thick.
 *   shown     on each side of the last close, the nearest level, those with 2+ touches first.
 *
 * Nothing is kept from one bar to the next: every update starts again from the window's candles
 * (the panel's bot sends the last 300), so a level goes when its pivots leave the window or the
 * price crosses it. Volume plays no part.
 *
 * Checked against the panel's own `computeZones`, run in the page on the candles its bot sent
 * (`fixtures/robex-sr-site.json`).
 */
import { alpha } from '../drawings/tools'
import { formatPrice } from '../format'
import type { Candle } from '../data/types'
import type { Drawing, IndicatorDef, InputValue } from './types'

export interface RobexSrSettings {
  pivotOrder: number
  atrPeriod: number
  mergeAtr: number
  minThickAtr: number
  maxThickAtr: number
  perSide: number
  rangeBars: number
  rangeTolAtr: number
  rangeMinTouches: number
}

/** The panel's settings as served on 2026-11-21. */
export const ROBEX_DEFAULTS: RobexSrSettings = {
  pivotOrder: 3,
  atrPeriod: 14,
  mergeAtr: 0.5,
  minThickAtr: 0.12,
  maxThickAtr: 0.4,
  perSide: 1,
  rangeBars: 12,
  rangeTolAtr: 0.2,
  rangeMinTouches: 3,
}

export interface RobexZone {
  label: string
  kind: 'resistance' | 'support'
  level: number
  top: number
  bottom: number
  touches: number
  /** The extremes of the pivots that made it. */
  min: number
  max: number
  firstTime: number
  lastTime: number
  /** Touches plus up to 1.5 for how recent the last one is (the panel computes it; nothing reads it). */
  strength: number
  /** Came from (or was joined by) the range's floor or ceiling. */
  range: boolean
}

type Bar = Pick<Candle, 'time' | 'open' | 'high' | 'low' | 'close'>

/** The plain mean of the last `period` true ranges. */
export function robexAtr(bars: readonly Bar[], period: number): number {
  if (bars.length < 2) return 0
  const trs: number[] = []
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]
    const prev = bars[i - 1].close
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev)))
  }
  const tail = trs.slice(-period)
  return tail.reduce((s, v) => s + v, 0) / tail.length
}

interface Cluster {
  sum: number
  touches: number
  min: number
  max: number
  firstTime: number
  lastTime: number
  range?: boolean
}

/**
 * The floor ('low') or ceiling ('high') the last bars kept coming back to. From the newest bar
 * back, each bar's low (high) gathers the bars within the tolerance of it; the biggest gathering
 * of at least the minimum that no later close broke wins.
 */
function rangeLevel(bars: readonly Bar[], atr: number, side: 'low' | 'high', s: RobexSrSettings) {
  const recent = bars.slice(-s.rangeBars)
  const tol = atr * s.rangeTolAtr
  let best: (Cluster & { level: number }) | null = null
  for (let i = recent.length - 1; i >= 0; i--) {
    const ref = recent[i][side]
    const touches = recent.filter((b) => Math.abs(b[side] - ref) <= tol)
    if (touches.length < s.rangeMinTouches) continue
    if (best && touches.length <= best.touches) continue
    const level = touches.reduce((sum, b) => sum + b[side], 0) / touches.length
    const from = touches[0].time
    const broken = recent.some((b) => b.time > from && (side === 'low' ? b.close < level - tol : b.close > level + tol))
    if (broken) continue
    const prices = touches.map((b) => b[side])
    best = {
      level,
      sum: 0,
      touches: touches.length,
      min: Math.min(...prices),
      max: Math.max(...prices),
      firstTime: from,
      lastTime: touches[touches.length - 1].time,
    }
  }
  return best
}

/** The zones the panel shows for these bars (the newest bar's close is "the price"). */
export function computeRobexZones(bars: readonly Bar[], settings: Partial<RobexSrSettings> = {}): RobexZone[] {
  const s = { ...ROBEX_DEFAULTS, ...settings }
  const order = s.pivotOrder
  if (bars.length < order * 2 + 5) return []
  const atr = robexAtr(bars, s.atrPeriod)
  if (!(atr > 0)) return []
  const price = bars[bars.length - 1].close

  const pivots: { price: number; time: number }[] = []
  for (let i = order; i < bars.length - order; i++) {
    const b = bars[i]
    let isHigh = true
    let isLow = true
    for (let j = i - order; j <= i + order; j++) {
      if (j === i) continue
      if (bars[j].high > b.high) isHigh = false
      if (bars[j].low < b.low) isLow = false
    }
    if (isHigh) pivots.push({ price: b.high, time: b.time })
    if (isLow) pivots.push({ price: b.low, time: b.time })
  }
  if (!pivots.length) return []

  pivots.sort((a, b) => a.price - b.price)
  const clusters: Cluster[] = []
  for (const p of pivots) {
    const last = clusters[clusters.length - 1]
    if (last && Math.abs(p.price - last.sum / last.touches) <= atr * s.mergeAtr) {
      last.sum += p.price
      last.touches += 1
      last.min = Math.min(last.min, p.price)
      last.max = Math.max(last.max, p.price)
      last.firstTime = Math.min(last.firstTime, p.time)
      last.lastTime = Math.max(last.lastTime, p.time)
    } else {
      clusters.push({ sum: p.price, touches: 1, min: p.price, max: p.price, firstTime: p.time, lastTime: p.time })
    }
  }

  // The range's floor and ceiling: price bounced there though no bar is a textbook pivot.
  // Joining a level, it lends its touches but not its spread or first touch (as the panel).
  for (const side of ['low', 'high'] as const) {
    const r = rangeLevel(bars, atr, side, s)
    if (!r) continue
    const near = clusters.find((c) => Math.abs(c.sum / c.touches - r.level) <= atr * s.rangeTolAtr)
    if (near) {
      const t = Math.max(near.touches, r.touches)
      near.sum = (near.sum / near.touches) * t
      near.touches = t
      near.lastTime = Math.max(near.lastTime, r.lastTime)
      near.range = true
    } else {
      const { level, ...rest } = r
      clusters.push({ ...rest, sum: level * r.touches, range: true })
    }
  }

  const lastTime = bars[bars.length - 1].time
  const span = Math.max(1, lastTime - bars[0].time)
  const zones: RobexZone[] = clusters.map((c) => {
    const level = c.sum / c.touches
    const thick = Math.min(Math.max(c.max - c.min, atr * s.minThickAtr), atr * s.maxThickAtr)
    return {
      label: '',
      kind: level > price ? 'resistance' : 'support',
      level,
      top: level + thick / 2,
      bottom: level - thick / 2,
      touches: c.touches,
      min: c.min,
      max: c.max,
      firstTime: c.firstTime,
      lastTime: c.lastTime,
      strength: c.touches + 1.5 * (1 - (lastTime - c.lastTime) / span),
      range: !!c.range,
    }
  })

  const pick = (list: RobexZone[], byDistance: (a: RobexZone, b: RobexZone) => number) => {
    const sorted = list.sort(byDistance)
    const strong = sorted.filter((z) => z.touches >= 2)
    return (strong.length ? strong : sorted).slice(0, Math.max(0, s.perSide))
  }
  const above = pick(zones.filter((z) => z.kind === 'resistance'), (a, b) => a.level - b.level)
  const below = pick(zones.filter((z) => z.kind === 'support'), (a, b) => b.level - a.level)
  above.forEach((z, k) => (z.label = `R${k + 1}`))
  below.forEach((z, k) => (z.label = `S${k + 1}`))
  return [...above, ...below]
}

export interface DayKey {
  name: string
  price: number
}

/** Yesterday's and today's high and low (UTC days), as the panel's map marks them. */
export function dayKeys(bars: readonly Bar[]): DayKey[] {
  const last = bars[bars.length - 1]
  if (!last) return []
  const today = Math.floor(last.time / 86400) * 86400
  const out: DayKey[] = []
  for (const [day, name] of [
    [today - 86400, 'yesterday'],
    [today, 'today'],
  ] as const) {
    const inDay = bars.filter((b) => b.time >= day && b.time < day + 86400)
    // Yesterday only when the window holds all of it.
    if (!inDay.length || (name === 'yesterday' && bars[0].time > day)) continue
    out.push({ name: `High ${name}`, price: Math.max(...inDay.map((b) => b.high)) })
    out.push({ name: `Low ${name}`, price: Math.min(...inDay.map((b) => b.low)) })
  }
  return out
}

// ── the indicator ───────────────────────────────────────────────────────────

/** The panel's colours: rgb(255, 69, 105) and rgb(0, 230, 118). */
const RED = '#ff4569'
const GREEN = '#00e676'
const KEY = '#94a3b8'

const TIMEFRAMES: Record<string, number | null> = { '15m': 900, '5m': 300, '1h': 3600, Chart: null }

const num = (v: InputValue, min: number) => Math.max(min, Number(v) || 0)

function sourceSeconds(i: Record<string, InputValue>, chartSeconds: number): number {
  return TIMEFRAMES[String(i.timeframe)] ?? chartSeconds
}

export const robexSrZones: IndicatorDef = {
  type: 'robexSrZones',
  name: 'Robex S/R Zones',
  short: 'Robex S/R',
  category: 'Price Action',
  overlay: true,
  format: 'price',
  inputs: [
    { key: 'timeframe', label: 'Candles', type: 'select', default: '15m', options: Object.keys(TIMEFRAMES) },
    { key: 'window', label: 'Bars in the window', type: 'int', default: 300, min: 20, max: 5000 },
    { key: 'pivotOrder', label: 'Pivot bars each side', type: 'int', default: 3, min: 1, max: 50 },
    { key: 'perSide', label: 'Levels per side', type: 'int', default: 1, min: 1, max: 10 },
    { key: 'atrPeriod', label: 'ATR length', type: 'int', default: 14, min: 1, max: 500, group: 'Levels', hideInTitle: true },
    { key: 'mergeAtr', label: 'Merge pivots within (ATR)', type: 'float', default: 0.5, min: 0, max: 10, step: 0.05, group: 'Levels', hideInTitle: true },
    { key: 'minThickAtr', label: 'Thinnest zone (ATR)', type: 'float', default: 0.12, min: 0, max: 10, step: 0.01, group: 'Levels', hideInTitle: true },
    { key: 'maxThickAtr', label: 'Thickest zone (ATR)', type: 'float', default: 0.4, min: 0, max: 10, step: 0.01, group: 'Levels', hideInTitle: true },
    { key: 'rangeBars', label: 'Range: last bars', type: 'int', default: 12, min: 3, max: 500, group: 'Range floor / ceiling', hideInTitle: true },
    { key: 'rangeTolAtr', label: 'Range: same touch within (ATR)', type: 'float', default: 0.2, min: 0, max: 10, step: 0.05, group: 'Range floor / ceiling', hideInTitle: true },
    { key: 'rangeMinTouches', label: 'Range: touches needed', type: 'int', default: 3, min: 2, max: 50, group: 'Range floor / ceiling', hideInTitle: true },
    { key: 'showTouches', label: 'Touches in the label', type: 'bool', default: true, group: 'Drawing' },
    { key: 'showLine', label: 'Line at the exact level', type: 'bool', default: false, group: 'Drawing' },
    { key: 'showDayKeys', label: "Yesterday's and today's high / low (UTC)", type: 'bool', default: true, group: 'Drawing' },
  ],
  plots: [
    { key: 'resistance', title: 'Resistance', kind: 'value', color: RED },
    { key: 'support', title: 'Support', kind: 'value', color: GREEN },
  ],
  feeds: (i, chart) => {
    const seconds = sourceSeconds(i, chart.seconds)
    return seconds === chart.seconds ? [] : [seconds]
  },
  compute: (bars, i, st, ctx) => {
    const seconds = sourceSeconds(i, ctx.interval.seconds)
    const all = seconds === ctx.interval.seconds ? bars : ctx.feed(seconds)
    const source = all.slice(-Math.round(num(i.window, 20)))
    const zones = computeRobexZones(source, {
      pivotOrder: Math.round(num(i.pivotOrder, 1)),
      atrPeriod: Math.round(num(i.atrPeriod, 1)),
      mergeAtr: num(i.mergeAtr, 0),
      minThickAtr: num(i.minThickAtr, 0),
      maxThickAtr: num(i.maxThickAtr, 0),
      perSide: Math.round(num(i.perSide, 1)),
      rangeBars: Math.round(num(i.rangeBars, 3)),
      rangeTolAtr: num(i.rangeTolAtr, 0),
      rangeMinTouches: Math.round(num(i.rangeMinTouches, 2)),
    })
    // Whole dollars for BTC-sized prices, as the panel prints them.
    const lastClose = source.length ? source[source.length - 1].close : 0
    const digits = lastClose >= 1000 ? 0 : lastClose >= 1 ? 2 : 5
    const drawings: Drawing[] = []
    const values = { resistance: bars.map(() => NaN), support: bars.map(() => NaN) }

    for (const z of zones) {
      const style = st[z.kind]
      if (style?.visible === false) continue
      const color = style?.color ?? (z.kind === 'resistance' ? RED : GREEN)
      // From the first touch (or the chart's first bar) on to the price axis.
      const x1 = Math.max(0, ctx.timeToIndex(z.firstTime))
      drawings.push({ type: 'box', x1, x2: 'end', top: z.top, bottom: z.bottom, fill: alpha(color, Math.min(0.3, 0.16 + 0.03 * z.touches)), extendRight: true })
      for (const edge of [z.top, z.bottom])
        drawings.push({ type: 'line', x1, y1: edge, x2: 'end', y2: edge, color: alpha(color, 0.28), width: 1, extendRight: true })
      if (i.showLine) drawings.push({ type: 'line', x1, y1: z.level, x2: 'end', y2: z.level, color: alpha(color, 0.95), width: 2, extendRight: true })
      drawings.push({
        type: 'text',
        x: 'end',
        y: z.level,
        text: `${z.label} ${formatPrice(z.level, digits)}${i.showTouches ? ` · ${z.touches}` : ''}`,
        color: '#0b0f17',
        bg: alpha(color, 0.95),
        size: 10,
        weight: 700,
        align: 'left',
        dx: 14,
      })
      // The legend's value: the first level of its side, over the bars its zone spans.
      if (z.label.endsWith('1')) {
        const from = Math.max(0, Math.ceil(x1))
        for (let k = from; k < bars.length; k++) values[z.kind][k] = z.level
      }
    }

    if (i.showDayKeys) {
      for (const k of dayKeys(source)) {
        drawings.push({ type: 'line', x1: 0, y1: k.price, x2: 'end', y2: k.price, color: alpha(KEY, 0.7), width: 1, dash: [2, 4], extendRight: true })
        drawings.push({ type: 'text', x: 'end', y: k.price, text: `${k.name} ${formatPrice(k.price, digits)}`, color: '#cbd5e1', bg: 'rgba(11, 14, 21, 0.92)', size: 10, align: 'left', dx: 14 })
      }
    }
    return { values, drawings }
  },
}
