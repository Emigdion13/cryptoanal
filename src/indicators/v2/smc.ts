/**
 * Smart Money Concepts, ported from btcAnalyzerV2 (src/lib/smart-money-concepts.ts and the SMC
 * overlay in ChartView.tsx): confirmed pivots, close-based BOS/CHoCH, opposite-candle order
 * blocks, three-candle fair value gaps, ATR-scaled equal highs/lows, previous day/week/month
 * highs and lows, strong/weak highs and lows, and premium/discount zones. LuxAlgo's defaults.
 */
import type { Candle } from '../../data/types'
import type { Drawing } from '../types'

export type SMCStructureFilter = 'All' | 'BOS' | 'CHoCH'
export type SMCLabelSize = 'Tiny' | 'Small' | 'Normal'
export type SMCLineStyle = '⎯⎯⎯' | '----' | '····'

export interface SmcSettings {
  mode: 'Historical' | 'Present'
  style: 'Colored' | 'Monochrome'
  showInternal: boolean
  internalBullish: SMCStructureFilter
  internalBearish: SMCStructureFilter
  internalLabelSize: SMCLabelSize
  confluenceFilter: boolean
  showSwing: boolean
  swingBullish: SMCStructureFilter
  swingBearish: SMCStructureFilter
  swingLabelSize: SMCLabelSize
  showSwingPoints: boolean
  showStrongWeakHighsLows: boolean
  swingLength: number
  showInternalOrderBlocks: boolean
  internalOrderBlockCount: number
  showSwingOrderBlocks: boolean
  swingOrderBlockCount: number
  orderBlockFilter: 'Atr' | 'Cumulative Mean Range'
  orderBlockMitigation: 'High/Low' | 'Close'
  highlightMitigatedBlocks: boolean
  showEqualHighLow: boolean
  equalHighLowBars: number
  equalHighLowThreshold: number
  equalHighLowLabelSize: SMCLabelSize
  showFairValueGaps: boolean
  fvgAutoThreshold: boolean
  fvgExtend: number
  showDailyHighLow: boolean
  dailyLineStyle: SMCLineStyle
  showWeeklyHighLow: boolean
  weeklyLineStyle: SMCLineStyle
  showMonthlyHighLow: boolean
  monthlyLineStyle: SMCLineStyle
  showPremiumDiscount: boolean
}

export const SMC_DEFAULTS: SmcSettings = {
  mode: 'Historical',
  style: 'Colored',
  showInternal: true,
  internalBullish: 'All',
  internalBearish: 'All',
  internalLabelSize: 'Tiny',
  confluenceFilter: false,
  showSwing: true,
  swingBullish: 'All',
  swingBearish: 'All',
  swingLabelSize: 'Small',
  showSwingPoints: true,
  showStrongWeakHighsLows: true,
  swingLength: 50,
  showInternalOrderBlocks: true,
  internalOrderBlockCount: 5,
  showSwingOrderBlocks: true,
  swingOrderBlockCount: 5,
  orderBlockFilter: 'Atr',
  orderBlockMitigation: 'High/Low',
  highlightMitigatedBlocks: true,
  showEqualHighLow: true,
  equalHighLowBars: 3,
  equalHighLowThreshold: 0.1,
  equalHighLowLabelSize: 'Tiny',
  showFairValueGaps: true,
  fvgAutoThreshold: true,
  fvgExtend: 1,
  showDailyHighLow: true,
  dailyLineStyle: '⎯⎯⎯',
  showWeeklyHighLow: true,
  weeklyLineStyle: '⎯⎯⎯',
  showMonthlyHighLow: true,
  monthlyLineStyle: '⎯⎯⎯',
  showPremiumDiscount: true,
}

const SMC_COLORS = {
  internalBull: '#2962ff',
  internalBear: '#f23645',
  swingBull: '#089981',
  swingBear: '#f23645',
  bullOrderBlock: '#2962ff',
  bearOrderBlock: '#f23645',
  bullFvg: '#089981',
  bearFvg: '#f23645',
  premium: '#f23645',
  equilibrium: '#787b86',
  discount: '#2962ff',
  muted: '#636363',
}
type Palette = typeof SMC_COLORS

function palette(s: SmcSettings): Palette {
  if (s.style !== 'Monochrome') return SMC_COLORS
  const mono = '#b2b5be'
  return {
    internalBull: mono,
    internalBear: mono,
    swingBull: mono,
    swingBear: mono,
    bullOrderBlock: mono,
    bearOrderBlock: '#7d8490',
    bullFvg: mono,
    bearFvg: '#7d8490',
    premium: '#8b919b',
    equilibrium: mono,
    discount: '#8b919b',
    muted: '#636363',
  }
}

const labelSize = (size: SMCLabelSize) => (size === 'Tiny' ? 8 : size === 'Small' ? 10 : 12)

/** "#rrggbb" with an opacity. */
function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

// ── calculation (V2, unchanged) ─────────────────────────────────────────────

type Side = 'bullish' | 'bearish'
type StructureKind = 'internal' | 'swing'

interface Pivot {
  index: number
  confirmedAt: number
  kind: 'high' | 'low'
  price: number
  label: 'HH' | 'LH' | 'HL' | 'LL'
}

interface StructureEvent {
  kind: StructureKind
  side: Side
  type: 'BOS' | 'CHoCH'
  pivotIndex: number
  breakIndex: number
  price: number
}

interface OrderBlock {
  id: string
  kind: StructureKind
  side: Side
  startIndex: number
  createdIndex: number
  top: number
  bottom: number
  mitigatedAt?: number
  invalidatedAt?: number
}

interface EqualLevel {
  side: 'high' | 'low'
  firstIndex: number
  secondIndex: number
  price: number
}

interface FairValueGap {
  side: Side
  startIndex: number
  endIndex: number
  top: number
  bottom: number
  mitigatedAt?: number
}

interface PreviousHighLow {
  timeframe: 'D' | 'W' | 'M'
  startIndex: number
  endIndex: number
  high: number
  low: number
  style: SMCLineStyle
}

const INTERNAL_PIVOT_LENGTH = 3

/** Confirmed symmetric high/low pivots, available `length` bars after they print. */
export function findSmcPivots(candles: readonly Candle[], length: number): Pivot[] {
  const raw: Omit<Pivot, 'label'>[] = []
  for (let index = length; index < candles.length - length; index++) {
    const candle = candles[index]
    let isHigh = true
    let isLow = true
    for (let cursor = index - length; cursor <= index + length; cursor++) {
      if (cursor === index) continue
      if (candles[cursor].high >= candle.high) isHigh = false
      if (candles[cursor].low <= candle.low) isLow = false
      if (!isHigh && !isLow) break
    }
    if (isHigh) raw.push({ index, confirmedAt: index + length, kind: 'high', price: candle.high })
    if (isLow) raw.push({ index, confirmedAt: index + length, kind: 'low', price: candle.low })
  }
  raw.sort((a, b) => a.index - b.index || (a.kind === 'high' ? -1 : 1))
  let priorHigh: number | undefined
  let priorLow: number | undefined
  return raw.map((pivot) => {
    let label: Pivot['label']
    if (pivot.kind === 'high') {
      label = priorHigh === undefined || pivot.price > priorHigh ? 'HH' : 'LH'
      priorHigh = pivot.price
    } else {
      label = priorLow === undefined || pivot.price < priorLow ? 'LL' : 'HL'
      priorLow = pivot.price
    }
    return { ...pivot, label }
  })
}

/** Wilder-like seeded running ATR that stays defined on a short chart. */
export function smcAtr(candles: readonly Candle[], length = 14): number[] {
  let sum = 0
  let prior = 0
  return candles.map((candle, index) => {
    const previous = candles[index - 1]?.close
    const range =
      previous === undefined
        ? candle.high - candle.low
        : Math.max(candle.high - candle.low, Math.abs(candle.high - previous), Math.abs(candle.low - previous))
    sum += range
    if (index < length) return (prior = sum / (index + 1))
    return (prior = (prior * (length - 1) + range) / length)
  })
}

function cumulativeMeanRanges(candles: readonly Candle[]): number[] {
  let total = 0
  return candles.map((candle, index) => (total += candle.high - candle.low) / (index + 1))
}

function concordant(candle: Candle, side: Side): boolean {
  const midpoint = (candle.high + candle.low) / 2
  return side === 'bullish'
    ? candle.close >= candle.open && candle.close >= midpoint
    : candle.close <= candle.open && candle.close <= midpoint
}

function structureEvents(candles: readonly Candle[], pivots: Pivot[], kind: StructureKind, confluence: boolean) {
  const confirmed = new Map<number, Pivot[]>()
  for (const pivot of pivots) confirmed.set(pivot.confirmedAt, [...(confirmed.get(pivot.confirmedAt) ?? []), pivot])
  let high: Pivot | undefined
  let low: Pivot | undefined
  let highBroken = false
  let lowBroken = false
  let currentTrend = 0
  const trend: number[] = []
  const events: StructureEvent[] = []
  for (let index = 0; index < candles.length; index++) {
    for (const pivot of confirmed.get(index) ?? []) {
      if (pivot.kind === 'high') {
        high = pivot
        highBroken = false
      } else {
        low = pivot
        lowBroken = false
      }
    }
    const candle = candles[index]
    if (high && !highBroken && candle.close > high.price && (!confluence || concordant(candle, 'bullish'))) {
      events.push({ kind, side: 'bullish', type: currentTrend < 0 ? 'CHoCH' : 'BOS', pivotIndex: high.index, breakIndex: index, price: high.price })
      highBroken = true
      currentTrend = 1
    } else if (low && !lowBroken && candle.close < low.price && (!confluence || concordant(candle, 'bearish'))) {
      events.push({ kind, side: 'bearish', type: currentTrend > 0 ? 'CHoCH' : 'BOS', pivotIndex: low.index, breakIndex: index, price: low.price })
      lowBroken = true
      currentTrend = -1
    }
    trend.push(currentTrend)
  }
  return { events, trend, finalTrend: currentTrend }
}

function orderBlocks(
  candles: readonly Candle[],
  events: StructureEvent[],
  s: SmcSettings,
  atr: number[],
  meanRange: number[],
  count: number,
): OrderBlock[] {
  const unique = new Map<string, OrderBlock>()
  for (const event of events) {
    const expectedBearish = event.side === 'bullish'
    for (let index = event.breakIndex - 1; index >= Math.max(0, event.pivotIndex); index--) {
      const candle = candles[index]
      const opposite = expectedBearish ? candle.close < candle.open : candle.close > candle.open
      const filter = s.orderBlockFilter === 'Atr' ? atr[index] : meanRange[index]
      if (!opposite || candle.high - candle.low > filter * 2) continue
      const block: OrderBlock = {
        id: `${event.kind}:${event.side}:${event.pivotIndex}:${event.breakIndex}:${index}`,
        kind: event.kind,
        side: event.side,
        startIndex: index,
        createdIndex: event.breakIndex,
        top: candle.high,
        bottom: candle.low,
      }
      // Settle: touched (mitigated) or broken through (invalidated, then removed).
      for (let k = block.createdIndex + 1; k < candles.length; k++) {
        const c = candles[k]
        const test = s.orderBlockMitigation === 'Close' ? c.close : block.side === 'bullish' ? c.low : c.high
        if (block.side === 'bullish' ? test < block.bottom : test > block.top) {
          block.invalidatedAt = k
          break
        }
        if ((block.side === 'bullish' ? test <= block.top : test >= block.bottom) && block.mitigatedAt === undefined)
          block.mitigatedAt = k
      }
      unique.set(block.id, block)
      break
    }
  }
  return [...unique.values()]
    .filter((block) => block.invalidatedAt === undefined)
    .sort((a, b) => b.createdIndex - a.createdIndex)
    .slice(0, count)
}

function equalLevels(candles: readonly Candle[], pivots: Pivot[], s: SmcSettings): EqualLevel[] {
  const atr = smcAtr(candles)
  let previousHigh: Pivot | undefined
  let previousLow: Pivot | undefined
  const levels: EqualLevel[] = []
  for (const pivot of pivots) {
    const prior = pivot.kind === 'high' ? previousHigh : previousLow
    if (prior && Math.abs(prior.price - pivot.price) <= atr[pivot.index] * s.equalHighLowThreshold)
      levels.push({ side: pivot.kind, firstIndex: prior.index, secondIndex: pivot.index, price: (prior.price + pivot.price) / 2 })
    if (pivot.kind === 'high') previousHigh = pivot
    else previousLow = pivot
  }
  return levels
}

function fairValueGaps(candles: readonly Candle[], s: SmcSettings): FairValueGap[] {
  const atr = smcAtr(candles)
  const gaps: FairValueGap[] = []
  for (let index = 2; index < candles.length; index++) {
    const first = candles[index - 2]
    const middle = candles[index - 1]
    const last = candles[index]
    const bullish = last.low > first.high && middle.close >= middle.open
    const bearish = last.high < first.low && middle.close <= middle.open
    if (!bullish && !bearish) continue
    const top = bullish ? last.low : first.low
    const bottom = bullish ? first.high : last.high
    if (s.fvgAutoThreshold && top - bottom < atr[index] * 0.1) continue
    let mitigatedAt: number | undefined
    for (let future = index + 1; future < candles.length; future++)
      if (bullish ? candles[future].low <= bottom : candles[future].high >= top) {
        mitigatedAt = future
        break
      }
    gaps.push({
      side: bullish ? 'bullish' : 'bearish',
      startIndex: index - 1,
      endIndex: mitigatedAt ?? Math.min(candles.length - 1, index + s.fvgExtend),
      top,
      bottom,
      mitigatedAt,
    })
  }
  return gaps
}

function calendarBucket(time: number, timeframe: 'D' | 'W' | 'M'): string {
  const date = new Date(time * 1000)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth()
  if (timeframe === 'M') return `${year}-${month}`
  if (timeframe === 'D') return `${year}-${month}-${date.getUTCDate()}`
  const monday = new Date(Date.UTC(year, month, date.getUTCDate()))
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() || 7) + 1)
  return `W-${monday.toISOString().slice(0, 10)}`
}

function previousHighLows(candles: readonly Candle[], timeframe: 'D' | 'W' | 'M', style: SMCLineStyle): PreviousHighLow[] {
  if (!candles.length) return []
  const buckets: { startIndex: number; endIndex: number; high: number; low: number }[] = []
  let key = calendarBucket(candles[0].time, timeframe)
  let current = { startIndex: 0, endIndex: 0, high: candles[0].high, low: candles[0].low }
  for (let index = 1; index < candles.length; index++) {
    const next = calendarBucket(candles[index].time, timeframe)
    if (next !== key) {
      buckets.push(current)
      key = next
      current = { startIndex: index, endIndex: index, high: candles[index].high, low: candles[index].low }
    } else {
      current.endIndex = index
      current.high = Math.max(current.high, candles[index].high)
      current.low = Math.min(current.low, candles[index].low)
    }
  }
  buckets.push(current)
  return buckets.slice(1).map((bucket, index) => ({
    timeframe,
    startIndex: bucket.startIndex,
    endIndex: bucket.endIndex,
    high: buckets[index].high,
    low: buckets[index].low,
    style,
  }))
}

function latestBy<T>(values: T[], key: (value: T) => string): T[] {
  const result = new Map<string, T>()
  for (const value of values) result.set(key(value), value)
  return [...result.values()]
}

export function calculateSmc(candles: readonly Candle[], s: SmcSettings) {
  const internalPivots = findSmcPivots(candles, INTERNAL_PIVOT_LENGTH)
  const swingPivots = findSmcPivots(candles, s.swingLength)
  const internal = structureEvents(candles, internalPivots, 'internal', s.confluenceFilter)
  const swing = structureEvents(candles, swingPivots, 'swing', false)
  const atr = smcAtr(candles)
  const meanRange = cumulativeMeanRanges(candles)
  const high = [...swingPivots].reverse().find((p) => p.kind === 'high')
  const low = [...swingPivots].reverse().find((p) => p.kind === 'low')
  let result = {
    internalEvents: internal.events,
    swingEvents: swing.events,
    swingPivots,
    internalOrderBlocks: orderBlocks(candles, internal.events, s, atr, meanRange, s.internalOrderBlockCount),
    swingOrderBlocks: orderBlocks(candles, swing.events, s, atr, meanRange, s.swingOrderBlockCount),
    equalLevels: equalLevels(candles, findSmcPivots(candles, s.equalHighLowBars), s),
    fairValueGaps: fairValueGaps(candles, s),
    previousHighLows: [
      ...(s.showDailyHighLow ? previousHighLows(candles, 'D', s.dailyLineStyle) : []),
      ...(s.showWeeklyHighLow ? previousHighLows(candles, 'W', s.weeklyLineStyle) : []),
      ...(s.showMonthlyHighLow ? previousHighLows(candles, 'M', s.monthlyLineStyle) : []),
    ],
    range: high && low && high.price > low.price ? { high: high.price, low: low.price, startIndex: Math.min(high.index, low.index) } : undefined,
    swingTrend: swing.finalTrend,
    latestHigh: high,
    latestLow: low,
  }
  // Historical caps the markup; Present keeps only the newest of each kind.
  if (s.mode === 'Historical')
    result = {
      ...result,
      internalEvents: result.internalEvents.slice(-100),
      swingEvents: result.swingEvents.slice(-60),
      swingPivots: result.swingPivots.slice(-30),
      equalLevels: result.equalLevels.slice(-30),
      fairValueGaps: result.fairValueGaps.slice(-40),
      previousHighLows: result.previousHighLows.slice(-24),
    }
  else
    result = {
      ...result,
      internalEvents: latestBy(result.internalEvents, (e) => `${e.side}:${e.type}`),
      swingEvents: latestBy(result.swingEvents, (e) => `${e.side}:${e.type}`),
      swingPivots: latestBy(result.swingPivots, (p) => p.kind),
      equalLevels: latestBy(result.equalLevels, (l) => l.side),
      fairValueGaps: latestBy(result.fairValueGaps, (g) => g.side),
      previousHighLows: latestBy(result.previousHighLows, (l) => l.timeframe),
    }
  return result
}

// ── drawing (V2's SVG overlay, as chart drawings) ───────────────────────────

const allowed = (type: 'BOS' | 'CHoCH', filter: SMCStructureFilter) => filter === 'All' || filter === type
const dash = (style: SMCLineStyle) => (style === '----' ? [7, 4] : style === '····' ? [1, 4] : undefined)

export function smcDrawings(candles: readonly Candle[], s: SmcSettings): Drawing[] {
  if (candles.length < 3) return []
  const r = calculateSmc(candles, s)
  const p = palette(s)
  const last = candles.length - 1
  const out: Drawing[] = []

  if (s.showPremiumDiscount && r.range) {
    const { high, low, startIndex } = r.range
    const span = high - low
    const zones = [
      { label: 'PREMIUM', top: high, bottom: low + span * 0.525, color: p.premium, a: 0.06 },
      { label: 'EQUILIBRIUM', top: low + span * 0.525, bottom: low + span * 0.475, color: p.equilibrium, a: 0.13 },
      { label: 'DISCOUNT', top: low + span * 0.475, bottom: low, color: p.discount, a: 0.06 },
    ]
    for (const z of zones)
      out.push({
        type: 'box',
        x1: startIndex,
        x2: last,
        top: z.top,
        bottom: z.bottom,
        fill: alpha(z.color, z.a),
        border: alpha(z.color, 0.35),
        text: z.label,
        textColor: alpha(z.color, 0.82),
        textSize: 7,
        textAlign: 'center',
      })
  }

  for (const level of r.previousHighLows) {
    const color = alpha(p.equilibrium, 0.82)
    const d = dash(level.style)
    out.push({ type: 'line', x1: level.startIndex, y1: level.high, x2: level.endIndex, y2: level.high, color, dash: d })
    out.push({ type: 'line', x1: level.startIndex, y1: level.low, x2: level.endIndex, y2: level.low, color, dash: d })
    out.push({ type: 'text', x: level.endIndex, y: level.high, text: `P${level.timeframe}H`, color, size: 7, weight: 400, align: 'right', dy: -6 })
    out.push({ type: 'text', x: level.endIndex, y: level.low, text: `P${level.timeframe}L`, color, size: 7, weight: 400, align: 'right', dy: 7 })
  }

  if (s.showFairValueGaps)
    for (const gap of r.fairValueGaps) {
      const color = gap.side === 'bullish' ? p.bullFvg : p.bearFvg
      out.push({
        type: 'box',
        x1: gap.startIndex,
        x2: Math.max(gap.startIndex, gap.endIndex),
        top: gap.top,
        bottom: gap.bottom,
        fill: alpha(color, gap.mitigatedAt === undefined ? 0.13 : 0.05),
        border: alpha(color, 0.58),
        text: 'FVG',
        textColor: color,
        textSize: 7,
      })
    }

  for (const block of [...r.internalOrderBlocks, ...r.swingOrderBlocks]) {
    if (!(block.kind === 'internal' ? s.showInternalOrderBlocks : s.showSwingOrderBlocks)) continue
    const mitigated = block.mitigatedAt !== undefined
    const color = mitigated && s.highlightMitigatedBlocks ? p.muted : block.side === 'bullish' ? p.bullOrderBlock : p.bearOrderBlock
    out.push({
      type: 'box',
      x1: block.startIndex,
      x2: 'end',
      top: block.top,
      bottom: block.bottom,
      fill: alpha(color, mitigated ? 0.09 : 0.18),
      border: alpha(color, mitigated ? 0.45 : 0.9),
      text: `${block.kind === 'internal' ? 'iOB' : 'OB'} ${block.side === 'bullish' ? '+' : '−'}${mitigated ? ' · mitigated' : ''}`,
      textColor: color,
      textSize: 8,
    })
  }

  if (s.showEqualHighLow) {
    const size = labelSize(s.equalHighLowLabelSize)
    for (const level of r.equalLevels) {
      const color = level.side === 'high' ? p.swingBear : p.swingBull
      out.push({ type: 'line', x1: level.firstIndex, y1: level.price, x2: level.secondIndex, y2: level.price, color, dash: [2, 3] })
      out.push({
        type: 'text',
        x: level.secondIndex,
        y: level.price,
        text: level.side === 'high' ? 'EQH' : 'EQL',
        color,
        size,
        dy: level.side === 'high' ? -(size / 2 + 5) : size / 2 + 5,
      })
    }
  }

  for (const event of [...r.internalEvents, ...r.swingEvents]) {
    const internal = event.kind === 'internal'
    const filter =
      event.side === 'bullish' ? (internal ? s.internalBullish : s.swingBullish) : internal ? s.internalBearish : s.swingBearish
    if (!(internal ? s.showInternal : s.showSwing) || !allowed(event.type, filter)) continue
    const color = event.side === 'bullish' ? (internal ? p.internalBull : p.swingBull) : internal ? p.internalBear : p.swingBear
    const size = labelSize(internal ? s.internalLabelSize : s.swingLabelSize)
    out.push({
      type: 'line',
      x1: event.pivotIndex,
      y1: event.price,
      x2: event.breakIndex,
      y2: event.price,
      color,
      width: internal ? 1 : 1.5,
      dash: internal ? [4, 3] : undefined,
    })
    out.push({
      type: 'text',
      x: event.breakIndex,
      y: event.price,
      text: event.type,
      color,
      size,
      dy: event.side === 'bullish' ? -(size / 2 + 5) : size / 2 + 5,
    })
  }

  if (s.showSwing && s.showSwingPoints) {
    const size = labelSize(s.swingLabelSize)
    for (const pivot of r.swingPivots) {
      const bullish = pivot.kind === 'low'
      out.push({
        type: 'text',
        x: pivot.index,
        y: pivot.price,
        text: pivot.label,
        color: bullish ? p.swingBull : p.swingBear,
        size,
        dy: bullish ? size / 2 + 5 : -(size / 2 + 5),
      })
    }
  }

  if (s.showStrongWeakHighsLows) {
    const bullish = r.swingTrend >= 0
    const mark = (pivot: Pivot | undefined, label: string, color: string, below: boolean) => {
      if (!pivot) return
      out.push({ type: 'line', x1: pivot.index, y1: pivot.price, x2: last, y2: pivot.price, color, dash: [3, 3] })
      out.push({ type: 'text', x: last, y: pivot.price, text: label, color, size: 8, align: 'right', dy: below ? 8 : -6 })
    }
    mark(r.latestHigh, bullish ? 'Weak High' : 'Strong High', p.swingBear, false)
    mark(r.latestLow, bullish ? 'Strong Low' : 'Weak Low', p.swingBull, true)
  }
  return out
}
