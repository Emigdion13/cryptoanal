import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { ChartEngine, type CursorMode, type LegendState, type PaneRect } from '../chart/ChartEngine'
import { parseInterval } from '../data/intervals'
import { watchKalshi } from '../data/kalshi'
import { describe, getProduct, type Catalog } from '../data/products'
import { INDICATOR_BY_TYPE, instanceTitle } from '../indicators/catalog'
import type { FloatingState } from '../indicators/types'
import { ChartWindow, type ChartWindowActions } from './ChartWindow'
import { FloatingCard } from './FloatingCard'
import { canFloat } from './floatingModel'
import { feedGranularitiesFor, useChartData } from '../useChartData'
import { RealtimeIcon } from './icons'
import { IndicatorRow, MainLegend, type IndicatorActions } from './Legend'
import type { ChartState, ScaleFit, StatusLine } from './settings'

export interface PanelHandle {
  showRange: (from: number, interval: string) => void
}

interface Props extends IndicatorActions {
  index: number
  state: ChartState
  catalog: Catalog
  cursor: CursorMode
  statusLine: StatusLine
  scaleFit: ScaleFit
  active: boolean
  /** Outline the active chart (only when there is more than one). */
  outline: boolean
  onActivate: (index: number) => void
  onEngine: (index: number, engine: ChartEngine | null) => void
  onAutoScale: (index: number, on: boolean) => void
  onPaneSizes: (index: number, sizes: Record<string, number>) => void
  onCollapseLegend: (collapsed: boolean) => void
  /** Moves, resizes, minimizes or closes an indicator's floating window. */
  onFloating: (id: string, patch: Partial<FloatingState>) => void
  /** The toolbar's favorite intervals, for the chart windows' headers. */
  favorites: string[]
  windowActions: ChartWindowActions
}

/** One chart of the layout, with its own symbol, interval, data feed and legends. */
export const ChartPanel = forwardRef<PanelHandle, Props>(function ChartPanel(props, ref) {
  const { index, state, catalog, cursor, onEngine, onAutoScale, onPaneSizes } = props
  const product = getProduct(catalog, state.symbol)
  const interval = parseInterval(state.interval)
  const hostRef = useRef<HTMLDivElement>(null)
  const [engine, setEngine] = useState<ChartEngine | null>(null)
  const [legend, setLegend] = useState<LegendState | null>(null)
  const [panes, setPanes] = useState<PaneRect[]>([])
  const [realtime, setRealtime] = useState(true)
  /** The chart window last clicked: on top of the others. */
  const [frontWindow, setFrontWindow] = useState<string | null>(null)

  useEffect(() => {
    const e = new ChartEngine(hostRef.current!)
    const offs = [
      e.on('legend', setLegend),
      e.on('panes', setPanes),
      e.on('realtime', setRealtime),
      e.on('autoScale', (on) => onAutoScale(index, on)),
      e.on('paneSizes', (sizes) => onPaneSizes(index, sizes)),
    ]
    setEngine(e)
    onEngine(index, e)
    if (import.meta.env.DEV) Object.assign(window, { [`engine${index}`]: e })
    return () => {
      offs.forEach((off) => off())
      onEngine(index, null)
      e.destroy()
    }
  }, [index, onEngine, onAutoScale, onPaneSizes])

  useEffect(() => engine?.setChartType(state.chartType), [engine, state.chartType])
  useEffect(() => engine?.setPriceMode(state.priceMode), [engine, state.priceMode])
  useEffect(() => engine?.setCursor(cursor), [engine, cursor])
  useEffect(() => engine?.setScaleFit(props.scaleFit), [engine, props.scaleFit])
  useEffect(() => engine?.setProduct(product.id), [engine, product.id])
  // Kalshi's strike is polled only while this chart shows the Kalshi Strike indicator.
  const usesKalshi = state.indicators.some((i) => i.type === 'kalshiStrike' && !i.hidden)
  useEffect(() => {
    if (!engine || !usesKalshi) return
    return watchKalshi(product.id, () => engine.refreshIndicators())
  }, [engine, usesKalshi, product.id])
  useEffect(() => engine?.setPaneSizes(state.paneSizes), [engine, state.paneSizes])
  useEffect(() => engine?.setIndicators(state.indicators), [engine, state.indicators])

  // Coinbase granularities the indicators read besides the chart's own bars.
  const feedGranularities = useMemo(() => feedGranularitiesFor(state.indicators, interval), [state.indicators, interval])
  const { status, showRange } = useChartData(engine, product, state.interval, feedGranularities)
  useImperativeHandle(ref, () => ({ showRange: (from, iv) => showRange(from, iv, state.symbol) }), [showRange, state.symbol])

  const overlays = state.indicators.filter((i) => INDICATOR_BY_TYPE.get(i.type)?.overlay)
  const panesBelow = state.indicators.filter((i) => {
    const def = INDICATOR_BY_TYPE.get(i.type)
    return def && !def.overlay && !i.floating?.open
  })
  const actions = { onToggle: props.onToggle, onSettings: props.onSettings, onRemove: props.onRemove, onFloat: props.onFloat }
  const floating = state.indicators.filter((i) => i.floating?.open && canFloat(INDICATOR_BY_TYPE.get(i.type)))
  // Cards not dragged anywhere yet line up along the top right, in legend order.
  const docked = floating.filter((i) => i.floating?.x === undefined)
  const windows = state.windows ?? []
  const dockedWindows = windows.filter((w) => w.x === undefined)

  return (
    <div
      className={`chart-wrap${props.outline && props.active ? ' active' : ''}`}
      onPointerDownCapture={() => props.onActivate(index)}
    >
      <div className="chart-host" ref={hostRef} />
      <MainLegend
        status={props.statusLine}
        product={product}
        description={describe(catalog, product)}
        interval={interval}
        state={legend}
        engine={engine}
        overlays={overlays}
        collapsed={!!state.legendCollapsed}
        onCollapse={props.onCollapseLegend}
        {...actions}
      />
      {panesBelow.map((inst, k) => {
        const rect = panes[k + 1]
        if (!rect) return null
        return (
          <div key={inst.id} className="legend pane-legend" style={{ top: rect.top + 4 }}>
            <IndicatorRow inst={inst} status={props.statusLine} product={product} engine={engine} state={legend} {...actions} />
          </div>
        )
      })}
      {!realtime && (
        <button
          className="realtime-btn"
          style={{ top: (panes[0] ? panes[0].top + panes[0].height : 0) - 34 }}
          title="Scroll to the most recent bar"
          onClick={() => engine?.scrollToRealtime()}
        >
          <RealtimeIcon />
        </button>
      )}
      {engine &&
        floating.map((inst) => {
          const def = INDICATOR_BY_TYPE.get(inst.type)!
          return (
            <FloatingCard
              key={inst.id}
              inst={inst}
              def={def}
              engine={engine}
              legend={legend}
              title={instanceTitle(def, inst)}
              context={`${product.ticker} · ${interval ? (interval.intraday ? interval.label : `1${interval.label}`) : state.interval}`}
              intervalSeconds={interval?.seconds ?? null}
              dockIndex={docked.indexOf(inst)}
              onChange={(patch) => props.onFloating(inst.id, patch)}
              onSettings={() => props.onSettings(inst.id)}
            />
          )
        })}
      {engine &&
        windows.map((win) => (
          <ChartWindow
            key={win.id}
            win={win}
            product={getProduct(catalog, win.symbol ?? state.symbol)}
            parentSymbol={product.id}
            parentEngine={engine}
            catalog={catalog}
            chartType={state.chartType}
            cursor={cursor}
            statusLine={props.statusLine}
            scaleFit={props.scaleFit}
            favorites={props.favorites}
            dockIndex={dockedWindows.indexOf(win)}
            front={win.id === frontWindow}
            onFront={() => setFrontWindow(win.id)}
            actions={props.windowActions}
          />
        ))}
      {status === 'error' && <div className="chart-toast">Can't reach Coinbase — retrying…</div>}
    </div>
  )
})
