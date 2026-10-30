import { createContext, useContext, useEffect, useId, useRef } from 'react'
import type { ChartEngine } from '../chart/ChartEngine'
import type { DrawingPrefs, UserDrawing } from './types'

/** The drawing selected on one of the charts; one at a time across the app. */
export interface DrawingSelection {
  /** Which chart (or chart window) it was selected on. */
  chart: string
  symbol: string
  id: string
}

export interface DrawingsApi {
  bySymbol: Record<string, UserDrawing[]>
  tool: string | null
  prefs: DrawingPrefs
  selection: DrawingSelection | null
  change(symbol: string, list: UserDrawing[]): void
  toolDone(cancelled: boolean): void
  /** A chart selected a drawing, or let go of its selection (id null). */
  select(chart: string, symbol: string, id: string | null): void
}

/** Unset (the phone, which shows the drawings itself): the hook does nothing. */
export const DrawingsContext = createContext<DrawingsApi | null>(null)

const NONE: UserDrawing[] = []

/** Shows the symbol's drawings on the chart, and lets the user draw on it with the toolbar's tool. */
export function useDrawings(engine: ChartEngine | null, symbol: string) {
  const api = useContext(DrawingsContext)
  const chart = useId()
  const list = api?.bySymbol[symbol] ?? NONE
  const tool = api?.tool ?? null
  const prefs = api?.prefs
  const selected = api?.selection?.chart

  useEffect(() => engine?.setDrawings(list), [engine, list])
  useEffect(() => engine?.setDrawingTool(tool), [engine, tool])
  useEffect(() => {
    if (prefs) engine?.setDrawingPrefs(prefs)
  }, [engine, prefs])
  // A drawing selected on another chart: this one lets go of its own.
  useEffect(() => {
    if (selected !== chart) engine?.deselectDrawing()
  }, [engine, selected, chart])

  const latest = useRef({ api, symbol })
  latest.current = { api, symbol }
  useEffect(() => {
    if (!engine) return
    const offs = [
      engine.on('drawings', (l) => latest.current.api?.change(latest.current.symbol, l)),
      engine.on('drawingToolDone', ({ cancelled }) => latest.current.api?.toolDone(cancelled)),
      engine.on('drawingSelect', (d) => latest.current.api?.select(chart, latest.current.symbol, d?.id ?? null)),
    ]
    return () => offs.forEach((off) => off())
  }, [engine, chart])
}
