/**
 * TradingView's drawing tools, each as the shapes it draws from its points. Placing, selecting,
 * dragging and hit-testing are the same for all of them (layer.ts); a tool only says how many
 * points it takes and what it looks like.
 */
import type { Candle } from '../data/types'
import {
  add,
  arrowHead,
  controlThrough,
  cubic,
  dist,
  ellipse,
  extend,
  lerp,
  mid,
  pt,
  quadratic,
  sub,
  type P,
  type PathShape,
  type Shape,
  type TextShape,
} from './geometry'
import type { DrawingPoint, LineDash, UserDrawing } from './types'

/** What a tool's shapes are built from: its points in pixels and a view of the chart. */
export interface BuildCtx {
  d: UserDrawing
  /** The points in pixels; while placing, the ones not placed yet repeat the last. */
  p: P[]
  /** The points as placed: time and price. */
  pts: DrawingPoint[]
  /** The pane's size. */
  w: number
  h: number
  color: string
  width: number
  dash: LineDash
  x: (time: number) => number | null
  y: (price: number) => number | null
  priceAt: (y: number) => number | null
  bars: readonly Candle[]
  /** A time's fractional bar index (runs on before the first bar and past the last). */
  indexAt: (time: number) => number
  barSeconds: number
  fmt: (price: number) => string
}

/** The left toolbar's buttons, each with a flyout of tools. */
export type ToolButton = 'lines' | 'fib' | 'patterns' | 'forecast' | 'shapes' | 'text'

export interface ToolDef {
  id: string
  name: string
  button: ToolButton
  /** The flyout's heading the tool sits under. */
  section: string
  /** Points placed by clicking; 'multi' ends with a double-click or Enter; 'free' records a drag. */
  points: number | 'multi' | 'free'
  /** Style and switches a new drawing starts with. */
  defaults?: Partial<Pick<UserDrawing, 'color' | 'width' | 'dash' | 'fill' | 'text' | 'opts'>>
  /** Points the tool adds after the user's last click (the stop and target of a position). */
  complete?: (pts: DrawingPoint[], view: CompleteView) => DrawingPoint[]
  /** The tool has text the user types. */
  text?: boolean
  /** Lines that can run on past their points. */
  extendable?: boolean
  build: (c: BuildCtx) => Shape[]
}

export interface CompleteView {
  priceAt: (y: number) => number | null
  y: (price: number) => number | null
  /** The time `px` pixels to the right of `time`. */
  timeRight: (time: number, px: number) => number
}

// ── helpers ──────────────────────────────────────────────────────────────

const path = (pts: P[], o: Partial<PathShape> = {}): PathShape => ({ kind: 'path', pts, ...o })
const seg = (a: P, b: P, o: Partial<PathShape> = {}): PathShape => path([a, b], o)
const poly = (pts: P[], fill: string, o: Partial<PathShape> = {}): PathShape => ({ kind: 'path', pts, closed: true, fill, ...o })
const label = (at: P, text: string, o: Partial<TextShape> = {}): TextShape => ({ kind: 'text', at, text, ...o })

/** A hex or rgb color at opacity `a`. */
export function alpha(color: string, a: number): string {
  if (color.startsWith('#')) {
    const h = color.length === 4 ? color.replace(/\w/g, (c) => c + c).slice(1) : color.slice(1, 7)
    const n = parseInt(h, 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
  }
  const m = /rgba?\(([^)]+)\)/.exec(color)
  if (!m) return color
  const [r, g, b] = m[1].split(',').map((s) => s.trim())
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

const faint = (c: BuildCtx, a = 0.15) => alpha(c.color, a)
const line = (c: BuildCtx, a: P, b: P, o: Partial<PathShape> = {}) => seg(a, b, { width: c.width, dash: c.dash, ...o })
/** a→b, run on as the drawing's Extend switches say. */
const extLine = (c: BuildCtx, a: P, b: P, back = false, forward = false, o: Partial<PathShape> = {}) => {
  const [s, e] = extend(a, b, c.w, c.h, back || !!c.d.opts?.extendLeft, forward || !!c.d.opts?.extendRight)
  return line(c, s, e, o)
}
const tag = (c: BuildCtx, at: P, text: string, o: Partial<TextShape> = {}) =>
  label(at, text, { bg: c.color, color: '#ffffff', size: 12, pad: 4, align: 'center', baseline: 'middle', ...o })

function signed(c: BuildCtx, v: number) {
  return `${v < 0 ? '−' : ''}${c.fmt(Math.abs(v))}`
}

function change(c: BuildCtx, from: number, to: number) {
  const d = to - from
  return `${signed(c, d)} (${from ? ((d / from) * 100).toFixed(2) : '0.00'}%)`
}

export function formatDuration(seconds: number): string {
  const s = Math.round(Math.abs(seconds))
  const d = Math.floor(s / 86400),
    h = Math.floor((s % 86400) / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = s % 60
  if (d) return h ? `${d}d ${h}h` : `${d}d`
  if (h) return m ? `${h}h ${m}m` : `${h}h`
  if (m) return sec ? `${m}m ${sec}s` : `${m}m`
  return `${sec}s`
}

const barsBetween = (c: BuildCtx, t1: number, t2: number) => Math.round(c.indexAt(t2) - c.indexAt(t1))

/** Bars whose time lies between two times, in order. */
function barsIn(c: BuildCtx, t1: number, t2: number): Candle[] {
  const [lo, hi] = t1 <= t2 ? [t1, t2] : [t2, t1]
  return c.bars.filter((b) => b.time >= lo && b.time <= hi)
}

/** A vertical double arrow (price ranges) or horizontal one (date ranges). */
function measureArrow(c: BuildCtx, a: P, b: P): Shape[] {
  return [line(c, a, b, { dash: 'solid' }), poly(arrowHead(a, b, 8), c.color, { stroke: null })]
}

function infoText(c: BuildCtx, i: number, j: number): string[] {
  const [a, b] = [c.pts[i], c.pts[j]]
  const bars = barsBetween(c, a.time, b.time)
  return [change(c, a.price, b.price), `${bars} bars, ${formatDuration(b.time - a.time)}`]
}

// TradingView's Fibonacci level colors.
const FIB_COLORS: Record<string, string> = {
  '0': '#787b86',
  '0.236': '#f23645',
  '0.382': '#ff9800',
  '0.5': '#4caf50',
  '0.618': '#089981',
  '0.786': '#00bcd4',
  '1': '#787b86',
  '1.272': '#9c27b0',
  '1.414': '#e91e63',
  '1.618': '#2962ff',
  '2': '#ff9800',
  '2.618': '#f23645',
  '3': '#4caf50',
  '3.618': '#9c27b0',
  '4.236': '#e91e63',
}
const fibColor = (l: number) => FIB_COLORS[String(l)] ?? '#787b86'
const RETRACEMENT = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618, 3.618, 4.236]
const EXTENSION = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2, 2.618]
const FIB_TIME = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]
const FAN = [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1]
const ARCS = [0.236, 0.382, 0.5, 0.618, 0.786, 1]

/**
 * Horizontal Fibonacci levels from x1 to x2: level l at price(l), each with its label and a fill
 * to the next one, in TradingView's colors.
 */
function fibLevels(c: BuildCtx, levels: number[], priceOf: (l: number) => number, x1: number, x2: number): Shape[] {
  const out: Shape[] = []
  const [l, r] = [Math.min(x1, x2), Math.max(x1, x2)]
  const [s, e] = [c.d.opts?.extendLeft ? -50 : l, c.d.opts?.extendRight ? c.w + 50 : r]
  const ys = levels.map((lv) => c.y(priceOf(lv)))
  levels.forEach((lv, k) => {
    const y = ys[k]
    if (y === null) return
    const color = fibColor(lv)
    const next = ys[k + 1]
    if (next !== null && next !== undefined && k < levels.length - 1)
      out.push(poly([pt(s, y), pt(e, y), pt(e, next), pt(s, next)], alpha(color, 0.12), { stroke: null, ghost: true }))
    out.push(seg(pt(s, y), pt(e, y), { stroke: color, width: c.width }))
    out.push(label(pt(s - 4, y), `${lv} (${c.fmt(priceOf(lv))})`, { color, size: 11, align: 'right', baseline: 'middle' }))
  })
  return out
}

/** Labeled points joined by a zigzag: chart patterns and Elliott waves. */
function zigzag(c: BuildCtx, names: string[], o: { circled?: boolean } = {}): Shape[] {
  const out: Shape[] = [path(c.p, { width: c.width, dash: c.dash })]
  c.p.forEach((p, k) => {
    const name = names[k]
    if (!name) return
    // Above a high, below a low.
    const prev = c.p[k - 1] ?? c.p[k + 1]
    const up = prev ? p.y <= prev.y : true
    const at = pt(p.x, p.y + (up ? -14 : 14))
    out.push(
      o.circled
        ? label(at, name, { color: c.color, size: 12, bold: true, align: 'center', baseline: 'middle', border: c.color, pad: 3 })
        : tag(c, at, name, { size: 11 }),
    )
  })
  return out
}

/** The ratio of leg b–c to leg a–b, for harmonic pattern labels. */
const ratio = (c: BuildCtx, i: number, j: number, k: number) => {
  const p = c.pts
  const ab = Math.abs(p[j].price - p[i].price)
  return ab ? (Math.abs(p[k].price - p[j].price) / ab).toFixed(3) : '—'
}

function ratioLine(c: BuildCtx, i: number, k: number, text: string): Shape[] {
  const [a, b] = [c.p[i], c.p[k]]
  return [line(c, a, b, { dash: 'dashed', width: 1 }), tag(c, mid(a, b), text, { size: 10, bg: alpha(c.color, 0.85) })]
}

function harmonic(c: BuildCtx, names: string[]): Shape[] {
  const [x, a, b, cc, d] = c.p
  return [
    poly([x, a, b], faint(c, 0.2), { stroke: null, ghost: true }),
    poly([b, cc, d], faint(c, 0.2), { stroke: null, ghost: true }),
    ...ratioLine(c, 0, 2, ratio(c, 0, 1, 2)),
    ...ratioLine(c, 1, 3, ratio(c, 1, 2, 3)),
    ...ratioLine(c, 2, 4, ratio(c, 2, 3, 4)),
    ...ratioLine(c, 0, 4, ratio(c, 0, 1, 4)),
    ...zigzag(c, names),
  ]
}

/** Lines from `from` through each of `through`, run on to the edge of the pane. */
function rays(c: BuildCtx, from: P, through: P[], colors?: string[]): Shape[] {
  return through.map((t, k) => {
    const [s, e] = extend(from, t, c.w, c.h, false, true)
    return seg(s, e, { stroke: colors?.[k] ?? c.color, width: c.width, dash: c.dash })
  })
}

/** Andrews' pitchfork from `origin` toward the middle of b–c, with tines through b and c. */
function pitchfork(c: BuildCtx, origin: P): Shape[] {
  const [, b, cc] = c.p
  const m = mid(b, cc)
  const dir = sub(m, origin)
  if (!dir.x && !dir.y) return [line(c, b, cc)]
  const far = (p: P) => extend(p, add(p, dir), c.w, c.h, false, true)[1]
  const [mb, mc, mm] = [far(b), far(cc), far(m)]
  return [
    poly([b, mb, mc, cc], faint(c, 0.1), { stroke: null, ghost: true }),
    line(c, origin, mm),
    line(c, b, mb),
    line(c, cc, mc),
    line(c, b, cc),
  ]
}

function hollowArrow(c: BuildCtx, a: P, b: P): Shape[] {
  const len = dist(a, b)
  if (len < 1) return []
  const ux = (b.x - a.x) / len,
    uy = (b.y - a.y) / len
  const nx = -uy,
    ny = ux
  const head = Math.min(len * 0.45, 24),
    half = Math.max(4, c.width * 2.5),
    wing = half * 2.6
  const base = pt(b.x - ux * head, b.y - uy * head)
  return [
    poly(
      [
        pt(a.x + nx * half, a.y + ny * half),
        pt(base.x + nx * half, base.y + ny * half),
        pt(base.x + nx * wing, base.y + ny * wing),
        b,
        pt(base.x - nx * wing, base.y - ny * wing),
        pt(base.x - nx * half, base.y - ny * half),
        pt(a.x - nx * half, a.y - ny * half),
      ],
      c.color,
      { stroke: null },
    ),
  ]
}

/** A long or short position: entry, target and stop, with the risk/reward between them. */
function position(c: BuildCtx, long: boolean): Shape[] {
  const [entry, target, stop] = c.pts
  const [e, t, s] = c.p
  const right = Math.max(t.x, e.x + 20)
  const profit = Math.abs(target.price - entry.price),
    risk = Math.abs(entry.price - stop.price)
  const rr = risk ? (profit / risk).toFixed(2) : '—'
  const green = '#089981',
    red = '#f23645'
  const pct = (p: number) => (entry.price ? ((Math.abs(p - entry.price) / entry.price) * 100).toFixed(2) : '0')
  const box = (y1: number, y2: number, color: string) =>
    poly([pt(e.x, y1), pt(right, y1), pt(right, y2), pt(e.x, y2)], alpha(color, 0.22), { stroke: null })
  const cx = (e.x + right) / 2
  return [
    box(e.y, t.y, green),
    box(e.y, s.y, red),
    seg(pt(e.x, e.y), pt(right, e.y), { stroke: '#787b86', width: 1 }),
    tag(c, pt(cx, t.y + (t.y < e.y ? -12 : 12)), `Target: ${c.fmt(target.price)} (${pct(target.price)}%)`, { bg: green }),
    tag(c, pt(cx, s.y + (s.y > e.y ? 12 : -12)), `Stop: ${c.fmt(stop.price)} (${pct(stop.price)}%)`, { bg: red }),
    tag(c, pt(cx, e.y), `${long ? 'Long' : 'Short'} ${c.fmt(entry.price)} · R:R ${rr}`, { bg: '#434651' }),
  ]
}

const vertical = (c: BuildCtx, x: number, o: Partial<PathShape> = {}) => line(c, pt(x, -50), pt(x, c.h + 50), o)
const horizontal = (c: BuildCtx, y: number, from = -50, o: Partial<PathShape> = {}) => line(c, pt(from, y), pt(c.w + 50, y), o)

// ── the tools ────────────────────────────────────────────────────────────

const LINES = 'Lines'
const CHANNELS = 'Channels'
const PITCHFORKS = 'Pitchforks'
const FIB = 'Fibonacci'
const GANN = 'Gann'
const PATTERNS = 'Chart patterns'
const ELLIOTT = 'Elliott waves'
const CYCLES = 'Cycles'
const PROJECTION = 'Projection'
const VOLUME = 'Volume-based'
const MEASURER = 'Measurer'
const BRUSHES = 'Brushes'
const ARROWS = 'Arrows'
const SHAPES = 'Shapes'
const TEXT = 'Text & notes'

export const TOOLS: ToolDef[] = [
  // Lines
  { id: 'trendLine', name: 'Trend Line', button: 'lines', section: LINES, points: 2, extendable: true, build: (c) => [extLine(c, c.p[0], c.p[1])] },
  { id: 'ray', name: 'Ray', button: 'lines', section: LINES, points: 2, build: (c) => [extLine(c, c.p[0], c.p[1], false, true)] },
  {
    id: 'infoLine',
    name: 'Info Line',
    button: 'lines',
    section: LINES,
    points: 2,
    extendable: true,
    build: (c) => {
      const [a, b] = c.p
      const angle = (Math.atan2(a.y - b.y, b.x - a.x) * 180) / Math.PI
      const [l1, l2] = infoText(c, 0, 1)
      const at = pt(b.x, b.y + (b.y < a.y ? -34 : 34))
      return [extLine(c, a, b), tag(c, at, `${l1}\n${l2}\n${angle.toFixed(1)}°`, { bg: alpha(c.color, 0.9) })]
    },
  },
  { id: 'extendedLine', name: 'Extended Line', button: 'lines', section: LINES, points: 2, build: (c) => [extLine(c, c.p[0], c.p[1], true, true)] },
  {
    id: 'trendAngle',
    name: 'Trend Angle',
    button: 'lines',
    section: LINES,
    points: 2,
    build: (c) => {
      const [a, b] = c.p
      const r = Math.max(20, Math.min(60, dist(a, b) / 2))
      const ang = Math.atan2(b.y - a.y, b.x - a.x)
      const deg = (-ang * 180) / Math.PI
      return [
        extLine(c, a, b),
        line(c, a, pt(a.x + Math.max(r * 1.6, Math.abs(b.x - a.x)), a.y), { dash: 'dashed', width: 1 }),
        path(ellipse(a, r, r, Math.min(0, ang), Math.max(0, ang)), { width: 1 }),
        label(pt(a.x + r + 6, a.y + (ang < 0 ? -8 : 8)), `${deg.toFixed(1)}°`, { color: c.color, size: 12, baseline: 'middle' }),
      ]
    },
  },
  {
    id: 'horizontalLine',
    name: 'Horizontal Line',
    button: 'lines',
    section: LINES,
    points: 1,
    build: (c) => [horizontal(c, c.p[0].y), tag(c, pt(c.w - 4, c.p[0].y), c.fmt(c.pts[0].price), { align: 'right', size: 11 })],
  },
  {
    id: 'horizontalRay',
    name: 'Horizontal Ray',
    button: 'lines',
    section: LINES,
    points: 1,
    build: (c) => [horizontal(c, c.p[0].y, c.p[0].x), tag(c, pt(c.w - 4, c.p[0].y), c.fmt(c.pts[0].price), { align: 'right', size: 11 })],
  },
  { id: 'verticalLine', name: 'Vertical Line', button: 'lines', section: LINES, points: 1, build: (c) => [vertical(c, c.p[0].x)] },
  { id: 'crossLine', name: 'Cross Line', button: 'lines', section: LINES, points: 1, build: (c) => [vertical(c, c.p[0].x), horizontal(c, c.p[0].y)] },

  // Channels
  {
    id: 'parallelChannel',
    name: 'Parallel Channel',
    button: 'lines',
    section: CHANNELS,
    points: 3,
    defaults: { fill: true },
    extendable: true,
    build: (c) => {
      const [a, b, p3] = c.p
      const t = b.x !== a.x ? (p3.x - a.x) / (b.x - a.x) : 0
      const off = pt(0, p3.y - (a.y + (b.y - a.y) * t))
      const [a2, b2] = [add(a, off), add(b, off)]
      return [
        ...(c.d.fill ? [poly([a, b, b2, a2], faint(c), { stroke: null, ghost: true })] : []),
        extLine(c, a, b),
        extLine(c, a2, b2),
        extLine(c, mid(a, a2), mid(b, b2), false, false, { dash: 'dashed', width: 1 }),
      ]
    },
  },
  {
    id: 'regressionTrend',
    name: 'Regression Trend',
    button: 'lines',
    section: CHANNELS,
    points: 2,
    defaults: { fill: true },
    build: (c) => {
      const bars = barsIn(c, c.pts[0].time, c.pts[1].time)
      if (bars.length < 2) return [line(c, c.p[0], c.p[1], { dash: 'dashed' })]
      // Least squares on the closes against the bar index, and the closes' spread around that line.
      const n = bars.length
      let sx = 0,
        sy = 0,
        sxy = 0,
        sxx = 0
      bars.forEach((b, i) => {
        sx += i
        sy += b.close
        sxy += i * b.close
        sxx += i * i
      })
      const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1)
      const icpt = (sy - slope * sx) / n
      const dev = Math.sqrt(bars.reduce((s, b, i) => s + (b.close - (icpt + slope * i)) ** 2, 0) / n) * 2
      const x1 = c.x(bars[0].time),
        x2 = c.x(bars[n - 1].time)
      if (x1 === null || x2 === null) return []
      const at = (i: number, k: number) => c.y(icpt + slope * i + k * dev)
      const pts = [-1, 0, 1].map((k) => [at(0, k), at(n - 1, k)])
      if (pts.some(([u, v]) => u === null || v === null)) return []
      const [lo, md, hi] = pts.map(([u, v]) => [pt(x1, u!), pt(x2, v!)])
      return [
        ...(c.d.fill ? [poly([hi[0], hi[1], lo[1], lo[0]], faint(c), { stroke: null, ghost: true })] : []),
        line(c, hi[0], hi[1]),
        line(c, lo[0], lo[1]),
        line(c, md[0], md[1], { dash: 'dashed' }),
      ]
    },
  },
  {
    id: 'flatTopBottom',
    name: 'Flat Top/Bottom',
    button: 'lines',
    section: CHANNELS,
    points: 3,
    defaults: { fill: true },
    build: (c) => {
      const [a, b, p3] = c.p
      const [f1, f2] = [pt(a.x, p3.y), pt(b.x, p3.y)]
      return [...(c.d.fill ? [poly([a, b, f2, f1], faint(c), { stroke: null, ghost: true })] : []), extLine(c, a, b), line(c, f1, f2)]
    },
  },
  {
    id: 'disjointChannel',
    name: 'Disjoint Channel',
    button: 'lines',
    section: CHANNELS,
    points: 3,
    defaults: { fill: true },
    build: (c) => {
      const [a, b, p3] = c.p
      // The second line starts below/above the first and slopes the other way.
      const [d1, d2] = [pt(a.x, p3.y), pt(b.x, p3.y - (b.y - a.y))]
      return [...(c.d.fill ? [poly([a, b, d2, d1], faint(c), { stroke: null, ghost: true })] : []), line(c, a, b), line(c, d1, d2)]
    },
  },

  // Pitchforks
  { id: 'pitchfork', name: 'Pitchfork', button: 'lines', section: PITCHFORKS, points: 3, build: (c) => pitchfork(c, c.p[0]) },
  {
    id: 'schiffPitchfork',
    name: 'Schiff Pitchfork',
    button: 'lines',
    section: PITCHFORKS,
    points: 3,
    build: (c) => [line(c, c.p[0], pt(c.p[0].x, (c.p[0].y + c.p[1].y) / 2), { dash: 'dotted', width: 1 }), ...pitchfork(c, pt(c.p[0].x, (c.p[0].y + c.p[1].y) / 2))],
  },
  {
    id: 'modifiedSchiffPitchfork',
    name: 'Modified Schiff Pitchfork',
    button: 'lines',
    section: PITCHFORKS,
    points: 3,
    build: (c) => [line(c, c.p[0], mid(c.p[0], c.p[1]), { dash: 'dotted', width: 1 }), ...pitchfork(c, mid(c.p[0], c.p[1]))],
  },

  // Fibonacci
  {
    id: 'fibRetracement',
    name: 'Fib Retracement',
    button: 'fib',
    section: FIB,
    points: 2,
    extendable: true,
    build: (c) => {
      const [p1, p2] = c.pts
      return [line(c, c.p[0], c.p[1], { dash: 'dashed', width: 1, stroke: '#787b86' }), ...fibLevels(c, RETRACEMENT, (l) => p2.price + (p1.price - p2.price) * l, c.p[0].x, c.p[1].x)]
    },
  },
  {
    id: 'fibExtension',
    name: 'Trend-Based Fib Extension',
    button: 'fib',
    section: FIB,
    points: 3,
    extendable: true,
    build: (c) => {
      const [p1, p2, p3] = c.pts
      const right = Math.max(c.p[2].x, c.p[1].x) + 40
      return [
        path(c.p, { dash: 'dashed', width: 1, stroke: '#787b86' }),
        ...fibLevels(c, EXTENSION, (l) => p3.price + (p2.price - p1.price) * l, c.p[2].x, right),
      ]
    },
  },
  {
    id: 'fibChannel',
    name: 'Fib Channel',
    button: 'fib',
    section: FIB,
    points: 3,
    build: (c) => {
      const [a, b, p3] = c.p
      const t = b.x !== a.x ? (p3.x - a.x) / (b.x - a.x) : 0
      const off = p3.y - (a.y + (b.y - a.y) * t)
      return [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618].map((l) => {
        const o = pt(0, off * l)
        const [s, e] = extend(add(a, o), add(b, o), c.w, c.h, !!c.d.opts?.extendLeft, true)
        return seg(s, e, { stroke: fibColor(l), width: c.width })
      })
    },
  },
  {
    id: 'fibTimeZone',
    name: 'Fib Time Zone',
    button: 'fib',
    section: FIB,
    points: 2,
    build: (c) => {
      const [a, b] = c.p
      const step = b.x - a.x
      return FIB_TIME.flatMap((n, k) => {
        const x = a.x + step * n
        return [vertical(c, x, { stroke: k % 2 ? c.color : '#787b86', width: 1 }), label(pt(x + 3, c.h - 12), String(n), { color: c.color, size: 11 })]
      })
    },
  },
  {
    id: 'fibSpeedFan',
    name: 'Fib Speed Resistance Fan',
    button: 'fib',
    section: FIB,
    points: 2,
    build: (c) => {
      const [a, b] = c.p
      const priceRays = FAN.map((l) => pt(b.x, b.y + (a.y - b.y) * l))
      const timeRays = FAN.map((l) => pt(b.x + (a.x - b.x) * l, b.y))
      const colors = FAN.map(fibColor)
      return [
        poly([a, pt(b.x, a.y), b, pt(a.x, b.y)], faint(c, 0.05), { stroke: '#787b86', width: 1, ghost: true }),
        ...rays(c, a, priceRays, colors),
        ...rays(c, a, timeRays, colors).map((s) => ({ ...s, dash: 'dashed' as const })),
      ]
    },
  },
  {
    id: 'fibTime',
    name: 'Trend-Based Fib Time',
    button: 'fib',
    section: FIB,
    points: 3,
    build: (c) => {
      const [a, b, p3] = c.p
      const step = b.x - a.x
      return [
        path(c.p, { dash: 'dashed', width: 1, stroke: '#787b86' }),
        ...[0, 0.382, 0.5, 0.618, 1, 1.382, 1.618, 2, 2.618, 3, 4.236].flatMap((l) => {
          const x = p3.x + step * l
          return [vertical(c, x, { stroke: fibColor(l), width: 1 }), label(pt(x + 3, 12), String(l), { color: fibColor(l), size: 11 })]
        }),
      ]
    },
  },
  {
    id: 'fibCircles',
    name: 'Fib Circles',
    button: 'fib',
    section: FIB,
    points: 2,
    build: (c) => {
      const [a, b] = c.p
      const r = dist(a, b)
      return [line(c, a, b, { dash: 'dashed', width: 1, stroke: '#787b86' }), ...RETRACEMENT.slice(1).map((l) => path(ellipse(a, r * l, r * l), { stroke: fibColor(l), width: c.width, closed: true }))]
    },
  },
  {
    id: 'fibSpiral',
    name: 'Fib Spiral',
    button: 'fib',
    section: FIB,
    points: 2,
    build: (c) => {
      const [a, b] = c.p
      const r0 = dist(a, b)
      const start = Math.atan2(b.y - a.y, b.x - a.x)
      // A golden spiral: the radius grows by φ every quarter turn.
      const pts: P[] = []
      for (let t = -6 * Math.PI; t <= 4 * Math.PI; t += Math.PI / 36) {
        const r = r0 * Math.pow(1.618034, t / (Math.PI / 2))
        if (r > 4000) break
        pts.push(pt(a.x + r * Math.cos(start + t), a.y + r * Math.sin(start + t)))
      }
      return [line(c, a, b, { dash: 'dashed', width: 1, stroke: '#787b86' }), path(pts, { width: c.width })]
    },
  },
  {
    id: 'fibArcs',
    name: 'Fib Speed Resistance Arcs',
    button: 'fib',
    section: FIB,
    points: 2,
    build: (c) => {
      const [a, b] = c.p
      const r = dist(a, b)
      const ang = Math.atan2(b.y - a.y, b.x - a.x)
      return [line(c, a, b, { dash: 'dashed', width: 1, stroke: '#787b86' }), ...ARCS.map((l) => path(ellipse(b, r * l, r * l, ang + Math.PI / 2, ang + (3 * Math.PI) / 2), { stroke: fibColor(l), width: c.width }))]
    },
  },
  {
    id: 'fibWedge',
    name: 'Fib Wedge',
    button: 'fib',
    section: FIB,
    points: 3,
    build: (c) => {
      const [a, b, p3] = c.p
      const r = dist(a, b)
      let a1 = Math.atan2(b.y - a.y, b.x - a.x),
        a2 = Math.atan2(p3.y - a.y, p3.x - a.x)
      if (a2 - a1 > Math.PI) a2 -= 2 * Math.PI
      if (a1 - a2 > Math.PI) a2 += 2 * Math.PI
      const edge = pt(a.x + r * Math.cos(a2), a.y + r * Math.sin(a2))
      return [line(c, a, b), line(c, a, edge), ...ARCS.map((l) => path(ellipse(a, r * l, r * l, a1, a2), { stroke: fibColor(l), width: c.width }))]
    },
  },
  {
    id: 'pitchfan',
    name: 'Pitchfan',
    button: 'fib',
    section: FIB,
    points: 3,
    build: (c) => {
      const [a, b, p3] = c.p
      const levels = [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1]
      return [line(c, b, p3, { dash: 'dashed', width: 1 }), ...rays(c, a, levels.map((l) => lerp(b, p3, l)), levels.map(fibColor))]
    },
  },

  // Gann
  {
    id: 'gannBox',
    name: 'Gann Box',
    button: 'fib',
    section: GANN,
    points: 2,
    build: (c) => {
      const [a, b] = c.p
      const levels = [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1]
      return [
        poly([a, pt(b.x, a.y), b, pt(a.x, b.y)], faint(c, 0.06), { stroke: null, ghost: true }),
        ...levels.flatMap((l) => {
          const x = a.x + (b.x - a.x) * l,
            y = a.y + (b.y - a.y) * l
          return [
            seg(pt(x, a.y), pt(x, b.y), { stroke: fibColor(l), width: 1 }),
            seg(pt(a.x, y), pt(b.x, y), { stroke: fibColor(l), width: 1 }),
            label(pt(x, Math.min(a.y, b.y) - 4), String(l), { color: fibColor(l), size: 10, align: 'center', baseline: 'bottom' }),
            label(pt(Math.min(a.x, b.x) - 4, y), String(l), { color: fibColor(l), size: 10, align: 'right', baseline: 'middle' }),
          ]
        }),
      ]
    },
  },
  {
    id: 'gannSquare',
    name: 'Gann Square',
    button: 'fib',
    section: GANN,
    points: 2,
    build: (c) => {
      const [a, b] = c.p
      const corners = [a, pt(b.x, a.y), b, pt(a.x, b.y)]
      const r = Math.min(Math.abs(b.x - a.x), Math.abs(b.y - a.y))
      const sx = Math.sign(b.x - a.x) || 1,
        sy = Math.sign(b.y - a.y) || 1
      const quarter = (from: number) => [from, from + Math.PI / 2] as const
      const start = Math.atan2(sy, sx) - Math.PI / 4
      return [
        poly(corners, faint(c, 0.06), { stroke: c.color, width: c.width }),
        ...[0.25, 0.5, 0.75].flatMap((l) => [
          seg(pt(a.x + (b.x - a.x) * l, a.y), pt(a.x + (b.x - a.x) * l, b.y), { stroke: '#787b86', width: 1 }),
          seg(pt(a.x, a.y + (b.y - a.y) * l), pt(b.x, a.y + (b.y - a.y) * l), { stroke: '#787b86', width: 1 }),
        ]),
        line(c, a, b),
        line(c, corners[1], corners[3]),
        ...[0.5, 1].map((l) => path(ellipse(a, r * l, r * l, ...quarter(start)), { stroke: '#ff9800', width: 1 })),
      ]
    },
  },
  {
    id: 'gannFan',
    name: 'Gann Fan',
    button: 'fib',
    section: GANN,
    points: 2,
    build: (c) => {
      const [a, b] = c.p
      const dx = b.x - a.x,
        dy = b.y - a.y
      // [label, time, price]
      const fans: [string, number, number][] = [
        ['1x8', 8, 1],
        ['1x4', 4, 1],
        ['1x3', 3, 1],
        ['1x2', 2, 1],
        ['1x1', 1, 1],
        ['2x1', 1, 2],
        ['3x1', 1, 3],
        ['4x1', 1, 4],
        ['8x1', 1, 8],
      ]
      const colors = ['#ff9800', '#4caf50', '#089981', '#00bcd4', '#2962ff', '#00bcd4', '#089981', '#4caf50', '#ff9800']
      // Price units per time unit, 1x1 being the box a–b: 2x1 climbs twice as fast, 1x2 half as fast.
      const pts = fans.map(([, t, p]) => (p >= t ? pt(a.x + dx, a.y + (dy * p) / t) : pt(a.x + (dx * t) / p, a.y + dy)))
      const shown = fans.map(([, t, p]) => (p > t ? pt(a.x + (dx * t) / p, a.y + dy) : pt(a.x + dx, a.y + (dy * p) / t)))
      return [...rays(c, a, pts, colors), ...fans.map(([name], k) => label(shown[k], name, { color: colors[k], size: 10, baseline: 'bottom' }))]
    },
  },

  // Chart patterns
  { id: 'xabcd', name: 'XABCD Pattern', button: 'patterns', section: PATTERNS, points: 5, build: (c) => harmonic(c, ['X', 'A', 'B', 'C', 'D']) },
  { id: 'cypher', name: 'Cypher Pattern', button: 'patterns', section: PATTERNS, points: 5, build: (c) => harmonic(c, ['X', 'A', 'B', 'C', 'D']) },
  {
    id: 'headShoulders',
    name: 'Head and Shoulders',
    button: 'patterns',
    section: PATTERNS,
    points: 7,
    build: (c) => {
      const p = c.p
      const neck = extend(p[2], p[4], c.w, c.h, true, true)
      return [
        poly([p[0], p[1], p[2]], faint(c, 0.15), { stroke: null, ghost: true }),
        poly([p[2], p[3], p[4]], faint(c, 0.15), { stroke: null, ghost: true }),
        poly([p[4], p[5], p[6]], faint(c, 0.15), { stroke: null, ghost: true }),
        line(c, neck[0], neck[1], { dash: 'dashed', width: 1 }),
        ...zigzag(c, ['', 'Left Shoulder', '', 'Head', '', 'Right Shoulder', '']),
      ]
    },
  },
  {
    id: 'abcd',
    name: 'ABCD Pattern',
    button: 'patterns',
    section: PATTERNS,
    points: 4,
    build: (c) => [...ratioLine(c, 0, 2, ratio(c, 0, 1, 2)), ...ratioLine(c, 1, 3, ratio(c, 1, 2, 3)), ...zigzag(c, ['A', 'B', 'C', 'D'])],
  },
  {
    id: 'trianglePattern',
    name: 'Triangle Pattern',
    button: 'patterns',
    section: PATTERNS,
    points: 4,
    build: (c) => {
      const p = c.p
      return [poly([p[0], p[1], p[3], p[2]], faint(c, 0.15), { stroke: null, ghost: true }), extLine(c, p[0], p[2], false, true, { dash: 'dashed', width: 1 }), extLine(c, p[1], p[3], false, true, { dash: 'dashed', width: 1 }), ...zigzag(c, ['A', 'B', 'C', 'D'])]
    },
  },
  {
    id: 'threeDrives',
    name: 'Three Drives Pattern',
    button: 'patterns',
    section: PATTERNS,
    points: 7,
    build: (c) => zigzag(c, ['', 'Drive 1', '', 'Drive 2', '', 'Drive 3', '']),
  },

  // Elliott waves
  { id: 'elliottImpulse', name: 'Elliott Impulse Wave (12345)', button: 'patterns', section: ELLIOTT, points: 6, build: (c) => zigzag(c, ['0', '1', '2', '3', '4', '5'], { circled: true }) },
  { id: 'elliottCorrection', name: 'Elliott Correction Wave (ABC)', button: 'patterns', section: ELLIOTT, points: 4, build: (c) => zigzag(c, ['0', 'A', 'B', 'C'], { circled: true }) },
  { id: 'elliottTriangle', name: 'Elliott Triangle Wave (ABCDE)', button: 'patterns', section: ELLIOTT, points: 6, build: (c) => zigzag(c, ['0', 'A', 'B', 'C', 'D', 'E'], { circled: true }) },
  { id: 'elliottDouble', name: 'Elliott Double Combo Wave (WXY)', button: 'patterns', section: ELLIOTT, points: 4, build: (c) => zigzag(c, ['0', 'W', 'X', 'Y'], { circled: true }) },
  { id: 'elliottTriple', name: 'Elliott Triple Combo Wave (WXYXZ)', button: 'patterns', section: ELLIOTT, points: 6, build: (c) => zigzag(c, ['0', 'W', 'X', 'Y', 'X', 'Z'], { circled: true }) },

  // Cycles
  {
    id: 'cyclicLines',
    name: 'Cyclic Lines',
    button: 'patterns',
    section: CYCLES,
    points: 2,
    build: (c) => {
      const [a, b] = c.p
      const step = Math.abs(b.x - a.x)
      if (step < 3) return [vertical(c, a.x)]
      const out: Shape[] = []
      for (let x = a.x; x <= c.w + 50; x += step) out.push(vertical(c, x, { width: 1 }))
      return out
    },
  },
  {
    id: 'timeCycles',
    name: 'Time Cycles',
    button: 'patterns',
    section: CYCLES,
    points: 2,
    build: (c) => {
      const [a, b] = c.p
      const step = Math.abs(b.x - a.x)
      if (step < 3) return []
      const out: Shape[] = []
      const up = b.y <= a.y
      for (let x = Math.min(a.x, b.x); x <= c.w + step; x += step)
        out.push(path(ellipse(pt(x + step / 2, a.y), step / 2, step / 2, up ? Math.PI : 0, up ? 2 * Math.PI : Math.PI), { width: c.width, dash: c.dash }))
      return out
    },
  },
  {
    id: 'sineLine',
    name: 'Sine Line',
    button: 'patterns',
    section: CYCLES,
    points: 2,
    build: (c) => {
      const [a, b] = c.p
      const half = b.x - a.x
      if (Math.abs(half) < 2) return [line(c, a, b)]
      const amp = (b.y - a.y) / 2,
        base = (a.y + b.y) / 2
      const pts: P[] = []
      for (let x = -50; x <= c.w + 50; x += 3) pts.push(pt(x, base - amp * Math.cos((Math.PI * (x - a.x)) / half)))
      return [path(pts, { width: c.width, dash: c.dash })]
    },
  },

  // Projection
  {
    id: 'longPosition',
    name: 'Long Position',
    button: 'forecast',
    section: PROJECTION,
    points: 1,
    complete: (pts, v) => positionPoints(pts[0], v, true),
    build: (c) => position(c, true),
  },
  {
    id: 'shortPosition',
    name: 'Short Position',
    button: 'forecast',
    section: PROJECTION,
    points: 1,
    complete: (pts, v) => positionPoints(pts[0], v, false),
    build: (c) => position(c, false),
  },
  {
    id: 'forecast',
    name: 'Forecast',
    button: 'forecast',
    section: PROJECTION,
    points: 2,
    build: (c) => {
      const [a, b] = c.p
      const [l1, l2] = infoText(c, 0, 1)
      return [line(c, a, b, { width: Math.max(2, c.width) }), poly(arrowHead(a, b, 12), c.color, { stroke: null }), tag(c, pt(b.x, b.y + (b.y < a.y ? -26 : 26)), `${l1}\n${l2}`)]
    },
  },

  // Volume-based
  {
    id: 'anchoredVwap',
    name: 'Anchored VWAP',
    button: 'forecast',
    section: VOLUME,
    points: 1,
    defaults: { color: '#2962ff', width: 2 },
    build: (c) => {
      const from = c.pts[0].time
      let pv = 0,
        vol = 0
      const pts: P[] = []
      for (const b of c.bars) {
        if (b.time < from) continue
        pv += ((b.high + b.low + b.close) / 3) * b.volume
        vol += b.volume
        const x = c.x(b.time),
          y = vol ? c.y(pv / vol) : null
        if (x !== null && y !== null) pts.push(pt(x, y))
      }
      return [path(pts.length ? pts : [c.p[0]], { width: c.width, dash: c.dash }), poly(arrowHead(pt(c.p[0].x, c.p[0].y + 20), c.p[0], 8), c.color, { stroke: null })]
    },
  },
  {
    id: 'volumeProfile',
    name: 'Fixed Range Volume Profile',
    button: 'forecast',
    section: VOLUME,
    points: 2,
    build: (c) => {
      const bars = barsIn(c, c.pts[0].time, c.pts[1].time)
      const [x1, x2] = [Math.min(c.p[0].x, c.p[1].x), Math.max(c.p[0].x, c.p[1].x)]
      if (!bars.length) return [line(c, c.p[0], c.p[1], { dash: 'dashed' })]
      const lo = Math.min(...bars.map((b) => b.low)),
        hi = Math.max(...bars.map((b) => b.high))
      const rows = 24,
        size = (hi - lo) / rows || 1
      const up = new Array(rows).fill(0),
        down = new Array(rows).fill(0)
      // Each bar's volume spread evenly over the rows its range covers.
      for (const b of bars) {
        const r1 = Math.min(rows - 1, Math.floor((b.low - lo) / size)),
          r2 = Math.min(rows - 1, Math.floor((b.high - lo) / size))
        const share = b.volume / (r2 - r1 + 1)
        for (let r = r1; r <= r2; r++) (b.close >= b.open ? up : down)[r] += share
      }
      const total = up.map((u, r) => u + down[r])
      const max = Math.max(...total) || 1
      const poc = total.indexOf(max)
      const width = (x2 - x1) * 0.7
      const out: Shape[] = [poly([pt(x1, c.y(hi) ?? 0), pt(x2, c.y(hi) ?? 0), pt(x2, c.y(lo) ?? 0), pt(x1, c.y(lo) ?? 0)], alpha('#2962ff', 0.05), { stroke: null })]
      for (let r = 0; r < rows; r++) {
        const yt = c.y(lo + (r + 1) * size),
          yb = c.y(lo + r * size)
        if (yt === null || yb === null) continue
        const wu = (up[r] / max) * width,
          wd = (down[r] / max) * width
        out.push(poly([pt(x1, yt + 0.5), pt(x1 + wu, yt + 0.5), pt(x1 + wu, yb - 0.5), pt(x1, yb - 0.5)], alpha('#089981', 0.55), { stroke: null }))
        out.push(poly([pt(x1 + wu, yt + 0.5), pt(x1 + wu + wd, yt + 0.5), pt(x1 + wu + wd, yb - 0.5), pt(x1 + wu, yb - 0.5)], alpha('#f23645', 0.55), { stroke: null }))
      }
      const pocY = c.y(lo + (poc + 0.5) * size)
      if (pocY !== null) out.push(seg(pt(x1, pocY), pt(x2, pocY), { stroke: '#ff9800', width: 2 }))
      return out
    },
  },

  // Measurer
  {
    id: 'priceRange',
    name: 'Price Range',
    button: 'forecast',
    section: MEASURER,
    points: 2,
    build: (c) => {
      const [a, b] = c.p
      const xm = (a.x + b.x) / 2
      return [
        poly([pt(a.x, a.y), pt(b.x, a.y), pt(b.x, b.y), pt(a.x, b.y)], faint(c, 0.2), { stroke: null }),
        line(c, pt(a.x, a.y), pt(b.x, a.y), { dash: 'solid', width: 1 }),
        line(c, pt(a.x, b.y), pt(b.x, b.y), { dash: 'solid', width: 1 }),
        ...measureArrow(c, pt(xm, a.y), pt(xm, b.y)),
        tag(c, pt(xm, b.y + (b.y < a.y ? -14 : 14)), change(c, c.pts[0].price, c.pts[1].price)),
      ]
    },
  },
  {
    id: 'dateRange',
    name: 'Date Range',
    button: 'forecast',
    section: MEASURER,
    points: 2,
    build: (c) => {
      const [a, b] = c.p
      const ym = (a.y + b.y) / 2
      const bars = barsIn(c, c.pts[0].time, c.pts[1].time)
      const vol = bars.reduce((s, x) => s + x.volume, 0)
      return [
        poly([pt(a.x, a.y), pt(b.x, a.y), pt(b.x, b.y), pt(a.x, b.y)], faint(c, 0.2), { stroke: null }),
        line(c, pt(a.x, a.y), pt(a.x, b.y), { dash: 'solid', width: 1 }),
        line(c, pt(b.x, a.y), pt(b.x, b.y), { dash: 'solid', width: 1 }),
        ...measureArrow(c, pt(a.x, ym), pt(b.x, ym)),
        tag(c, pt((a.x + b.x) / 2, Math.max(a.y, b.y) + 22), `${barsBetween(c, c.pts[0].time, c.pts[1].time)} bars, ${formatDuration(c.pts[1].time - c.pts[0].time)}\nVol ${vol >= 1000 ? (vol / 1000).toFixed(2) + 'K' : vol.toFixed(2)}`),
      ]
    },
  },
  {
    id: 'datePriceRange',
    name: 'Date and Price Range',
    button: 'forecast',
    section: MEASURER,
    points: 2,
    build: (c) => {
      const [a, b] = c.p
      const [l1, l2] = infoText(c, 0, 1)
      return [
        poly([pt(a.x, a.y), pt(b.x, a.y), pt(b.x, b.y), pt(a.x, b.y)], faint(c, 0.2), { stroke: c.color, width: 1 }),
        ...measureArrow(c, pt((a.x + b.x) / 2, a.y), pt((a.x + b.x) / 2, b.y)),
        ...measureArrow(c, pt(a.x, (a.y + b.y) / 2), pt(b.x, (a.y + b.y) / 2)),
        tag(c, pt((a.x + b.x) / 2, Math.max(a.y, b.y) + 24), `${l1}\n${l2}`),
      ]
    },
  },

  // Brushes
  { id: 'brush', name: 'Brush', button: 'shapes', section: BRUSHES, points: 'free', build: (c) => [path(c.p, { width: c.width, dash: c.dash })] },
  {
    id: 'highlighter',
    name: 'Highlighter',
    button: 'shapes',
    section: BRUSHES,
    points: 'free',
    defaults: { color: '#ffeb3b', width: 14 },
    build: (c) => [path(c.p, { stroke: alpha(c.color, 0.35), width: c.width })],
  },

  // Arrows
  { id: 'arrowMarker', name: 'Arrow Marker', button: 'shapes', section: ARROWS, points: 2, build: (c) => hollowArrow(c, c.p[0], c.p[1]) },
  { id: 'arrow', name: 'Arrow', button: 'shapes', section: ARROWS, points: 2, build: (c) => [line(c, c.p[0], c.p[1]), poly(arrowHead(c.p[0], c.p[1], 8 + c.width * 2), c.color, { stroke: null })] },
  {
    id: 'arrowUp',
    name: 'Arrow Mark Up',
    button: 'shapes',
    section: ARROWS,
    points: 1,
    defaults: { color: '#089981' },
    build: (c) => hollowArrow(c, pt(c.p[0].x, c.p[0].y + 34), c.p[0]),
  },
  {
    id: 'arrowDown',
    name: 'Arrow Mark Down',
    button: 'shapes',
    section: ARROWS,
    points: 1,
    defaults: { color: '#f23645' },
    build: (c) => hollowArrow(c, pt(c.p[0].x, c.p[0].y - 34), c.p[0]),
  },

  // Shapes
  {
    id: 'rectangle',
    name: 'Rectangle',
    button: 'shapes',
    section: SHAPES,
    points: 2,
    defaults: { fill: true },
    extendable: true,
    build: (c) => {
      const [a, b] = c.p
      const [l, r] = [c.d.opts?.extendLeft ? -50 : Math.min(a.x, b.x), c.d.opts?.extendRight ? c.w + 50 : Math.max(a.x, b.x)]
      return [path([pt(l, a.y), pt(r, a.y), pt(r, b.y), pt(l, b.y)], { closed: true, width: c.width, dash: c.dash, fill: c.d.fill ? faint(c, 0.2) : undefined })]
    },
  },
  {
    id: 'rotatedRectangle',
    name: 'Rotated Rectangle',
    button: 'shapes',
    section: SHAPES,
    points: 3,
    defaults: { fill: true },
    build: (c) => {
      const [a, b, p3] = c.p
      const len = dist(a, b) || 1
      const nx = -(b.y - a.y) / len,
        ny = (b.x - a.x) / len
      const off = (p3.x - a.x) * nx + (p3.y - a.y) * ny
      const o = pt(nx * off, ny * off)
      return [path([a, b, add(b, o), add(a, o)], { closed: true, width: c.width, dash: c.dash, fill: c.d.fill ? faint(c, 0.2) : undefined })]
    },
  },
  {
    id: 'path',
    name: 'Path',
    button: 'shapes',
    section: SHAPES,
    points: 'multi',
    build: (c) => {
      const n = c.p.length
      return [path(c.p, { width: c.width, dash: c.dash }), ...(n > 1 ? [poly(arrowHead(c.p[n - 2], c.p[n - 1], 8 + c.width * 2), c.color, { stroke: null })] : [])]
    },
  },
  {
    id: 'circle',
    name: 'Circle',
    button: 'shapes',
    section: SHAPES,
    points: 2,
    defaults: { fill: true },
    build: (c) => {
      const r = dist(c.p[0], c.p[1])
      return [path(ellipse(c.p[0], r, r), { closed: true, width: c.width, dash: c.dash, fill: c.d.fill ? faint(c, 0.2) : undefined })]
    },
  },
  {
    id: 'ellipse',
    name: 'Ellipse',
    button: 'shapes',
    section: SHAPES,
    points: 2,
    defaults: { fill: true },
    build: (c) => {
      const [a, b] = c.p
      return [path(ellipse(mid(a, b), Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2), { closed: true, width: c.width, dash: c.dash, fill: c.d.fill ? faint(c, 0.2) : undefined })]
    },
  },
  {
    id: 'polyline',
    name: 'Polyline',
    button: 'shapes',
    section: SHAPES,
    points: 'multi',
    defaults: { fill: true },
    build: (c) => [path(c.p, { closed: c.p.length > 2, width: c.width, dash: c.dash, fill: c.d.fill && c.p.length > 2 ? faint(c, 0.2) : undefined })],
  },
  {
    id: 'triangle',
    name: 'Triangle',
    button: 'shapes',
    section: SHAPES,
    points: 3,
    defaults: { fill: true },
    build: (c) => [path(c.p, { closed: true, width: c.width, dash: c.dash, fill: c.d.fill ? faint(c, 0.2) : undefined })],
  },
  {
    id: 'arc',
    name: 'Arc',
    button: 'shapes',
    section: SHAPES,
    points: 3,
    defaults: { fill: true },
    build: (c) => {
      const [a, b, p3] = c.p
      const pts = quadratic(a, controlThrough(a, p3, b), b)
      return [path(pts, { closed: !!c.d.fill, width: c.width, dash: c.dash, fill: c.d.fill ? faint(c, 0.2) : undefined })]
    },
  },
  {
    id: 'curve',
    name: 'Curve',
    button: 'shapes',
    section: SHAPES,
    points: 3,
    build: (c) => {
      const [a, b, p3] = c.p
      return [path(quadratic(a, p3, b), { width: c.width, dash: c.dash })]
    },
  },
  {
    id: 'doubleCurve',
    name: 'Double Curve',
    button: 'shapes',
    section: SHAPES,
    points: 4,
    build: (c) => {
      const [a, b, c1, c2] = c.p
      return [path(cubic(a, c1, c2, b), { width: c.width, dash: c.dash })]
    },
  },

  // Text & notes
  {
    id: 'text',
    name: 'Text',
    button: 'text',
    section: TEXT,
    points: 1,
    text: true,
    defaults: { text: 'Text', width: 14 },
    build: (c) => [label(c.p[0], c.d.text || 'Text', { color: c.color, size: c.width, baseline: 'middle' })],
  },
  {
    id: 'note',
    name: 'Note',
    button: 'text',
    section: TEXT,
    points: 1,
    text: true,
    defaults: { text: 'Note', color: '#2962ff' },
    build: (c) => {
      const p = c.p[0]
      return [path(ellipse(p, 6, 6), { closed: true, fill: c.color }), tag(c, pt(p.x, p.y - 22), c.d.text || 'Note', { baseline: 'bottom', size: 13, pad: 6 })]
    },
  },
  {
    id: 'priceNote',
    name: 'Price Note',
    button: 'text',
    section: TEXT,
    points: 2,
    build: (c) => {
      const [a, b] = c.p
      return [line(c, a, b, { width: 1 }), path(ellipse(a, 3, 3), { closed: true, fill: c.color }), tag(c, b, c.fmt(c.pts[0].price), { size: 12 })]
    },
  },
  {
    id: 'pin',
    name: 'Pin',
    button: 'text',
    section: TEXT,
    points: 1,
    text: true,
    defaults: { text: '', color: '#f23645' },
    build: (c) => {
      const p = c.p[0]
      const head = pt(p.x, p.y - 16)
      return [
        poly([p, pt(p.x - 5, p.y - 11), pt(p.x + 5, p.y - 11)], c.color, { stroke: null }),
        path(ellipse(head, 8, 8), { closed: true, fill: c.color, stroke: '#ffffff', width: 1 }),
        ...(c.d.text ? [tag(c, pt(p.x, p.y - 30), c.d.text, { baseline: 'bottom' })] : []),
      ]
    },
  },
  {
    id: 'callout',
    name: 'Callout',
    button: 'text',
    section: TEXT,
    points: 2,
    text: true,
    defaults: { text: 'Callout' },
    build: (c) => {
      const [a, b] = c.p
      return [line(c, a, b, { width: 1 }), tag(c, b, c.d.text || 'Callout', { size: 13, pad: 6 })]
    },
  },
  {
    id: 'comment',
    name: 'Comment',
    button: 'text',
    section: TEXT,
    points: 1,
    text: true,
    defaults: { text: 'Comment', color: '#2962ff' },
    build: (c) => {
      const p = c.p[0]
      return [poly([p, pt(p.x + 6, p.y - 12), pt(p.x + 16, p.y - 12)], c.color, { stroke: null }), tag(c, pt(p.x, p.y - 12), c.d.text || 'Comment', { align: 'left', baseline: 'bottom', size: 13, pad: 6 })]
    },
  },
  {
    id: 'priceLabel',
    name: 'Price Label',
    button: 'text',
    section: TEXT,
    points: 1,
    build: (c) => {
      const p = c.p[0]
      return [poly([p, pt(p.x + 8, p.y - 8), pt(p.x + 8, p.y + 8)], c.color, { stroke: null }), tag(c, pt(p.x + 8, p.y), c.fmt(c.pts[0].price), { align: 'left', size: 12 })]
    },
  },
  {
    id: 'signpost',
    name: 'Signpost',
    button: 'text',
    section: TEXT,
    points: 1,
    text: true,
    defaults: { text: 'Signpost' },
    build: (c) => {
      const p = c.p[0]
      const top = pt(p.x, p.y - 50)
      return [line(c, p, top, { width: 1, dash: 'solid' }), path(ellipse(p, 3, 3), { closed: true, fill: c.color }), tag(c, top, c.d.text || 'Signpost', { baseline: 'bottom', size: 13, pad: 5 })]
    },
  },
  {
    id: 'flagMark',
    name: 'Flag Mark',
    button: 'text',
    section: TEXT,
    points: 1,
    defaults: { color: '#2962ff' },
    build: (c) => {
      const p = c.p[0]
      return [line(c, p, pt(p.x, p.y - 30), { width: 2, dash: 'solid' }), poly([pt(p.x, p.y - 30), pt(p.x + 18, p.y - 25), pt(p.x, p.y - 18)], c.color, { stroke: null })]
    },
  },
]

export const TOOL_BY_ID = new Map(TOOLS.map((t) => [t.id, t]))

/** A long or short position's stop and target, a little above and below the entry, to adjust. */
function positionPoints(entry: DrawingPoint, v: CompleteView, long: boolean): DrawingPoint[] {
  const y = v.y(entry.price) ?? 0
  const up = v.priceAt(y - 60) ?? entry.price * 1.01,
    down = v.priceAt(y + 40) ?? entry.price * 0.995
  const upStop = v.priceAt(y - 40) ?? entry.price * 1.005,
    downTarget = v.priceAt(y + 60) ?? entry.price * 0.99
  const end = v.timeRight(entry.time, 120)
  return long
    ? [entry, { time: end, price: up }, { time: end, price: down }]
    : [entry, { time: end, price: downTarget }, { time: end, price: upStop }]
}

/** The points a tool takes before it is done (a 'multi' or 'free' tool: as many as placed). */
export function pointCount(tool: ToolDef): number {
  return typeof tool.points === 'number' ? tool.points : Infinity
}
