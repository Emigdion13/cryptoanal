import { describe, expect, it } from 'vitest'
import type { Candle } from '../data/types'
import { extend, hitShapes, pt } from './geometry'
import { pointCount, TOOLS, type BuildCtx } from './tools'
import type { UserDrawing } from './types'

const bars: Candle[] = Array.from({ length: 100 }, (_, i) => ({
  time: 1_700_000_000 + i * 60,
  open: 100 + i,
  high: 102 + i,
  low: 99 + i,
  close: 101 + i,
  volume: 10,
}))

/** A 1000×500 pane: one bar every 10px, one dollar every 2px. */
function ctx(d: UserDrawing): BuildCtx {
  const x = (time: number) => ((time - bars[0].time) / 60) * 10
  const y = (price: number) => 500 - (price - 50) * 2
  return {
    d,
    p: d.points.map((q) => pt(x(q.time), y(q.price))),
    pts: d.points,
    w: 1000,
    h: 500,
    color: d.color,
    width: d.width,
    dash: d.dash,
    x,
    y,
    priceAt: (py) => 50 + (500 - py) / 2,
    bars,
    indexAt: (time) => (time - bars[0].time) / 60,
    barSeconds: 60,
    fmt: (v) => v.toFixed(2),
  }
}

function drawing(tool: string, n: number): UserDrawing {
  const points = Array.from({ length: n }, (_, k) => ({ time: bars[10 + k * 12].time, price: 120 + (k % 2 ? 25 : -5) + k * 3 }))
  return { id: 't', tool, points, color: '#2962ff', width: 2, dash: 'solid', fill: true, text: 'Hi' }
}

describe('drawing tools', () => {
  it('have unique ids', () => {
    expect(new Set(TOOLS.map((t) => t.id)).size).toBe(TOOLS.length)
  })

  for (const tool of TOOLS) {
    it(`${tool.name} draws finite shapes`, () => {
      const n = Number.isFinite(pointCount(tool)) ? pointCount(tool) : 4
      const d = drawing(tool.id, n)
      const view = { priceAt: (py: number) => 50 + (500 - py) / 2, y: (v: number) => 500 - (v - 50) * 2, timeRight: (t: number) => t + 600 }
      if (tool.complete) d.points = tool.complete(d.points, view)
      const shapes = tool.build(ctx(d))
      expect(shapes.length).toBeGreaterThan(0)
      for (const s of shapes) {
        const pts = s.kind === 'text' ? [s.at] : s.pts
        for (const p of pts) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
      }
    })
  }
})

describe('geometry', () => {
  it('hits a line near it and misses away from it', () => {
    const line = [{ kind: 'path' as const, pts: [pt(0, 0), pt(100, 100)] }]
    expect(hitShapes(line, pt(52, 48))).toBe(true)
    expect(hitShapes(line, pt(80, 20))).toBe(false)
  })

  it('hits inside a filled shape', () => {
    const box = [{ kind: 'path' as const, pts: [pt(0, 0), pt(50, 0), pt(50, 50), pt(0, 50)], closed: true, fill: 'red' }]
    expect(hitShapes(box, pt(25, 25))).toBe(true)
    expect(hitShapes(box, pt(80, 25))).toBe(false)
  })

  it('runs a line on to the edge of the pane', () => {
    const [a, b] = extend(pt(100, 100), pt(200, 100), 1000, 500, false, true)
    expect(a).toEqual(pt(100, 100))
    expect(b.x).toBeGreaterThanOrEqual(1000)
    const [c] = extend(pt(100, 100), pt(200, 200), 1000, 500, true, false)
    expect(c.x).toBeLessThanOrEqual(0)
  })
})
