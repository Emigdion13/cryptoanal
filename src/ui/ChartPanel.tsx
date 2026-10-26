import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { ChartEngine, type CursorMode, type LegendState, type PaneRect } from '../chart/ChartEngine'
import { parseInterval } from '../data/intervals'
import { describe, getProduct, type Catalog } from '../data/products'
import { INDICATOR_BY_TYPE } from '../indicators/catalog'
import { useChartData } from '../useChartData'
import { RealtimeIcon } from './icons'
import { IndicatorRow, MainLegend, type IndicatorActions } from './Legend'
import type { ChartState } from './settings'

export interface PanelHandle {
  showRange: (from: number, interval: string) => void
}

interface Props extends IndicatorActions {
  index: number
  state: ChartState
  catalog: Catalog
  cursor: CursorMode
  active: boolean
  /** Outline the active chart (only when there is more than one). */
  outline: boolean
  onActivate: (index: number) => void
  onEngine: (index: number, engine: ChartEngine | null) => void
  onAutoScale: (index: number, on: boolean) => void
}

/** One chart of the layout, with its own symbol, interval, data feed and legends. */
export const ChartPanel = forwardRef<PanelHandle, Props>(function ChartPanel(props, ref) {
  const { index, state, catalog, cursor, onEngine, onAutoScale } = props
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
    ]
    setEngine(e)
    onEngine(index, e)
    if (import.meta.env.DEV) Object.assign(window, { [`engine${index}`]: e })
    return () => {
      offs.forEach((off) => off())
      onEngine(index, null)
      e.destroy()
    }
  }, [index, onEngine, onAutoScale])

  useEffect(() => engine?.setChartType(state.chartType), [engine, state.chartType])
  useEffect(() => engine?.setPriceMode(state.priceMode), [engine, state.priceMode])
  useEffect(() => engine?.setCursor(cursor), [engine, cursor])
  useEffect(() => engine?.setIndicators(state.indicators), [engine, state.indicators])

  const { status, showRange } = useChartData(engine, product, state.interval)
  useImperativeHandle(ref, () => ({ showRange: (from, iv) => showRange(from, iv, state.symbol) }), [showRange, state.symbol])

  const overlays = state.indicators.filter((i) => INDICATOR_BY_TYPE.get(i.type)?.overlay)
  const panesBelow = state.indicators.filter((i) => {
    const def = INDICATOR_BY_TYPE.get(i.type)
    return def && !def.overlay
  })
  const actions = { onToggle: props.onToggle, onSettings: props.onSettings, onRemove: props.onRemove }

  return (
    <div
      className={`chart-wrap${props.outline && props.active ? ' active' : ''}`}
      onPointerDownCapture={() => props.onActivate(index)}
    >
      <div className="chart-host" ref={hostRef} />
      <MainLegend
        product={product}
        description={describe(catalog, product)}
        interval={interval}
        state={legend}
        engine={engine}
        overlays={overlays}
        {...actions}
      />
      {panesBelow.map((inst, k) => {
        const rect = panes[k + 1]
        if (!rect) return null
        return (
          <div key={inst.id} className="legend pane-legend" style={{ top: rect.top + 4 }}>
            <IndicatorRow inst={inst} product={product} engine={engine} state={legend} {...actions} />
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
      {status === 'error' && <div className="chart-toast">Can't reach Coinbase — retrying…</div>}
    </div>
  )
})
