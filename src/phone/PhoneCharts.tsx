import { useEffect, useMemo, useRef, useState } from 'react'
import { ChartEngine, type LegendState, type PaneRect } from '../chart/ChartEngine'
import { granularityFor, parseInterval } from '../data/intervals'
import { watchKalshi } from '../data/kalshi'
import { describe, getProduct, useCatalog } from '../data/products'
import { defaultInputs, INDICATOR_BY_TYPE } from '../indicators/catalog'
import type { IndicatorInstance } from '../indicators/types'
import { useChartData } from '../useChartData'
import { CoinLogo } from '../ui/common'
import { IndicatorRow, MainLegend } from '../ui/Legend'
import { LAYOUT_BY_ID } from '../ui/layouts'
import { defaults, SCALE_FIT_DEFAULTS, STATUS_LINE_DEFAULTS, type ChartState, type Settings } from '../ui/settings'
import { phoneFetch, PhoneRequestError } from './auth'

/** How often the phone rereads the desktop's workspace, to follow its symbol, interval and indicators. */
const FOLLOW_MS = 15_000
/** Each indicator's block, under the price block. */
const PANE_PX = 150
/** The time axis under the last block. */
const AXIS_PX = 28
const NO_ACTIONS = { onToggle: () => {}, onSettings: () => {}, onRemove: () => {}, onFloat: () => {} }

interface Desktop {
  charts: ChartState[]
  active: number
  statusLine: Settings['statusLine']
  scaleFit: Settings['scaleFit']
}

/** The desktop's settings as the workspace file has them, filled in as the desktop's own load does. */
function readDesktop(settings: Partial<Settings> | null): Desktop {
  const base = defaults()
  const all = settings?.charts?.length ? settings.charts : base.charts
  const cells = (LAYOUT_BY_ID.get(settings?.layout ?? base.layout) ?? LAYOUT_BY_ID.get('1')!).cells.length
  const charts = all.slice(0, Math.max(1, cells))
  return {
    charts,
    active: Math.min(Math.max(0, settings?.active ?? 0), charts.length - 1),
    statusLine: { ...STATUS_LINE_DEFAULTS, ...settings?.statusLine },
    scaleFit: { ...SCALE_FIT_DEFAULTS, ...settings?.scaleFit },
  }
}

/** Follows the desktop's workspace: read now, then every FOLLOW_MS while the page is showing. */
function useDesktop(onSignedOut: () => void) {
  const [desktop, setDesktop] = useState<Desktop | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const last = useRef('')
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      clearTimeout(timer)
      try {
        const reply = await phoneFetch<{ data: { settings: Partial<Settings> | null } | null }>('/api/workspace')
        if (!alive) return
        const next = readDesktop(reply.data?.settings ?? null)
        const key = JSON.stringify(next)
        if (key !== last.current) {
          last.current = key
          setDesktop(next)
        }
        setProblem(null)
      } catch (error) {
        if (!alive) return
        if (error instanceof PhoneRequestError && (error.code === 'SIGNED_OUT' || error.code === 'PHONE_OFF')) return onSignedOut()
        setProblem(error instanceof Error ? error.message : 'Could not read the desktop.')
      }
      if (alive && document.visibilityState === 'visible') timer = setTimeout(load, FOLLOW_MS)
    }
    const onVisible = () => document.visibilityState === 'visible' && void load()
    void load()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [onSignedOut])
  return { desktop, problem }
}

/**
 * V2's charts screen for this app: the desktop chart's candles and overlays on top, then every
 * indicator with a pane of its own as a block under it (floating ones too), all on the same bars,
 * in one scrolling page. Swipe sideways to scroll back in time, pinch to zoom, swipe up and down
 * to scroll the page.
 */
export function PhoneCharts({ local, onSignOut, onSignedOut }: { local: boolean; onSignOut: () => void; onSignedOut: () => void }) {
  const { desktop, problem } = useDesktop(onSignedOut)
  const [picked, setPicked] = useState<number | null>(null)
  const index = desktop ? Math.min(picked ?? desktop.active, desktop.charts.length - 1) : 0
  const chart = desktop?.charts[index] ?? null

  return (
    <div className="phone">
      <header className="phone-head">
        {chart ? <ChartTitle chart={chart} /> : <span className="phone-title">CryptoAnal</span>}
        <span className="phone-spacer" />
        {!local && (
          <button className="phone-link" onClick={onSignOut}>
            Sign out
          </button>
        )}
      </header>
      {desktop && desktop.charts.length > 1 && (
        <nav className="phone-tabs">
          {desktop.charts.map((c, k) => (
            <button key={k} className={k === index ? 'on' : undefined} onClick={() => setPicked(k)}>
              {c.symbol.replace('-USD', '')} · {intervalLabel(c.interval)}
            </button>
          ))}
        </nav>
      )}
      {problem && <div className="phone-problem">{problem}</div>}
      {chart && desktop ? (
        <ChartStack chart={chart} statusLine={desktop.statusLine} scaleFit={desktop.scaleFit} />
      ) : (
        !problem && <div className="phone-wait">Reading the desktop's chart…</div>
      )}
    </div>
  )
}

function intervalLabel(id: string): string {
  const iv = parseInterval(id)
  return iv ? (iv.intraday ? iv.label : `1${iv.label}`) : id
}

function ChartTitle({ chart }: { chart: ChartState }) {
  const base = chart.symbol.split('-')[0]
  return (
    <span className="phone-title">
      <CoinLogo symbol={base} size={20} />
      <b>{chart.symbol}</b>
      <span className="phone-dim">{intervalLabel(chart.interval)}</span>
    </span>
  )
}

function ChartStack({ chart, statusLine, scaleFit }: { chart: ChartState; statusLine: Desktop['statusLine']; scaleFit: Desktop['scaleFit'] }) {
  const catalog = useCatalog()
  const product = getProduct(catalog, chart.symbol)
  const interval = parseInterval(chart.interval)
  const hostRef = useRef<HTMLDivElement>(null)
  const [engine, setEngine] = useState<ChartEngine | null>(null)
  const [legend, setLegend] = useState<LegendState | null>(null)
  const [panes, setPanes] = useState<PaneRect[]>([])
  const [collapsed, setCollapsed] = useState(false)

  // Every shown indicator; one floating on the desktop gets its own block here.
  const indicators = useMemo<IndicatorInstance[]>(
    () =>
      chart.indicators
        .filter((i) => !i.hidden && INDICATOR_BY_TYPE.has(i.type))
        .map((i) => (i.floating?.open ? { ...i, floating: { ...i.floating, open: false } } : i)),
    [chart.indicators],
  )
  const [overlays, blocks] = useMemo(
    () => [indicators.filter((i) => INDICATOR_BY_TYPE.get(i.type)!.overlay), indicators.filter((i) => !INDICATOR_BY_TYPE.get(i.type)!.overlay)],
    [indicators],
  )
  const [mainPx] = useState(() => Math.round(Math.max(300, Math.min(480, window.innerHeight * 0.55))))
  const height = mainPx + blocks.length * PANE_PX + AXIS_PX
  const sizes = useMemo(() => Object.fromEntries([['main', mainPx], ...blocks.map((i) => [i.id, PANE_PX])]), [mainPx, blocks])

  useEffect(() => {
    const e = new ChartEngine(hostRef.current!)
    const offs = [e.on('legend', setLegend), e.on('panes', setPanes)]
    setEngine(e)
    return () => {
      offs.forEach((off) => off())
      e.destroy()
    }
  }, [])

  useEffect(() => engine?.setChartType(chart.chartType), [engine, chart.chartType])
  useEffect(() => engine?.setPriceMode(chart.priceMode), [engine, chart.priceMode])
  useEffect(() => engine?.setScaleFit(scaleFit), [engine, scaleFit])
  useEffect(() => engine?.setCenterPrice(!!chart.centerPrice), [engine, chart.centerPrice])
  useEffect(() => engine?.setProduct(product.id), [engine, product.id])
  useEffect(() => engine?.setPaneSizes(sizes), [engine, sizes])
  useEffect(() => engine?.setIndicators(indicators), [engine, indicators])
  const usesKalshi = indicators.some((i) => i.type === 'kalshiStrike')
  useEffect(() => {
    if (!engine || !usesKalshi) return
    return watchKalshi(product.id, () => engine.refreshIndicators())
  }, [engine, usesKalshi, product.id])

  const feedGranularities = useMemo(() => {
    if (!interval) return []
    const grans = new Set<number>()
    for (const inst of indicators) {
      const def = INDICATOR_BY_TYPE.get(inst.type)
      if (!def?.feeds) continue
      for (const seconds of def.feeds({ ...defaultInputs(def), ...inst.inputs }, interval)) grans.add(granularityFor(seconds))
    }
    return [...grans].sort((a, b) => a - b)
  }, [indicators, interval])
  const { status } = useChartData(engine, product, chart.interval, feedGranularities)

  return (
    <div className="phone-chart" style={{ height }}>
      <div className="chart-host" ref={hostRef} />
      <MainLegend
        status={statusLine}
        product={product}
        description={describe(catalog, product)}
        interval={interval}
        state={legend}
        engine={engine}
        overlays={overlays}
        collapsed={collapsed}
        onCollapse={setCollapsed}
        readOnly
        {...NO_ACTIONS}
      />
      {blocks.map((inst, k) => {
        const rect = panes[k + 1]
        if (!rect) return null
        return (
          <div key={inst.id} className="legend pane-legend" style={{ top: rect.top + 4 }}>
            <IndicatorRow inst={inst} status={statusLine} product={product} engine={engine} state={legend} readOnly {...NO_ACTIONS} />
          </div>
        )
      })}
      {status === 'error' && <div className="chart-toast">Can't reach Coinbase — retrying…</div>}
    </div>
  )
}
