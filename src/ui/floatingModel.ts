/**
 * The floating indicator windows (V2's oscillator windows): what one window draws — the last bars
 * of an oscillator's own output, zoomed to their own scale — and the call it reads for the bar in
 * view. No React, so it can be tested without a browser.
 *
 * Only indicators that live in a pane of their own get a window (RSI, MACD, Stochastic, TMO…):
 * those read on their own. Overlays — TUX, Support and Resistance, SMC, moving averages — mean
 * something only on the candles, so they stay on the chart.
 *
 * The window is a view of the indicator, never a second opinion: it draws the output the pane
 * plots, so the two can never disagree. Its y scale follows V2's rules: an oscillator read around
 * zero gets a scale symmetric about zero (a histogram's sign still reads at any zoom), anything
 * else spans its own lows and highs, padded, and level lines appear once the scale reaches them.
 */
import type { Candle } from '../data/types'
import type { Drawing, IndicatorDef, Output, PlotStyle } from '../indicators/types'

export const FLOAT_MIN_BARS = 8
export const FLOAT_MAX_BARS = 120
export const FLOAT_DEFAULT_BARS = 30

/** The plot's size in view units; the card draws it at this size. */
export const FLOAT_PLOT = { width: 226, height: 104, padTop: 8, padBottom: 8 } as const

/** Share of the window's own range left as air above and below the extremes. */
const EDGE_PADDING = 0.14

/** Indicators that can have a floating window: the ones in a pane of their own. */
export const canFloat = (def: IndicatorDef | undefined) => !!def && !def.overlay

/** One step of the ± bars buttons: small while the window is tight. */
export const floatStep = (bars: number) => (bars < 32 ? 4 : 8)

export function clampBars(value: unknown): number {
  const n = Math.round(Number(value))
  if (value === undefined || value === null || !Number.isFinite(n)) return FLOAT_DEFAULT_BARS
  return Math.min(FLOAT_MAX_BARS, Math.max(FLOAT_MIN_BARS, n))
}

export type Tone = 'bull' | 'bear' | 'ob' | 'os' | 'flat'

export interface Verdict {
  text: string
  tone: Tone
}

export interface FloatLine {
  key: string
  title: string
  color: string
  width: number
  kind: 'line' | 'step' | 'dots'
  /** Oldest first, one per bar in the window; null where the plot has no value. */
  values: (number | null)[]
  /** Per-bar colours (Pine's colour per bar): a segment takes the colour of the bar it ends on. */
  colors?: (string | undefined)[]
}

export interface FloatHistogram {
  key: string
  values: (number | null)[]
  colors: string[]
}

export interface FloatFill {
  from: (number | null)[]
  to: (number | null)[]
  color: string
  colorBelow?: string
}

/** A plotshape / triangle: `x` is the bar in the window, `y` the value it is anchored to. */
export interface FloatMark {
  x: number
  y: number
  up: boolean
  color: string
}

export interface FloatSegment {
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
  width: number
  dash?: number[]
}

export interface FloatText {
  x: number
  y: number
  text: string
  color: string
  /** Pixels: negative is up. */
  dy: number
}

export interface FloatModel {
  /** The chart bar the window starts on, and how many bars it holds. */
  start: number
  count: number
  lines: FloatLine[]
  histograms: FloatHistogram[]
  fills: FloatFill[]
  levels: { value: number; color: string; dashed: boolean }[]
  marks: FloatMark[]
  segments: FloatSegment[]
  texts: FloatText[]
  domain: { min: number; max: number }
  /** Symmetric about zero (an oscillator read around it). */
  centered: boolean
}

export interface ModelInput {
  def: IndicatorDef
  out: Output
  bars: readonly Candle[]
  styles: Record<string, PlotStyle>
  /** The newest bar in the window (the chart's bar index), and how many bars it shows. */
  end: number
  count: number
}

const finite = (v: number | undefined): number | null => (v !== undefined && Number.isFinite(v) ? v : null)
const visible = (styles: Record<string, PlotStyle>, key: string) => styles[key]?.visible !== false

/** Fully transparent: Pine's na colour, a gap in the line. */
export const isClear = (color: string | undefined) => !!color && /rgba\([^)]*,\s*0\s*\)$/.test(color)

export function buildModel({ def, out, bars, styles, end, count }: ModelInput): FloatModel {
  const last = Math.min(end, bars.length - 1)
  const start = Math.max(0, last - count + 1)
  const n = Math.max(0, last - start + 1)
  const numbers = (xs: readonly number[] | undefined) => Array.from({ length: n }, (_, k) => finite(xs?.[start + k]))

  const lines: FloatLine[] = []
  const histograms: FloatHistogram[] = []
  for (const plot of def.plots) {
    if (plot.kind === 'value' || !visible(styles, plot.key)) continue
    const style = styles[plot.key]
    const values = numbers(out.values[plot.key])
    const perBar = out.colors?.[plot.key]
    const colors = perBar ? Array.from({ length: n }, (_, k) => perBar[start + k]) : undefined
    const color = style?.color ?? plot.color
    if (plot.kind === 'histogram') histograms.push({ key: plot.key, values, colors: values.map((_, k) => colors?.[k] ?? color) })
    else lines.push({ key: plot.key, title: plot.title, color, width: style?.width ?? plot.width ?? 1, kind: plot.kind, values, colors })
  }

  const fills: FloatFill[] = (def.fills ?? []).map((f) => ({
    from: typeof f.from === 'number' ? Array<number>(n).fill(f.from) : numbers(out.values[f.from]),
    to: typeof f.to === 'number' ? Array<number>(n).fill(f.to) : numbers(out.values[f.to]),
    color: f.color,
    colorBelow: f.colorBelow,
  }))

  const { domain, centered } = paneDomain(
    [...lines.map((l) => l.values), ...histograms.map((h) => h.values)],
    histograms.length > 0,
  )
  const levels = (def.levels ?? [])
    .filter((l) => l.value >= domain.min && l.value <= domain.max)
    .map((l) => ({ value: l.value, color: l.color, dashed: l.style !== 'solid' }))

  const drawn = placeDrawings(out.drawings ?? [], start, last, bars.length - 1)
  return { start, count: n, lines, histograms, fills, levels, ...drawn, domain, centered }
}

/**
 * V2's two scales: around zero when the window has values on both sides of it (MACD, momentum),
 * from zero for a histogram that stays on one side of it, otherwise the window's own range.
 */
export function paneDomain(series: (number | null)[][], histogram: boolean) {
  let min = Infinity
  let max = -Infinity
  for (const values of series)
    for (const v of values)
      if (v !== null) {
        min = Math.min(min, v)
        max = Math.max(max, v)
      }
  if (!Number.isFinite(min)) return { domain: { min: 0, max: 1 }, centered: false }
  if (min < 0 && max > 0) {
    const bound = Math.max(-min, max) * (1 + EDGE_PADDING)
    return { domain: { min: -bound, max: bound }, centered: true }
  }
  if (histogram && min >= 0) return { domain: { min: 0, max: (max || 1) * (1 + EDGE_PADDING) }, centered: false }
  if (histogram && max <= 0) return { domain: { min: (min || -1) * (1 + EDGE_PADDING), max: 0 }, centered: false }
  if (min === max) {
    const pad = Math.abs(min) * EDGE_PADDING || 1
    return { domain: { min: min - pad, max: max + pad }, centered: false }
  }
  const pad = (max - min) * EDGE_PADDING
  return { domain: { min: min - pad, max: max + pad }, centered: false }
}

const UP_SHAPES = new Set(['triangleUp', 'arrowUp', 'plotArrowUp', 'labelUp'])

/** The indicator's own drawings (divergence lines and tags, signal triangles) inside the window. */
function placeDrawings(drawings: Drawing[], start: number, last: number, newest: number) {
  const marks: FloatMark[] = []
  const segments: FloatSegment[] = []
  const texts: FloatText[] = []
  const at = (x: number | 'end') => (x === 'end' ? newest : x)
  const inside = (x: number) => x >= start - 0.5 && x <= last + 0.5
  for (const d of drawings) {
    if (d.type === 'shape' && inside(d.x)) marks.push({ x: d.x - start, y: d.y, up: UP_SHAPES.has(d.shape), color: d.color })
    else if (d.type === 'triangle' && inside(d.x)) marks.push({ x: d.x - start, y: d.y, up: d.dir === 'up', color: d.color })
    else if (d.type === 'line') {
      const x2 = d.extendRight ? Infinity : at(d.x2)
      if (Math.max(d.x1, x2) < start || Math.min(d.x1, x2) > last) continue
      const to = Number.isFinite(x2) ? x2 - start : last - start + 1
      segments.push({ x1: d.x1 - start, y1: d.y1, x2: to, y2: d.y2, color: d.color, width: d.width ?? 1, dash: d.dash })
    } else if (d.type === 'text') {
      const x = at(d.x)
      if (!d.bg && inside(x)) texts.push({ x: x - start, y: d.y, text: d.text, color: d.color, dy: d.dy ?? 0 })
    }
  }
  return { marks, segments, texts }
}

// ── the call ─────────────────────────────────────────────────────────────

/** A signal older than this many bars no longer makes the call: the lines do. */
export const SIGNAL_BARS = 5
const SIGNAL_WORD =/\b(buy|sell|bull|bear|long|short)\b/i
const BULL_WORD = /\b(buy|bull|long)\b/i

/**
 * What the window says about bar `i`. In order: past the outer levels (overbought / oversold);
 * a signal the indicator drew in the last few bars (its triangles, divergence tags); then how
 * its lines sit — the first against the second (a cross on this bar), or a lone line or
 * histogram rising or falling.
 */
export function verdictAt(input: ModelInput & { i: number }, model: FloatModel): Verdict {
  const { def, out, styles, i } = input
  const value = (key: string, k = i) => finite(out.values[key]?.[k])
  const lines = def.plots.filter((p) => (p.kind === 'line' || p.kind === 'step') && visible(styles, p.key) && value(p.key) !== null)
  const histogram = def.plots.find((p) => p.kind === 'histogram' && visible(styles, p.key) && value(p.key) !== null)

  if (lines.length && def.levels && def.levels.length >= 2) {
    const v = value(lines[0].key)!
    const top = Math.max(...def.levels.map((l) => l.value))
    const bottom = Math.min(...def.levels.map((l) => l.value))
    if (top > bottom && v >= top) return { text: 'OVERBOUGHT', tone: 'ob' }
    if (top > bottom && v <= bottom) return { text: 'OVERSOLD', tone: 'os' }
  }

  const signal = lastSignal(out.drawings ?? [], Math.max(model.start, i - SIGNAL_BARS + 1), i)
  if (signal) {
    const ago = i - signal.x
    const when = ago <= 0 ? 'this bar' : ago === 1 ? '1 bar ago' : `${ago} bars ago`
    return { text: `${signal.text} · ${when}`, tone: signal.up ? 'bull' : 'bear' }
  }

  if (lines.length >= 2) {
    const [a, b] = lines
    const now = value(a.key)! - value(b.key)!
    const pa = value(a.key, i - 1)
    const pb = value(b.key, i - 1)
    const before = pa !== null && pb !== null ? pa - pb : null
    if (before !== null && before <= 0 && now > 0) return { text: 'BULL CROSS', tone: 'bull' }
    if (before !== null && before >= 0 && now < 0) return { text: 'BEAR CROSS', tone: 'bear' }
    return { text: `${a.title} ${now >= 0 ? '>' : '<'} ${b.title}`.toUpperCase(), tone: now >= 0 ? 'bull' : 'bear' }
  }

  const lone = lines[0] ?? histogram
  if (!lone) return { text: '—', tone: 'flat' }
  const v = value(lone.key)!
  const prev = value(lone.key, i - 1)
  const side = model.centered ? (v >= 0 ? ' · ABOVE 0' : ' · BELOW 0') : ''
  if (prev === null || prev === v) return { text: `FLAT${side}`, tone: 'flat' }
  return v > prev ? { text: `RISING${side}`, tone: 'bull' } : { text: `FALLING${side}`, tone: 'bear' }
}

/** The newest signal drawn from bar `start` to bar `i`; a worded one wins a tie. */
function lastSignal(drawings: Drawing[], start: number, i: number) {
  let best: { x: number; up: boolean; text: string; worded: boolean } | null = null
  const consider = (x: number, up: boolean, text: string | undefined) => {
    if (x < start || x > i) return
    const worded = !!text
    if (!best || x > best.x || (x === best.x && worded && !best.worded))
      best = { x, up, text: (text || (up ? 'Up' : 'Down')).toUpperCase(), worded }
  }
  for (const d of drawings) {
    if (d.type === 'shape') consider(d.x, UP_SHAPES.has(d.shape), d.text)
    else if (d.type === 'triangle') consider(d.x, d.dir === 'up', undefined)
    else if (d.type === 'text' && typeof d.x === 'number' && !d.bg && SIGNAL_WORD.test(d.text))
      consider(Math.round(d.x), BULL_WORD.test(d.text), d.text)
  }
  return best as { x: number; up: boolean; text: string } | null
}
