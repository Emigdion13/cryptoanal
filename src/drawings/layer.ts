/**
 * The user's drawings on a chart's price pane: drawn above the candles, and placed, selected,
 * dragged and removed with the mouse. One per chart engine, attached to its price series.
 */
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts'
import type { CanvasRenderingTarget2D } from 'fancy-canvas'
import type { Candle } from '../data/types'
import { theme } from '../theme'
import { dist, hitShapes, pt, type P, type Shape } from './geometry'
import { pointCount, TOOL_BY_ID, type BuildCtx, type ToolDef } from './tools'
import { DRAWING_PREFS_DEFAULTS, type DrawingPoint, type DrawingPrefs, type UserDrawing } from './types'

/** What the layer needs from its chart engine. */
export interface DrawingHost {
  chart: IChartApi
  host: HTMLElement
  bars(): readonly Candle[]
  barSeconds(): number
  fmt(price: number): string
}

export interface DrawingEvents {
  /** The drawings changed by the mouse or keyboard: save them. */
  change(list: UserDrawing[]): void
  /** A drawing was placed, or Escape cancelled the tool. */
  toolDone(cancelled: boolean): void
  select(d: UserDrawing | null): void
}

const DASHES = { solid: [], dashed: [6, 4], dotted: [1.5, 3] }
const HANDLE_R = 5
/** A press that moves this far is a drag, not a click. */
const DRAG_PX = 5

export const newDrawingId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export class DrawingLayer implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType> | null = null
  private requestUpdate: (() => void) | null = null
  private drawings: UserDrawing[] = []
  private prefs: DrawingPrefs = DRAWING_PREFS_DEFAULTS
  private tool: ToolDef | null = null
  /** The drawing being placed: its points so far, the last one following the mouse. */
  private draft: { d: UserDrawing; placed: number } | null = null
  private selected: string | null = null
  private hovered: string | null = null
  /** Each drawing's shapes and handles as last drawn, for the hit-test. */
  private shapes = new Map<string, Shape[]>()
  private handles = new Map<string, P[]>()
  private drag: {
    id: string
    handle: number | null
    from: P
    orig: DrawingPoint[]
    moved: boolean
  } | null = null
  /** The press that started placing, to tell a drag-to-place from a click. */
  private press: { at: P; time: number } | null = null
  private lastDown = { at: pt(-99, -99), time: 0 }
  /** Pointer down on a drawing or tool: the chart must not see this press. */
  private capturing = false
  private cleanup: (() => void)[] = []

  constructor(
    private view: DrawingHost,
    private events: DrawingEvents,
  ) {
    this.bind()
  }

  // ── lightweight-charts primitive ───────────────────────────────────────

  attached(param: SeriesAttachedParameter<Time>) {
    this.series = param.series as ISeriesApi<SeriesType>
    this.requestUpdate = param.requestUpdate
  }

  detached() {
    this.series = null
    this.requestUpdate = null
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [{ zOrder: () => 'top', renderer: () => this.renderer }]
  }

  private redraw() {
    this.requestUpdate?.()
  }

  // ── what the engine sets ───────────────────────────────────────────────

  setDrawings(list: UserDrawing[]) {
    // Mid-drag the list on screen is newer than the one saved.
    if (this.drag) return
    this.drawings = list
    if (this.selected && !list.some((d) => d.id === this.selected)) this.select(null)
    this.redraw()
  }

  getDrawings(): UserDrawing[] {
    return this.drawings
  }

  setPrefs(prefs: DrawingPrefs) {
    this.prefs = prefs
    if (prefs.hidden) this.select(null)
    this.redraw()
  }

  setTool(id: string | null) {
    const tool = id ? (TOOL_BY_ID.get(id) ?? null) : null
    if (tool === this.tool) return
    this.tool = tool
    this.draft = null
    this.press = null
    this.view.host.dataset.drawTool = tool ? '1' : ''
    if (tool) this.select(null)
    this.redraw()
  }

  /** Another chart's drawing was selected. */
  deselect() {
    this.select(null)
  }

  private remove(id: string) {
    if (this.selected === id) this.select(null)
    this.commit(this.drawings.filter((d) => d.id !== id))
  }

  destroy() {
    for (const fn of this.cleanup) fn()
  }

  private commit(list: UserDrawing[]) {
    this.drawings = list
    this.redraw()
    this.events.change(list)
  }

  private select(id: string | null) {
    if (id === this.selected) return
    this.selected = id
    this.events.select(id ? (this.drawings.find((d) => d.id === id) ?? null) : null)
    this.redraw()
  }

  // ── coordinates ────────────────────────────────────────────────────────

  /** A time's fractional bar index: between bars by time, past the ends at the interval. */
  private indexAt = (time: number): number => {
    const bars = this.view.bars()
    const sec = this.view.barSeconds()
    const n = bars.length
    if (!n) return 0
    if (time >= bars[n - 1].time) return n - 1 + (time - bars[n - 1].time) / sec
    if (time <= bars[0].time) return (time - bars[0].time) / sec
    let lo = 0,
      hi = n - 1
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1
      if (bars[m].time <= time) lo = m
      else hi = m
    }
    return lo + (time - bars[lo].time) / (bars[hi].time - bars[lo].time)
  }

  private timeAt(index: number): number {
    const bars = this.view.bars()
    const sec = this.view.barSeconds()
    const n = bars.length
    if (!n) return 0
    if (index >= n - 1) return bars[n - 1].time + (index - (n - 1)) * sec
    if (index <= 0) return bars[0].time + index * sec
    const i = Math.floor(index)
    return bars[i].time + (index - i) * (bars[i + 1].time - bars[i].time)
  }

  private x = (time: number): number | null => this.view.chart.timeScale().logicalToCoordinate(this.indexAt(time) as Logical)
  private y = (price: number): number | null => (Number.isFinite(price) ? (this.series?.priceToCoordinate(price) ?? null) : null)
  private priceAt = (y: number): number | null => this.series?.coordinateToPrice(y) ?? null

  /** The chart point under the mouse: on a bar's time (unless free-hand), the magnet applied. */
  private pointAt(p: P, snapTime = true): DrawingPoint | null {
    const logical = this.view.chart.timeScale().coordinateToLogical(p.x)
    let price = this.priceAt(p.y)
    if (logical === null || price === null) return null
    const index = snapTime ? Math.round(logical) : logical
    const bar = this.view.bars()[Math.round(logical)]
    if (bar && this.prefs.magnet !== 'off') {
      let best = price,
        bestPx = Infinity
      for (const v of [bar.open, bar.high, bar.low, bar.close]) {
        const y = this.y(v)
        if (y !== null && Math.abs(y - p.y) < bestPx) {
          bestPx = Math.abs(y - p.y)
          best = v
        }
      }
      if (this.prefs.magnet === 'strong' || bestPx <= 30) price = best
    }
    return { time: this.timeAt(index), price }
  }

  // ── drawing ────────────────────────────────────────────────────────────

  private ctx(d: UserDrawing, w: number, h: number, count: number): BuildCtx | null {
    const pts = d.points.slice()
    while (pts.length < count) pts.push(pts[pts.length - 1])
    const p: P[] = []
    for (const q of pts) {
      const x = this.x(q.time),
        y = this.y(q.price)
      if (x === null || y === null) return null
      p.push(pt(x, y))
    }
    return {
      d,
      p,
      pts,
      w,
      h,
      color: d.color,
      width: d.width,
      dash: d.dash,
      x: this.x,
      y: this.y,
      priceAt: this.priceAt,
      bars: this.view.bars(),
      indexAt: this.indexAt,
      barSeconds: this.view.barSeconds(),
      fmt: this.view.fmt,
    }
  }

  private renderer: IPrimitivePaneRenderer = {
    draw: (target: CanvasRenderingTarget2D) => {
      target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
        const { width: w, height: h } = mediaSize
        this.shapes.clear()
        this.handles.clear()
        const list = this.prefs.hidden ? [] : this.drawings.filter((d) => !d.hidden)
        const all = this.draft ? [...list, this.draft.d] : list
        for (const d of all) {
          const tool = TOOL_BY_ID.get(d.tool)
          if (!tool) continue
          const count = d === this.draft?.d ? d.points.length : Math.min(pointCount(tool), Math.max(1, d.points.length))
          const c = this.ctx(d, w, h, typeof tool.points === 'number' ? Math.max(tool.points, count) : count)
          if (!c) continue
          let shapes: Shape[]
          try {
            shapes = tool.build(c)
          } catch {
            continue
          }
          for (const s of shapes) paint(ctx, s, d)
          this.shapes.set(d.id, shapes)
          this.handles.set(d.id, c.p.slice(0, d.points.length))
        }
        // Handles on the selected drawing, and a hint of them on the one under the mouse.
        for (const id of [this.hovered, this.selected]) {
          const hs = id ? this.handles.get(id) : undefined
          if (!hs) continue
          const on = id === this.selected
          for (const p of hs) {
            ctx.beginPath()
            ctx.arc(p.x, p.y, on ? HANDLE_R : HANDLE_R - 1.5, 0, Math.PI * 2)
            ctx.fillStyle = on ? theme.panel : 'rgba(255,255,255,0.5)'
            ctx.fill()
            if (on) {
              ctx.lineWidth = 1.5
              ctx.strokeStyle = '#2962ff'
              ctx.setLineDash([])
              ctx.stroke()
            }
          }
        }
      })
    },
  }

  // ── mouse and keyboard ─────────────────────────────────────────────────

  private local(e: { clientX: number; clientY: number }): P {
    const r = this.view.host.getBoundingClientRect()
    return pt(e.clientX - r.left, e.clientY - r.top)
  }

  /** On the price pane's plot (not an axis, not a pane below). */
  private onPlot(p: P): boolean {
    const height = this.view.chart.panes()[0]?.getHeight() ?? 0
    return p.x >= 0 && p.y >= 0 && p.y <= height && p.x <= this.view.chart.timeScale().width()
  }

  private hit(p: P): { id: string; handle: number | null } | null {
    if (this.prefs.hidden) return null
    const sel = this.selected ? this.handles.get(this.selected) : undefined
    if (sel) {
      const k = sel.findIndex((h) => dist(h, p) <= HANDLE_R + 3)
      if (k >= 0) return { id: this.selected!, handle: k }
    }
    // The newest drawing is on top.
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const d = this.drawings[i]
      if (d.hidden) continue
      const shapes = this.shapes.get(d.id)
      if (shapes && hitShapes(shapes, p)) return { id: d.id, handle: null }
    }
    return null
  }

  private take(e: Event) {
    e.preventDefault()
    e.stopImmediatePropagation()
    this.capturing = true
  }

  private bind() {
    const host = this.view.host
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const p = this.local(e)
      if (!this.onPlot(p)) return
      if (this.tool) {
        this.take(e)
        this.placeAt(p, e)
        return
      }
      // Fingers pan the chart; drawings are for the mouse.
      if (e.pointerType === 'touch') return
      const hit = this.hit(p)
      if (!hit) {
        this.select(null)
        return
      }
      this.select(hit.id)
      const d = this.drawings.find((x) => x.id === hit.id)!
      if (d.locked || this.prefs.locked) {
        this.take(e)
        return
      }
      this.take(e)
      this.drag = { id: hit.id, handle: hit.handle, from: p, orig: d.points.map((q) => ({ ...q })), moved: false }
    }

    const onMove = (e: PointerEvent) => {
      const p = this.local(e)
      if (this.drag) {
        e.stopImmediatePropagation()
        this.dragTo(p)
        return
      }
      if (this.draft) {
        if (this.capturing) e.stopImmediatePropagation()
        this.follow(p)
        return
      }
      if (this.tool || e.buttons) return
      const hit = this.onPlot(p) ? this.hit(p) : null
      const id = hit?.id ?? null
      host.dataset.drawCursor = hit ? (hit.handle !== null ? 'handle' : 'move') : ''
      if (id !== this.hovered) {
        this.hovered = id
        this.redraw()
      }
    }

    const onUp = (e: PointerEvent) => {
      const wasCapturing = this.capturing
      this.capturing = false
      if (this.drag) {
        const { moved } = this.drag
        this.drag = null
        if (moved) this.events.change(this.drawings)
        return
      }
      if (!this.draft || !wasCapturing) return
      const p = this.local(e)
      if (this.tool?.points === 'free') {
        this.finish()
        return
      }
      // Press, drag and release places the next point too, as on TradingView.
      if (this.press && dist(this.press.at, p) > DRAG_PX && this.draft.placed < pointCount(this.tool!)) this.placeAt(p, e)
      this.press = null
    }

    // The chart listens to mouse and touch events: keep a captured press from reaching it.
    const block = (e: Event) => {
      if (this.capturing || this.drag) e.stopImmediatePropagation()
    }

    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.closest?.('input, textarea, select, [contenteditable]')) return
      if (e.key === 'Escape') {
        if (this.draft || this.tool) {
          this.draft = null
          this.redraw()
          this.events.toolDone(true)
        } else this.select(null)
      } else if (e.key === 'Enter' && this.draft && typeof this.tool?.points !== 'number') {
        e.preventDefault()
        // The point following the mouse is not one of the path's.
        this.draft.d.points.pop()
        this.finish()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected && !this.prefs.locked) {
        const d = this.drawings.find((x) => x.id === this.selected)
        if (!d || d.locked) return
        e.preventDefault()
        this.remove(d.id)
      }
    }

    host.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
    for (const type of ['mousedown', 'mousemove', 'mouseup', 'touchstart', 'touchmove'] as const) host.addEventListener(type, block, true)
    window.addEventListener('keydown', onKey)
    this.cleanup.push(() => {
      host.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
      for (const type of ['mousedown', 'mousemove', 'mouseup', 'touchstart', 'touchmove'] as const) host.removeEventListener(type, block, true)
      window.removeEventListener('keydown', onKey)
    })
  }

  /** A click (or a drag's release) with a tool: the first point, the next one, or the last. */
  private placeAt(p: P, e: PointerEvent) {
    const tool = this.tool!
    const free = tool.points === 'free'
    const q = this.pointAt(p, !free)
    if (!q) return
    const now = performance.now()
    const double = now - this.lastDown.time < 350 && dist(this.lastDown.at, p) < 6
    if (e.type === 'pointerdown') this.lastDown = { at: p, time: now }

    if (!this.draft) {
      const d: UserDrawing = {
        id: newDrawingId(),
        tool: tool.id,
        points: [q],
        color: '#2962ff',
        width: 2,
        dash: 'solid',
        fill: false,
        ...tool.defaults,
        ...(tool.defaults?.opts && { opts: { ...tool.defaults.opts } }),
      }
      this.draft = { d, placed: 1 }
      this.press = { at: p, time: now }
      if (tool.points === 1) return this.finish()
      if (!free) d.points.push({ ...q })
      this.redraw()
      return
    }

    const d = this.draft.d
    if (typeof tool.points !== 'number') {
      if (double) {
        // The double-click's second press lands on the point the first one placed.
        d.points.pop()
        return this.finish()
      }
      d.points[d.points.length - 1] = q
      d.points.push({ ...q })
      this.draft.placed++
      this.redraw()
      return
    }
    d.points[d.points.length - 1] = q
    this.draft.placed++
    if (this.draft.placed >= tool.points) return this.finish()
    d.points.push({ ...q })
    this.press = e.type === 'pointerdown' ? { at: p, time: now } : null
    this.redraw()
  }

  /** The mouse moved while placing: the floating point follows (a free-hand stroke grows). */
  private follow(p: P) {
    const d = this.draft!.d
    if (this.tool?.points === 'free') {
      if (!this.capturing) return
      const last = d.points[d.points.length - 1]
      const lx = this.x(last.time),
        ly = this.y(last.price)
      if (lx !== null && ly !== null && dist(pt(lx, ly), p) < 3) return
      const q = this.pointAt(p, false)
      if (q) d.points.push(q)
    } else {
      const q = this.pointAt(p)
      if (q) d.points[d.points.length - 1] = q
    }
    this.redraw()
  }

  private finish() {
    const draft = this.draft
    const tool = this.tool
    this.draft = null
    this.press = null
    if (!draft || !tool) return
    let points = draft.d.points
    if (tool.points === 'free' && points.length < 2) points = [...points, { ...points[0] }]
    if (tool.complete) {
      const timeRight = (time: number, px: number) => {
        const x = this.x(time)
        const l = x === null ? null : this.view.chart.timeScale().coordinateToLogical(x + px)
        return l === null ? time : this.timeAt(Math.round(l))
      }
      points = tool.complete(points, { priceAt: this.priceAt, y: this.y, timeRight })
    }
    const d = { ...draft.d, points }
    this.commit([...this.drawings, d])
    this.select(d.id)
    this.events.toolDone(false)
  }

  /** Dragging a handle moves that point; dragging the drawing moves all of them, bar by bar. */
  private dragTo(p: P) {
    const drag = this.drag!
    const dx = p.x - drag.from.x,
      dy = p.y - drag.from.y
    if (!drag.moved && Math.hypot(dx, dy) < 2) return
    drag.moved = true
    const points =
      drag.handle !== null
        ? drag.orig.map((q, k) => (k === drag.handle ? (this.pointAt(p) ?? q) : q))
        : drag.orig.map((q) => {
            const x = this.x(q.time),
              y = this.y(q.price)
            if (x === null || y === null) return q
            const l = this.view.chart.timeScale().coordinateToLogical(x + dx)
            const price = this.priceAt(y + dy)
            if (l === null || price === null) return q
            // Free-hand strokes keep their shape between bars; the rest stay on bar times.
            const free = TOOL_BY_ID.get(this.drawings.find((d) => d.id === drag.id)?.tool ?? '')?.points === 'free'
            return { time: this.timeAt(free ? l : this.indexAt(q.time) + Math.round(l - this.indexAt(q.time))), price }
          })
    this.drawings = this.drawings.map((d) => (d.id === drag.id ? { ...d, points } : d))
    this.redraw()
  }
}

function paint(ctx: CanvasRenderingContext2D, s: Shape, d: UserDrawing) {
  if (s.kind === 'text') return paintText(ctx, s, d)
  const n = s.pts.length
  if (!n) return
  ctx.beginPath()
  ctx.moveTo(s.pts[0].x, s.pts[0].y)
  for (let i = 1; i < n; i++) ctx.lineTo(s.pts[i].x, s.pts[i].y)
  if (s.closed) ctx.closePath()
  if (s.closed && s.fill) {
    ctx.fillStyle = s.fill
    ctx.fill()
  }
  if (s.stroke === null) return
  ctx.strokeStyle = s.stroke ?? d.color
  ctx.lineWidth = s.width ?? d.width
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.setLineDash(DASHES[s.dash ?? 'solid'])
  if (n === 1) {
    ctx.arc(s.pts[0].x, s.pts[0].y, (s.width ?? d.width) / 2, 0, Math.PI * 2)
    ctx.fillStyle = ctx.strokeStyle
    ctx.fill()
    return
  }
  ctx.stroke()
}

function paintText(ctx: CanvasRenderingContext2D, s: Extract<Shape, { kind: 'text' }>, d: UserDrawing) {
  const size = s.size ?? 12
  const lines = s.text.split('\n')
  ctx.font = `${s.bold ? '600 ' : ''}${size}px ${theme.font}`
  const pad = s.pad ?? (s.bg || s.border ? 4 : 0)
  const lineH = size * 1.25
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2
  const h = lines.length * lineH + pad * 2 - (lineH - size)
  const align = s.align ?? 'left'
  const base = s.baseline ?? 'top'
  const x = align === 'left' ? s.at.x : align === 'center' ? s.at.x - w / 2 : s.at.x - w
  const y = base === 'top' ? s.at.y : base === 'middle' ? s.at.y - h / 2 : s.at.y - h
  s.box = { x, y, w, h }
  ctx.setLineDash([])
  if (s.bg) {
    ctx.fillStyle = s.bg
    roundRect(ctx, x, y, w, h, 3)
    ctx.fill()
  }
  if (s.border) {
    ctx.strokeStyle = s.border
    ctx.lineWidth = 1
    roundRect(ctx, x, y, w, h, s.border && !s.bg ? h / 2 : 3)
    ctx.stroke()
  }
  ctx.fillStyle = s.color ?? d.color
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  lines.forEach((l, k) => {
    const lw = ctx.measureText(l).width
    const lx = align === 'center' ? x + (w - lw) / 2 : align === 'right' ? x + w - pad - lw : x + pad
    ctx.fillText(l, lx, y + pad + k * lineH)
  })
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}
