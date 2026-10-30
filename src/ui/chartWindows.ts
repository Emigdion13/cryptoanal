/**
 * Floating chart windows: a second chart over a chart of the layout, at another interval (or on
 * another symbol), with indicators of its own. No React, so it can be tested without a browser.
 */
import { createInstance } from '../indicators/catalog'
import { parseInterval } from '../data/intervals'
import type { ChartWindowState } from './settings'

export const WINDOW_MIN = { w: 300, h: 190 } as const
export const WINDOW_DEFAULT = { w: 460, h: 300 } as const

/** The higher timeframes a new window opens on: the first at least four times the chart's. */
const LADDER = ['5', '15', '60', '240', '1D', '1W', '1M']

/** A higher timeframe than the chart's, as one keeps the bigger picture beside the trading chart. */
export function higherInterval(chartInterval: string): string {
  const seconds = parseInterval(chartInterval)?.seconds ?? 86400
  return LADDER.find((id) => parseInterval(id)!.seconds >= seconds * 4) ?? '1D'
}

let counter = 0

export function newChartWindow(chartInterval: string, open: readonly ChartWindowState[] = []): ChartWindowState {
  // A second window opens on the next step up from the newest one.
  const from = open.length ? open[open.length - 1].interval : chartInterval
  return {
    id: `w${Date.now().toString(36)}${(counter++).toString(36)}`,
    interval: higherInterval(from),
    indicators: [createInstance('volume')],
    ...WINDOW_DEFAULT,
  }
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** The side or corner a window is resized from: any mix of n, s, e, w. */
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
export const RESIZE_EDGES: ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

/**
 * The window after dragging `edge` by (dx, dy): the far side stays put, it never gets smaller
 * than the smallest window, and it stays `edge` pixels inside the chart.
 */
export function resizeRect(origin: Rect, edge: ResizeEdge, dx: number, dy: number, chart: { w: number; h: number }, inset: number): Rect {
  let { x, y, w, h } = origin
  const right = origin.x + origin.w
  const bottom = origin.y + origin.h
  if (edge.includes('e')) w = Math.min(Math.max(WINDOW_MIN.w, origin.w + dx), chart.w - inset - origin.x)
  if (edge.includes('s')) h = Math.min(Math.max(WINDOW_MIN.h, origin.h + dy), chart.h - inset - origin.y)
  if (edge.includes('w')) {
    x = Math.min(Math.max(inset, origin.x + dx), right - WINDOW_MIN.w)
    w = right - x
  }
  if (edge.includes('n')) {
    y = Math.min(Math.max(inset, origin.y + dy), bottom - WINDOW_MIN.h)
    h = bottom - y
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}
