import { describe, expect, it } from 'vitest'
import { higherInterval, newChartWindow, resizeRect, WINDOW_MIN } from './chartWindows'

describe('chart windows', () => {
  it('open a higher timeframe than the chart', () => {
    expect(higherInterval('1')).toBe('5')
    expect(higherInterval('5')).toBe('60')
    expect(higherInterval('15')).toBe('60')
    expect(higherInterval('60')).toBe('240')
    expect(higherInterval('240')).toBe('1D')
    expect(higherInterval('1D')).toBe('1W')
    expect(higherInterval('1W')).toBe('1M')
  })

  it('fall back to the daily past the monthly', () => {
    expect(higherInterval('1M')).toBe('1D')
    expect(higherInterval('nonsense')).toBe('1W')
  })

  it('step up from the newest open window', () => {
    const first = newChartWindow('5')
    expect(first.interval).toBe('60')
    expect(newChartWindow('5', [first]).interval).toBe('240')
    expect(first.indicators.map((i) => i.type)).toEqual(['volume'])
    expect(newChartWindow('5').id).not.toBe(first.id)
  })
})

describe('resizeRect', () => {
  const chart = { w: 1200, h: 800 }
  const origin = { x: 100, y: 200, w: 400, h: 300 }

  it('grows from the right and bottom, keeping the top-left', () => {
    expect(resizeRect(origin, 'se', 50, 40, chart, 4)).toEqual({ x: 100, y: 200, w: 450, h: 340 })
    expect(resizeRect(origin, 'e', 50, 40, chart, 4)).toEqual({ x: 100, y: 200, w: 450, h: 300 })
    expect(resizeRect(origin, 's', 50, 40, chart, 4)).toEqual({ x: 100, y: 200, w: 400, h: 340 })
  })

  it('grows from the left and top, keeping the far sides', () => {
    expect(resizeRect(origin, 'nw', -60, -50, chart, 4)).toEqual({ x: 40, y: 150, w: 460, h: 350 })
    expect(resizeRect(origin, 'ne', 20, -50, chart, 4)).toEqual({ x: 100, y: 150, w: 420, h: 350 })
    expect(resizeRect(origin, 'sw', -20, 10, chart, 4)).toEqual({ x: 80, y: 200, w: 420, h: 310 })
  })

  it('stops at the smallest window with the far side still in place', () => {
    const r = resizeRect(origin, 'nw', 500, 500, chart, 4)
    expect(r).toEqual({ x: 500 - WINDOW_MIN.w, y: 500 - WINDOW_MIN.h, w: WINDOW_MIN.w, h: WINDOW_MIN.h })
    expect(resizeRect(origin, 'se', -500, -500, chart, 4)).toMatchObject({ w: WINDOW_MIN.w, h: WINDOW_MIN.h })
  })

  it('stays inside the chart', () => {
    expect(resizeRect(origin, 'se', 5000, 5000, chart, 4)).toEqual({ x: 100, y: 200, w: 1096, h: 596 })
    expect(resizeRect(origin, 'nw', -5000, -5000, chart, 4)).toEqual({ x: 4, y: 4, w: 496, h: 496 })
  })
})
