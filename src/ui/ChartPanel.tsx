import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { ChartEngine, type CursorMode, type LegendState, type PaneRect } from '../chart/ChartEngine'
import { granularityFor, parseInterval } from '../data/intervals'
import { watchKalshi } from '../data/kalshi'
import { describe, getProduct, type Catalog } from '../data/products'
import { defaultInputs, INDICATOR_BY_TYPE, instanceTitle } from '../indicators/catalog'
import type { FloatingState } from '../indicators/types'
import { FloatingCard } from './FloatingCard'
import { canFloat } from './floatingModel'
import { useChartData } from '../useChartData'
import { RealtimeIcon } from './icons'
import { IndicatorRow, MainLegend, type IndicatorActions } from './Legend'
import type { ChartState, StatusLine } from './settings'

export interface PanelHandle {
  showRange: (from: number, interval: string) => void
}

interface Props extends IndicatorActions {
  index: number
  state: ChartState
  catalog: Catalog
  cursor: CursorMode
  statusLine: StatusLine
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
  const feedGranularities = useMemo(() => {
    if (!interval) return []
    const grans = new Set<number>()
    for (const inst of state.indicators) {
      const def = INDICATOR_BY_TYPE.get(inst.type)
      if (!def?.feeds || inst.hidden) continue
      for (const seconds of def.feeds({ ...defaultInputs(def), ...inst.inputs }, interval))
        grans.add(granularityFor(seconds))
    }
    return [...grans].sort((a, b) => a - b)
  }, [state.indicators, interval])
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
      {status === 'error' && <div className="chart-toast">Can't reach Coinbase — retrying…</div>}
    </div>
  )
})
