/**
 * What drawings are made of, in pixels: paths (open or closed, outlined and/or filled) and text.
 * Tools describe their shapes; one renderer draws them and one hit-test finds them under the mouse.
 */
import type { LineDash } from './types'

export interface P {
  x: number
  y: number
}

export interface PathShape {
  kind: 'path'
  pts: P[]
  closed?: boolean
  /** Fill color; closed paths only. */
  fill?: string
  /** Outline color; null for a fill alone. Defaults to the drawing's color. */
  stroke?: string | null
  width?: number
  dash?: LineDash
  /** Only drawn, never hit: a fill behind lines that are hit on their own. */
  ghost?: boolean
}

export interface TextShape {
  kind: 'text'
  at: P
  text: string
  color?: string
  size?: number
  bold?: boolean
  align?: 'left' | 'center' | 'right'
  baseline?: 'top' | 'middle' | 'bottom'
  /** A box behind the text. */
  bg?: string
  border?: string
  pad?: number
  /** Where the text was drawn, measured at render time, for the hit-test. */
  box?: { x: number; y: number; w: number; h: number }
}

export type Shape = PathShape | TextShape

export const pt = (x: number, y: number): P => ({ x, y })
export const mid = (a: P, b: P): P => pt((a.x + b.x) / 2, (a.y + b.y) / 2)
export const lerp = (a: P, b: P, t: number): P => pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
export const dist = (a: P, b: P) => Math.hypot(b.x - a.x, b.y - a.y)
export const add = (a: P, b: P): P => pt(a.x + b.x, a.y + b.y)
export const sub = (a: P, b: P): P => pt(a.x - b.x, a.y - b.y)

export function distToSegment(p: P, a: P, b: P): number {
  const dx = b.x - a.x,
    dy = b.y - a.y
  const len = dx * dx + dy * dy
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

export function pointInPolygon(p: P, pts: readonly P[]): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i],
      b = pts[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** Whether `p` is on one of the shapes: within `tol` pixels of a line, inside a fill or a text box. */
export function hitShapes(shapes: readonly Shape[], p: P, tol = 5): boolean {
  for (const s of shapes) {
    if (s.kind === 'text') {
      const b = s.box
      if (b && p.x >= b.x - 2 && p.x <= b.x + b.w + 2 && p.y >= b.y - 2 && p.y <= b.y + b.h + 2) return true
      continue
    }
    if (s.ghost) continue
    const n = s.pts.length
    if (s.closed && s.fill && n > 2 && pointInPolygon(p, s.pts)) return true
    if (s.stroke === null) continue
    const t = tol + (s.width ?? 1) / 2
    for (let i = 0; i < n - 1; i++) if (distToSegment(p, s.pts[i], s.pts[i + 1]) <= t) return true
    if (s.closed && n > 2 && distToSegment(p, s.pts[n - 1], s.pts[0]) <= t) return true
    if (n === 1 && dist(p, s.pts[0]) <= t) return true
  }
  return false
}

/**
 * The segment a→b, run on past `a` (back) and/or past `b` (forward) to the edge of a w×h box
 * (with a margin so the ends never show).
 */
export function extend(a: P, b: P, w: number, h: number, back: boolean, forward: boolean): [P, P] {
  const dx = b.x - a.x,
    dy = b.y - a.y
  if (!dx && !dy) return [a, b]
  const m = 50
  // How far along a→b (in units of its length) the line leaves the box each way.
  let tMax = Infinity,
    tMin = -Infinity
  const clip = (d: number, p0: number, lo: number, hi: number) => {
    if (!d) return
    const t1 = (lo - p0) / d,
      t2 = (hi - p0) / d
    tMin = Math.max(tMin, Math.min(t1, t2))
    tMax = Math.min(tMax, Math.max(t1, t2))
  }
  clip(dx, a.x, -m, w + m)
  clip(dy, a.y, -m, h + m)
  const start = back && Number.isFinite(tMin) ? Math.min(0, tMin) : 0
  const end = forward && Number.isFinite(tMax) ? Math.max(1, tMax) : 1
  return [lerp(a, b, start), lerp(a, b, end)]
}

/** Points along an ellipse (or an arc of it, angles in radians, y down). */
export function ellipse(c: P, rx: number, ry: number, from = 0, to = Math.PI * 2, rotation = 0, n = 72): P[] {
  const out: P[] = []
  const cos = Math.cos(rotation),
    sin = Math.sin(rotation)
  const steps = Math.max(8, Math.ceil((n * Math.abs(to - from)) / (Math.PI * 2)))
  for (let i = 0; i <= steps; i++) {
    const t = from + ((to - from) * i) / steps
    const x = rx * Math.cos(t),
      y = ry * Math.sin(t)
    out.push(pt(c.x + x * cos - y * sin, c.y + x * sin + y * cos))
  }
  return out
}

/** A quadratic Bézier from a to b pulled toward `ctrl`. */
export function quadratic(a: P, ctrl: P, b: P, n = 40): P[] {
  const out: P[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n,
      u = 1 - t
    out.push(pt(u * u * a.x + 2 * u * t * ctrl.x + t * t * b.x, u * u * a.y + 2 * u * t * ctrl.y + t * t * b.y))
  }
  return out
}

/** A cubic Bézier from a to b with two control points. */
export function cubic(a: P, c1: P, c2: P, b: P, n = 50): P[] {
  const out: P[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n,
      u = 1 - t
    out.push(
      pt(
        u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
        u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
      ),
    )
  }
  return out
}

/** The control point that makes a quadratic Bézier from a to b pass through `through` halfway. */
export function controlThrough(a: P, through: P, b: P): P {
  return pt(2 * through.x - (a.x + b.x) / 2, 2 * through.y - (a.y + b.y) / 2)
}

/** A filled arrowhead with its tip at `tip`, pointing away from `from`. */
export function arrowHead(from: P, tip: P, size = 10): P[] {
  const ang = Math.atan2(tip.y - from.y, tip.x - from.x)
  const spread = Math.PI / 7
  return [
    tip,
    pt(tip.x - size * Math.cos(ang - spread), tip.y - size * Math.sin(ang - spread)),
    pt(tip.x - size * Math.cos(ang + spread), tip.y - size * Math.sin(ang + spread)),
  ]
}
