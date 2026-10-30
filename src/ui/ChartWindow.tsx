import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ChartEngine, type ChartType, type CursorMode, type LegendState, type PaneRect } from '../chart/ChartEngine'
import { INTERVAL_MENU, parseInterval } from '../data/intervals'
import { watchKalshi } from '../data/kalshi'
import { describe, type Catalog } from '../data/products'
import { useDrawings } from '../drawings/context'
import type { Product } from '../data/types'
import { INDICATOR_BY_TYPE } from '../indicators/catalog'
import type { IndicatorInstance } from '../indicators/types'
import { feedGranularitiesFor, useChartData } from '../useChartData'
import { RESIZE_EDGES, resizeRect, type Rect, type ResizeEdge } from './chartWindows'
import { CoinLogo, useDismiss } from './common'
import { ChevronDown, CloseIcon, FxIcon, RealtimeIcon } from './icons'
import { IndicatorRow, MainLegend } from './Legend'
import type { ChartWindowState, ScaleFit, StatusLine } from './settings'

/** How close to the chart's edge a window may sit. */
const EDGE = 4
/** The header: all a minimized window shows. */
const HEAD_H = 30
/** Docked windows line up from the bottom left, above the time axis and clear of the price axis. */
const DOCK_BOTTOM = 34
const DOCK_RIGHT = 72
const DOCK_GAP = 8

export interface ChartWindowActions {
  onChange: (id: string, patch: Partial<ChartWindowState>) => void
  onIndicators: (id: string, fn: (list: IndicatorInstance[]) => IndicatorInstance[]) => void
  onClose: (id: string) => void
  /** Opens the Indicators dialog for this window. */
  onAddIndicator: (id: string) => void
  onIndicatorSettings: (id: string, indicatorId: string) => void
  onSymbolSearch: (id: string) => void
}

interface Props {
  win: ChartWindowState
  product: Product
  /** The chart under the window: its symbol is followed unless the window has its own. */
  parentSymbol: string
  parentEngine: ChartEngine
  catalog: Catalog
  chartType: ChartType
  cursor: CursorMode
  statusLine: StatusLine
  scaleFit: ScaleFit
  /** The toolbar's favorite intervals: one click away in the header. */
  favorites: string[]
  dockIndex: number
  /** Above the other windows: the one last clicked. */
  front: boolean
  onFront: () => void
  actions: ChartWindowActions
}

/**
 * A floating chart over a chart of the layout: the same market (or another one) at its own
 * interval, with indicators of its own, so a higher timeframe stays in sight while trading a lower
 * one. Drag it by the header, resize it from the corner, minimize it to its header. Its crosshair
 * and the chart's follow each other. Where it sits, its size, interval and indicators are saved
 * with the layout.
 */
export function ChartWindow(props: Props) {
  const { win, product, parentSymbol, parentEngine, catalog, chartType, cursor, statusLine, scaleFit, favorites, dockIndex, actions } = props
  const boxRef = useRef<HTMLElement>(null)
  const [chart, setChart] = useState({ w: 0, h: 0 })
  const [live, setLive] = useState<Rect | null>(null)
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const closeMenu = useCallback(() => setMenu(false), [])
  useDismiss(menuRef, menu, closeMenu)
  const interval = parseInterval(win.interval)
  const minimized = !!win.minimized
  const own = win.symbol !== undefined && win.symbol !== parentSymbol

  useEffect(() => {
    const parent = boxRef.current?.parentElement
    if (!parent) return
    const measure = () => setChart({ w: parent.clientWidth, h: parent.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [])

  // Squeezed into a smaller chart (another chart in the layout, a side panel), back to size once there is room.
  const w = Math.max(0, Math.min(live?.w ?? win.w, chart.w - 2 * EDGE))
  const h = minimized ? HEAD_H : Math.max(0, Math.min(live?.h ?? win.h, chart.h - 2 * EDGE))
  const clamp = (p: { x: number; y: number }) => ({
    x: Math.round(Math.min(Math.max(EDGE, p.x), Math.max(EDGE, chart.w - w - EDGE))),
    y: Math.round(Math.min(Math.max(EDGE, p.y), Math.max(EDGE, chart.h - h - EDGE))),
  })
  const cols = Math.max(1, Math.floor((chart.w - DOCK_RIGHT) / (w + DOCK_GAP)))
  const docked = {
    x: 2 * EDGE + (dockIndex % cols) * (w + DOCK_GAP),
    y: chart.h - DOCK_BOTTOM - h - Math.floor(dockIndex / cols) * (h + DOCK_GAP),
  }
  const position = clamp(live ?? (win.x !== undefined && win.y !== undefined ? { x: win.x, y: win.y } : docked))

  /** Follows the pointer from a press until it lets go; `apply` turns the distance moved into a place and size. */
  const track = (e: ReactPointerEvent, apply: (dx: number, dy: number) => Rect, done: (last: Rect) => void) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const from = { x: e.clientX, y: e.clientY }
    let last: ReturnType<typeof apply> | null = null
    const move = (ev: PointerEvent) => {
      last = apply(ev.clientX - from.x, ev.clientY - from.y)
      setLive(last)
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      setLive(null)
      if (last) done(last)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  const startDrag = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    const origin = position
    track(
      e,
      (dx, dy) => ({ ...clamp({ x: origin.x + dx, y: origin.y + dy }), w, h }),
      (last) => actions.onChange(win.id, { x: last.x, y: last.y }),
    )
  }

  /** Any side or corner, as a desktop window. */
  const startResize = (e: ReactPointerEvent, edge: ResizeEdge) => {
    const origin = { ...position, w, h }
    track(
      e,
      (dx, dy) => resizeRect(origin, edge, dx, dy, chart, EDGE),
      // Pinned where it was resized: growing it from the dock would otherwise slide it around.
      (last) => actions.onChange(win.id, { x: last.x, y: last.y, w: last.w, h: last.h }),
    )
  }

  const label = intervalLabel(win.interval)
  const pinned = INTERVAL_MENU.filter((d) => favorites.includes(d.id) || d.id === win.interval)

  return (
    <section
      ref={boxRef}
      className={`chart-window${minimized ? ' is-minimized' : ''}${live ? ' is-moving' : ''}`}
      style={{ left: position.x, top: position.y, width: w, height: h, zIndex: props.front ? 5 : 4, visibility: chart.w ? undefined : 'hidden' }}
      onPointerDownCapture={props.onFront}
      aria-label={`${product.ticker} ${label} chart window`}
    >
      <header className="cw-head" onPointerDown={startDrag} onDoubleClick={(e) => !(e.target as HTMLElement).closest('button') && actions.onChange(win.id, { minimized: !minimized })}>
        <button
          className={`cw-symbol${own ? ' is-own' : ''}`}
          title={own ? 'Its own symbol — click to change' : 'Follows the chart — click for another symbol'}
          onClick={() => actions.onSymbolSearch(win.id)}
        >
          <CoinLogo symbol={product.base} size={14} />
          <span>{product.ticker}</span>
        </button>
        {minimized ? (
          <span className="cw-iv on">{label}</span>
        ) : (
          <span className="cw-intervals">
            {pinned.map((d) => (
              <button key={d.id} className={`cw-iv${d.id === win.interval ? ' on' : ''}`} title={d.name} onClick={() => actions.onChange(win.id, { interval: d.id })}>
                {intervalLabel(d.id)}
              </button>
            ))}
          </span>
        )}
        {!minimized && (
          <div className="cw-dropdown" ref={menuRef}>
            <button className={`cw-btn${menu ? ' open' : ''}`} title="Change interval" onClick={() => setMenu(!menu)}>
              <ChevronDown />
            </button>
            {menu && (
              <div className="cw-menu">
                {INTERVAL_MENU.map((d) => (
                  <button
                    key={d.id}
                    className={d.id === win.interval ? 'on' : undefined}
                    title={d.name}
                    onClick={() => {
                      actions.onChange(win.id, { interval: d.id })
                      closeMenu()
                    }}
                  >
                    {intervalLabel(d.id)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <span className="cw-space" />
        {!minimized && (
          <button className="cw-btn" title="Add indicators to this window" onClick={() => actions.onAddIndicator(win.id)}>
            <FxIcon size={22} />
          </button>
        )}
        {win.x !== undefined && (
          <button className="cw-btn" title="Back to its corner" onClick={() => actions.onChange(win.id, { x: undefined, y: undefined })}>
            <DockIcon />
          </button>
        )}
        <button className="cw-btn" title={minimized ? 'Expand' : 'Minimize'} onClick={() => actions.onChange(win.id, { minimized: !minimized })}>
          <MinIcon plus={minimized} />
        </button>
        <button className="cw-btn is-close" title="Close window" onClick={() => actions.onClose(win.id)}>
          <CloseIcon size={18} />
        </button>
      </header>
      {/* Minimized, the chart goes away entirely: its candles stay cached, so it comes back at once. */}
      {!minimized && (
        <>
          <WindowChart
            win={win}
            product={product}
            parentSymbol={parentSymbol}
            parentEngine={parentEngine}
            catalog={catalog}
            chartType={chartType}
            cursor={cursor}
            statusLine={statusLine}
            scaleFit={scaleFit}
            interval={interval}
            actions={actions}
          />
          {RESIZE_EDGES.map((edge) => (
            <div key={edge} className={`cw-edge is-${edge}`} onPointerDown={(e) => startResize(e, edge)} />
          ))}
        </>
      )}
    </section>
  )
}

/** The window's chart: its own engine, data feed and legends. */
function WindowChart({
  win,
  product,
  parentSymbol,
  parentEngine,
  catalog,
  chartType,
  cursor,
  statusLine,
  scaleFit,
  interval,
  actions,
}: Omit<Props, 'favorites' | 'dockIndex' | 'front' | 'onFront'> & { interval: ReturnType<typeof parseInterval> }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [engine, setEngine] = useState<ChartEngine | null>(null)
  const [legend, setLegend] = useState<LegendState | null>(null)
  const [panes, setPanes] = useState<PaneRect[]>([])
  const [realtime, setRealtime] = useState(true)
  const [collapsed, setCollapsed] = useState(false)
  const { id } = win
  const onChange = useRef(actions.onChange)
  onChange.current = actions.onChange

  useEffect(() => {
    const e = new ChartEngine(hostRef.current!)
    const offs = [
      e.on('legend', setLegend),
      e.on('panes', setPanes),
      e.on('realtime', setRealtime),
      e.on('paneSizes', (paneSizes) => onChange.current(id, { paneSizes })),
    ]
    setEngine(e)
    return () => {
      offs.forEach((off) => off())
      e.destroy()
    }
  }, [id])

  useEffect(() => engine?.setChartType(chartType), [engine, chartType])
  useEffect(() => engine?.setCursor(cursor), [engine, cursor])
  useEffect(() => engine?.setScaleFit(scaleFit), [engine, scaleFit])
  useEffect(() => engine?.setProduct(product.id), [engine, product.id])
  useEffect(() => engine?.setPaneSizes(win.paneSizes), [engine, win.paneSizes])
  useEffect(() => engine?.setIndicators(win.indicators), [engine, win.indicators])
  useDrawings(engine, product.id)
  const usesKalshi = win.indicators.some((i) => i.type === 'kalshiStrike' && !i.hidden)
  useEffect(() => {
    if (!engine || !usesKalshi) return
    return watchKalshi(product.id, () => engine.refreshIndicators())
  }, [engine, usesKalshi, product.id])

  const feedGranularities = useMemo(() => feedGranularitiesFor(win.indicators, interval), [win.indicators, interval])
  const { status } = useChartData(engine, product, win.interval, feedGranularities)

  // The crosshair goes both ways between the window and its chart: the price too on the same symbol.
  useEffect(() => {
    if (!engine) return
    const same = parentSymbol === product.id
    const offs = [
      parentEngine.on('crosshair', ({ time, price }) => engine.syncCrosshair(time, same ? price : null)),
      engine.on('crosshair', ({ time, price }) => parentEngine.syncCrosshair(time, same ? price : null)),
    ]
    return () => offs.forEach((off) => off())
  }, [engine, parentEngine, parentSymbol, product.id])

  const setIndicators = (fn: (list: IndicatorInstance[]) => IndicatorInstance[]) => actions.onIndicators(id, fn)
  const rowActions = {
    onToggle: (ind: string) => setIndicators((list) => list.map((x) => (x.id === ind ? { ...x, hidden: !x.hidden } : x))),
    onSettings: (ind: string) => actions.onIndicatorSettings(id, ind),
    onRemove: (ind: string) => setIndicators((list) => list.filter((x) => x.id !== ind)),
  }
  const overlays = win.indicators.filter((i) => INDICATOR_BY_TYPE.get(i.type)?.overlay)
  const panesBelow = win.indicators.filter((i) => INDICATOR_BY_TYPE.has(i.type) && !INDICATOR_BY_TYPE.get(i.type)!.overlay)
  // The header already names the symbol and interval.
  const legendStatus = useMemo(() => ({ ...statusLine, logo: false, title: false }), [statusLine])

  return (
    <div className="cw-body">
      <div className="chart-host" ref={hostRef} />
      <MainLegend
        status={legendStatus}
        product={product}
        description={describe(catalog, product)}
        interval={interval}
        state={legend}
        engine={engine}
        overlays={overlays}
        collapsed={collapsed}
        onCollapse={setCollapsed}
        {...rowActions}
      />
      {panesBelow.map((inst, k) => {
        const rect = panes[k + 1]
        if (!rect) return null
        return (
          <div key={inst.id} className="legend pane-legend" style={{ top: rect.top + 4 }}>
            <IndicatorRow inst={inst} status={legendStatus} product={product} engine={engine} state={legend} {...rowActions} />
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
}

/** "5m", "4h", "1D". */
function intervalLabel(id: string): string {
  const iv = parseInterval(id)
  return iv ? (iv.intraday ? iv.label : `1${iv.label}`) : id
}

const DockIcon = () => (
  <svg width={14} height={14} viewBox="0 0 14 14" fill="none" stroke="currentColor">
    <path d="M3 7a4 4 0 1 0 1.2-2.9M3 2.5v2.2h2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const MinIcon = ({ plus }: { plus: boolean }) => (
  <svg width={14} height={14} viewBox="0 0 14 14" fill="none" stroke="currentColor">
    <path d={plus ? 'M3 7h8M7 3v8' : 'M3 7h8'} strokeLinecap="round" />
  </svg>
)
