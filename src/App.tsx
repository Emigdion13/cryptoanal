import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChartEngine } from './chart/ChartEngine'
import { parseInterval } from './data/intervals'
import { describe, getProduct, useCatalog } from './data/products'
import { useQuotes } from './data/quotes'
import type { Product } from './data/types'
import { formatPercent, formatPrice } from './format'
import { createInstance, INDICATOR_BY_TYPE, instanceTitle } from './indicators/catalog'
import type { FloatingState, IndicatorInstance } from './indicators/types'
import { canFloat } from './ui/floatingModel'
import { BottomBar, type RangePreset } from './ui/BottomBar'
import { ChartPanel, type PanelHandle } from './ui/ChartPanel'
import { Header } from './ui/Header'
import { IndicatorSettings } from './ui/IndicatorSettings'
import { IndicatorsDialog } from './ui/IndicatorsDialog'
import { IntervalDialog } from './ui/IntervalDialog'
import { onSaveProblem } from './data/workspace'
import { LayoutControls } from './ui/LayoutControls'
import { LayoutGrid, sizesFor } from './ui/LayoutGrid'
import { LAYOUT_BY_ID, LAYOUTS } from './ui/layouts'
import { newChart, useSettings, type ChartState, type ChartWindowState } from './ui/settings'
import type { ChartWindowActions } from './ui/ChartWindow'
import { newChartWindow } from './ui/chartWindows'
import { PhoneAccessDialog } from './ui/PhoneAccessDialog'
import { LeftToolbar, RightToolbar } from './ui/Sidebars'
import { SymbolSearch } from './ui/SymbolSearch'
import { useWorkspace } from './ui/useWorkspace'
import { Watchlist } from './ui/Watchlist'

type SearchState = {
  initial: string
  mode: 'symbol' | 'watchlist' | 'window'
  /** mode 'window': the chart window picking its own symbol. */
  window?: { chart: number; id: string }
}
/** Where the Indicators dialog adds to, and which indicator's settings are open: a chart, or one of its windows. */
type IndicatorTarget = { chart: number; window?: string }

/** A copy of a chart's indicators with fresh ids, for a new chart in the layout. */
function cloneIndicators(list: IndicatorInstance[]): IndicatorInstance[] {
  return list.map((i) => ({ ...createInstance(i.type), inputs: { ...i.inputs }, styles: { ...i.styles }, hidden: i.hidden }))
}

/** "5m", "4h", "1D". */
function intervalName(id: string): string {
  const iv = parseInterval(id)
  return iv ? (iv.intraday ? iv.label : `1${iv.label}`) : id
}

export function App() {
  const [settings, update] = useSettings()
  const ws = useWorkspace(settings, update)
  const [saveProblem, setSaveProblem] = useState<string | null>(null)
  useEffect(() => onSaveProblem(setSaveProblem), [])
  const catalog = useCatalog()
  const layout = LAYOUT_BY_ID.get(settings.layout) ?? LAYOUTS[0]
  const count = layout.cells.length
  const charts = useMemo(
    () => Array.from({ length: count }, (_, i) => settings.charts[i] ?? settings.charts[0]),
    [settings.charts, count],
  )
  const active = Math.min(settings.active, count - 1)
  const chart = charts[active]
  const product = getProduct(catalog, chart.symbol)
  const interval = parseInterval(chart.interval)

  const engines = useRef(new Map<number, ChartEngine>())
  const [engineVersion, setEngineVersion] = useState(0)
  const panels = useRef<(PanelHandle | null)[]>([])
  const hovered = useRef<number | null>(null)
  const [autoScales, setAutoScales] = useState<Record<number, boolean>>({})
  const [search, setSearch] = useState<SearchState | null>(null)
  const [intervalText, setIntervalText] = useState<string | null>(null)
  const [indicatorsFor, setIndicatorsFor] = useState<IndicatorTarget | null>(null)
  const [phoneOpen, setPhoneOpen] = useState(false)
  const [editing, setEditing] = useState<(IndicatorTarget & { id: string }) | null>(null)

  const onEngine = useCallback((index: number, engine: ChartEngine | null) => {
    if (engine) engines.current.set(index, engine)
    else engines.current.delete(index)
    setEngineVersion((v) => v + 1)
  }, [])
  const onAutoScale = useCallback((index: number, on: boolean) => setAutoScales((a) => ({ ...a, [index]: on })), [])
  const onPaneSizes = useCallback(
    (index: number, paneSizes: Record<string, number>) =>
      update((s) => {
        const next = [...s.charts]
        if (next[index]) next[index] = { ...next[index], paneSizes }
        return { charts: next }
      }),
    [update],
  )

  /** Changes one chart; with symbol or interval sync on, every chart in the layout follows. */
  const updateChart = useCallback(
    (index: number, patch: Partial<ChartState>) =>
      update((s) => {
        const n = (LAYOUT_BY_ID.get(s.layout) ?? LAYOUTS[0]).cells.length
        const next = [...s.charts]
        next[index] = { ...(next[index] ?? next[0]), ...patch }
        for (let k = 0; k < n; k++) {
          if (k === index || !next[k]) continue
          if (patch.symbol && s.sync.symbol) next[k] = { ...next[k], symbol: patch.symbol }
          if (patch.interval && s.sync.interval) next[k] = { ...next[k], interval: patch.interval }
        }
        return { charts: next }
      }),
    [update],
  )

  const setIndicators = useCallback(
    (index: number, fn: (list: IndicatorInstance[]) => IndicatorInstance[]) =>
      update((s) => {
        const next = [...s.charts]
        next[index] = { ...next[index], indicators: fn(next[index].indicators) }
        return { charts: next }
      }),
    [update],
  )

  /** Changes an indicator's floating window; opening a window it never had starts it docked. */
  const setFloating = useCallback(
    (index: number, id: string, patch: Partial<FloatingState>) =>
      setIndicators(index, (list) =>
        list.map((x) => (x.id === id ? { ...x, floating: { open: true, ...x.floating, ...patch } } : x)),
      ),
    [setIndicators],
  )
  /** Changes a chart's floating chart windows. */
  const setWindows = useCallback(
    (index: number, fn: (list: ChartWindowState[]) => ChartWindowState[]) =>
      update((s) => {
        const next = [...s.charts]
        next[index] = { ...next[index], windows: fn(next[index].windows ?? []) }
        return { charts: next }
      }),
    [update],
  )
  const setWindow = useCallback(
    (index: number, id: string, fn: (w: ChartWindowState) => ChartWindowState) =>
      setWindows(index, (list) => list.map((w) => (w.id === id ? fn(w) : w))),
    [setWindows],
  )
  /** The indicators of a chart, or of one of its windows. */
  const setTargetIndicators = (target: IndicatorTarget, fn: (list: IndicatorInstance[]) => IndicatorInstance[]) =>
    target.window
      ? setWindow(target.chart, target.window, (w) => ({ ...w, indicators: fn(w.indicators) }))
      : setIndicators(target.chart, fn)
  const windowActions = (index: number): ChartWindowActions => ({
    onChange: (id, patch) => setWindow(index, id, (w) => ({ ...w, ...patch })),
    onIndicators: (id, fn) => setWindow(index, id, (w) => ({ ...w, indicators: fn(w.indicators) })),
    onClose: (id) => setWindows(index, (list) => list.filter((w) => w.id !== id)),
    onAddIndicator: (id) => setIndicatorsFor({ chart: index, window: id }),
    onIndicatorSettings: (id, indicatorId) => setEditing({ chart: index, window: id, id: indicatorId }),
    onSymbolSearch: (id) => setSearch({ initial: '', mode: 'window', window: { chart: index, id } }),
  })
  const openWindow = () => setWindows(active, (list) => [...list, newChartWindow(chart.interval, list)])
  const activeWindows = chart.windows ?? []

  // The active chart's oscillators, in legend order: the Floating menu and Alt+1…9.
  const floatables = chart.indicators.filter((i) => canFloat(INDICATOR_BY_TYPE.get(i.type)))
  const toggleFloating = (id: string) => {
    const inst = floatables.find((i) => i.id === id)
    if (inst) setFloating(active, id, { open: !inst.floating?.open })
  }
  const setAllFloating = (open: boolean) =>
    setIndicators(active, (list) =>
      list.map((x) => (canFloat(INDICATOR_BY_TYPE.get(x.type)) ? { ...x, floating: { ...x.floating, open } } : x)),
    )

  const pickLayout = (id: string) =>
    update((s) => {
      const n = (LAYOUT_BY_ID.get(id) ?? LAYOUTS[0]).cells.length
      const next = [...s.charts]
      // New charts start as a copy of the active one, as on TradingView.
      const source = next[Math.min(s.active, next.length - 1)]
      while (next.length < n) next.push(newChart({ ...source, windows: undefined, indicators: cloneIndicators(source.indicators) }))
      return { layout: id, charts: next, active: Math.min(s.active, n - 1) }
    })

  // Crosshair and time sync between the charts of the layout.
  const symbolsKey = charts.map((c) => c.symbol).join(',')
  useEffect(() => {
    const list = [...engines.current.entries()].filter(([i]) => i < count)
    const symbols = symbolsKey.split(',')
    const offs = list.flatMap(([i, e]) => [
      e.on('crosshair', ({ time, price }) => {
        if (!settings.sync.crosshair) return
        for (const [j, other] of list)
          if (j !== i) other.syncCrosshair(time, symbols[j] === symbols[i] ? price : null)
      }),
      e.on('timeRange', ({ time }) => {
        // Only the chart under the mouse leads; the others' echoes and live-bar shifts are ignored.
        if (!settings.sync.time || hovered.current !== i) return
        for (const [j, other] of list) if (j !== i) other.alignRightEdge(time)
      }),
    ])
    return () => offs.forEach((off) => off())
  }, [engineVersion, count, settings.sync, symbolsKey])

  const quoteIds = useMemo(() => [...new Set([...settings.watchlist, chart.symbol])], [settings.watchlist, chart.symbol])
  const quotes = useQuotes(quoteIds)

  // TradingView's tab title: "BTCUSD 80,019.66 ▼ −0.04%".
  const quote = quotes[chart.symbol]
  useEffect(() => {
    if (!quote || !Number.isFinite(quote.price)) {
      document.title = `${product.ticker} — CryptoAnal`
      return
    }
    const pct = quote.prevClose ? ((quote.price - quote.prevClose) / quote.prevClose) * 100 : null
    const arrow = pct === null ? '' : pct >= 0 ? ' ▲' : ' ▼'
    document.title = `${product.ticker} ${formatPrice(quote.price, product.precision)}${arrow}${pct === null ? '' : ' ' + formatPercent(pct)}`
  }, [quote, product])

  const pickSymbol = useCallback(
    (p: Product) => {
      if (search?.mode === 'watchlist') {
        if (!settings.watchlist.includes(p.id)) update({ watchlist: [...settings.watchlist, p.id] })
      } else if (search?.mode === 'window' && search.window) {
        // The chart's own symbol puts the window back to following it.
        const { chart: index, id } = search.window
        const follow = p.id === charts[index]?.symbol
        setWindow(index, id, (w) => ({ ...w, symbol: follow ? undefined : p.id }))
      } else updateChart(active, { symbol: p.id })
      setSearch(null)
    },
    [search, settings.watchlist, update, updateChart, active, charts, setWindow],
  )

  const pickRange = (r: RangePreset) => {
    if (r.interval !== chart.interval) updateChart(active, { interval: r.interval })
    panels.current[active]?.showRange(r.from(), r.interval)
  }

  const activeEngine = () => engines.current.get(active)

  const screenshot = () => {
    const engine = activeEngine()
    if (!engine) return
    const canvas = engine.screenshot(`${describe(catalog, product)} · ${interval?.label ?? ''} · Coinbase`)
    canvas.toBlob((blob) => {
      if (!blob) return
      const a = document.createElement('a')
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')
      a.href = URL.createObjectURL(blob)
      a.download = `${product.ticker}_${stamp}.png`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    })
  }

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen().catch(() => {})
  }

  // TradingView's keyboard: type a number for the interval box, letters for symbol search,
  // arrows to scroll and zoom, Alt+R to reset the chart. Keys act on the active chart.
  const modalOpen = Boolean(search || intervalText !== null || indicatorsFor || editing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.closest?.('input, textarea, select, [contenteditable]') || modalOpen) return
      const engine = engines.current.get(active)
      if (e.altKey && e.code === 'KeyR') {
        e.preventDefault()
        engine?.reset()
      } else if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[0-9]$/.test(e.code)) {
        // Alt+1…9: the floating window of the active chart's 1st…9th oscillator; Alt+0: all of them.
        e.preventDefault()
        const n = Number(e.code.slice(5))
        if (n === 0) setAllFloating(!floatables.some((i) => i.floating?.open))
        else if (floatables[n - 1]) toggleFloating(floatables[n - 1].id)
      } else if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyW') {
        // Alt+W: a new chart window over the active chart.
        e.preventDefault()
        openWindow()
      } else if (e.ctrlKey || e.metaKey || e.altKey) return
      else if (e.key === '/') {
        e.preventDefault()
        setIndicatorsFor({ chart: active })
      } else if (/^[0-9]$/.test(e.key)) {
        e.preventDefault()
        setIntervalText(e.key)
      } else if (/^[a-zA-Z]$/.test(e.key)) {
        e.preventDefault()
        setSearch({ initial: e.key.toUpperCase(), mode: 'symbol' })
      } else if (e.key === 'ArrowLeft') engine?.scrollBy(-1)
      else if (e.key === 'ArrowRight') engine?.scrollBy(1)
      else if (e.key === 'ArrowUp') engine?.zoomBy(1.15)
      else if (e.key === 'ArrowDown') engine?.zoomBy(1 / 1.15)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const targetIndicators = (t: IndicatorTarget) =>
    t.window ? charts[t.chart]?.windows?.find((w) => w.id === t.window)?.indicators : charts[t.chart]?.indicators
  const editingInst = editing ? targetIndicators(editing)?.find((i) => i.id === editing.id) : undefined
  const indicatorsWindow = indicatorsFor?.window ? charts[indicatorsFor.chart]?.windows?.find((w) => w.id === indicatorsFor.window) : undefined

  return (
    <div
      className="app"
      style={{
        gridTemplateColumns: settings.watchlistOpen ? '52px minmax(0, 1fr) 300px 45px' : '52px minmax(0, 1fr) 45px',
      }}
    >
      <Header
        product={product}
        interval={chart.interval}
        favorites={settings.favorites}
        chartType={chart.chartType}
        layout={layout.id}
        sync={settings.sync}
        onSymbolSearch={() => setSearch({ initial: '', mode: 'symbol' })}
        onInterval={(id) => updateChart(active, { interval: id })}
        onFavorites={(favorites) => update({ favorites })}
        onChartType={(chartType) => updateChart(active, { chartType })}
        onIndicators={() => setIndicatorsFor({ chart: active })}
        floating={floatables.map((i) => ({
          id: i.id,
          title: instanceTitle(INDICATOR_BY_TYPE.get(i.type)!, i),
          open: !!i.floating?.open,
        }))}
        onFloat={toggleFloating}
        onFloatAll={setAllFloating}
        windows={activeWindows.map((w) => ({
          id: w.id,
          title: `${getProduct(catalog, w.symbol ?? chart.symbol).ticker} · ${intervalName(w.interval)}`,
        }))}
        onNewWindow={openWindow}
        onCloseWindow={(id) => setWindows(active, (list) => list.filter((w) => w.id !== id))}
        onLayout={pickLayout}
        onSync={(sync) => update({ sync })}
        onFullscreen={toggleFullscreen}
        onScreenshot={screenshot}
        statusLine={settings.statusLine}
        onStatusLine={(statusLine) => update({ statusLine })}
        scaleFit={settings.scaleFit}
        onScaleFit={(scaleFit) => update({ scaleFit })}
        onPhoneAccess={() => setPhoneOpen(true)}
        saveControls={<LayoutControls ws={ws} />}
      />
      <LeftToolbar cursor={settings.cursor} onCursor={(cursor) => update({ cursor })} />
      <main className="center">
        <LayoutGrid
          layout={layout}
          sizes={sizesFor(layout, settings.splits[layout.id])}
          onSizes={(sizes) => update((s) => ({ splits: { ...s.splits, [layout.id]: sizes } }))}
        >
          {layout.cells.map((cell, i) => (
            <div
              key={i}
              className="layout-cell"
              style={{ gridArea: cell.join(' / ') }}
              onPointerEnter={() => (hovered.current = i)}
              onPointerMoveCapture={() => (hovered.current = i)}
              onWheelCapture={() => (hovered.current = i)}
              onPointerLeave={() => hovered.current === i && (hovered.current = null)}
            >
              <ChartPanel
                ref={(h) => {
                  panels.current[i] = h
                }}
                index={i}
                state={charts[i]}
                catalog={catalog}
                cursor={settings.cursor}
                statusLine={settings.statusLine}
                scaleFit={settings.scaleFit}
                active={i === active}
                outline={count > 1}
                onActivate={(index) => index !== settings.active && update({ active: index })}
                onEngine={onEngine}
                onAutoScale={onAutoScale}
                onPaneSizes={onPaneSizes}
                onCollapseLegend={(legendCollapsed) => updateChart(i, { legendCollapsed })}
                onCenterPrice={(centerPrice) => updateChart(i, { centerPrice })}
                onToggle={(id) =>
                  setIndicators(i, (list) => list.map((x) => (x.id === id ? { ...x, hidden: !x.hidden } : x)))
                }
                onSettings={(id) => setEditing({ chart: i, id })}
                onRemove={(id) => setIndicators(i, (list) => list.filter((x) => x.id !== id))}
                onFloat={(id) =>
                  setIndicators(i, (list) =>
                    list.map((x) => (x.id === id ? { ...x, floating: { ...x.floating, open: !x.floating?.open } } : x)),
                  )
                }
                onFloating={(id, patch) => setFloating(i, id, patch)}
                favorites={settings.favorites}
                windowActions={windowActions(i)}
              />
            </div>
          ))}
        </LayoutGrid>
        <BottomBar
          priceMode={chart.priceMode}
          autoScale={autoScales[active] ?? true}
          centerPrice={!!chart.centerPrice}
          onRange={pickRange}
          onPriceMode={(priceMode) => updateChart(active, { priceMode })}
          onAutoScale={(on) => activeEngine()?.setAutoScale(on)}
          onCenterPrice={(centerPrice) => updateChart(active, { centerPrice })}
        />
      </main>
      {settings.watchlistOpen && (
        <Watchlist
          catalog={catalog}
          symbols={settings.watchlist}
          active={chart.symbol}
          quotes={quotes}
          onSelect={(symbol) => updateChart(active, { symbol })}
          onRemove={(id) => update({ watchlist: settings.watchlist.filter((s) => s !== id) })}
          onAdd={() => setSearch({ initial: '', mode: 'watchlist' })}
        />
      )}
      <RightToolbar
        watchlistOpen={settings.watchlistOpen}
        onWatchlist={() => update({ watchlistOpen: !settings.watchlistOpen })}
      />
      {saveProblem && <div className="save-toast">{saveProblem}</div>}
      {search && (
        <SymbolSearch
          catalog={catalog}
          title={search.mode === 'watchlist' ? 'Add symbol' : search.mode === 'window' ? 'Symbol for the window' : 'Symbol Search'}
          initial={search.initial}
          onPick={pickSymbol}
          onClose={() => setSearch(null)}
        />
      )}
      {intervalText !== null && (
        <IntervalDialog
          initial={intervalText}
          onPick={(id) => {
            updateChart(active, { interval: id })
            setIntervalText(null)
          }}
          onClose={() => setIntervalText(null)}
        />
      )}
      {indicatorsFor && (!indicatorsFor.window || indicatorsWindow) && (
        <IndicatorsDialog
          title={
            indicatorsWindow
              ? `Indicators · ${getProduct(catalog, indicatorsWindow.symbol ?? charts[indicatorsFor.chart].symbol).ticker} ${intervalName(indicatorsWindow.interval)} window`
              : undefined
          }
          onAdd={(type) => setTargetIndicators(indicatorsFor, (list) => [...list, createInstance(type)])}
          onClose={() => setIndicatorsFor(null)}
        />
      )}
      {editing && editingInst && (
        <IndicatorSettings
          inst={editingInst}
          onChange={(inst) => setTargetIndicators(editing, (list) => list.map((x) => (x.id === inst.id ? inst : x)))}
          onClose={() => setEditing(null)}
        />
      )}
      {phoneOpen && <PhoneAccessDialog onClose={() => setPhoneOpen(false)} />}
    </div>
  )
}
