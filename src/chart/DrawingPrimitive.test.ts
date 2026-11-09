/**
 * Boxes between bars (Bayesian's banker bodies span x ± 0.35) must land on their bar: lightweight-charts
 * answers 0 for a fractional logical, which once drew every body as a 2px sliver at the left edge.
 */
import { describe, expect, it } from 'vitest'
import { DrawingPrimitive } from './DrawingPrimitive'

const SPACING = 6
// lightweight-charts 5.2.1's indexToCoordinate: linear in whole indexes, 0 for any other.
const timeScale = {
  logicalToCoordinate: (i: number) => (Number.isInteger(i) ? 100 + i * SPACING : 0),
  getVisibleLogicalRange: () => ({ from: 0, to: 50 }),
}
const series = { priceToCoordinate: (price: number) => 200 - price }

function paint(drawings: Parameters<DrawingPrimitive['set']>[0]) {
  const prim = new DrawingPrimitive(series as never, 'back')
  prim.attached({ chart: { timeScale: () => timeScale }, requestUpdate: () => {} } as never)
  prim.set(drawings, 50)
  const rects: number[][] = []
  const context = { fillRect: (...r: number[]) => rects.push(r), set fillStyle(_: string) {} }
  const renderer = prim.paneViews()[0].renderer() as { drawBackground: (t: unknown) => void }
  renderer.drawBackground({ useMediaCoordinateSpace: (fn: (s: unknown) => void) => fn({ context }) })
  return rects
}

describe('DrawingPrimitive', () => {
  it('places a box between bars on its bar, at its width', () => {
    const [[left, top, width, height]] = paint([{ type: 'box', x1: 9.65, x2: 10.35, top: 80, bottom: 60, fill: '#4caf50' }])
    expect(left).toBeCloseTo(100 + 9.65 * SPACING, 9)
    expect(width).toBeCloseTo(0.7 * SPACING, 9)
    expect([top, height]).toEqual([120, 20])
  })

  it('keeps whole-bar boxes where they were', () => {
    const [[left, , width]] = paint([{ type: 'box', x1: 3, x2: 7, top: 1, bottom: 0, fill: '#fff' }])
    expect([left, width]).toEqual([100 + 3 * SPACING, 4 * SPACING])
  })
})
