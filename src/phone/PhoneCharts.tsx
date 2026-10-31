import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ChartEngine, type LegendState } from '../chart/ChartEngine'
import { granularityFor, parseInterval } from '../data/intervals'
import { watchKalshi } from '../data/kalshi'
import { getProduct, useCatalog } from '../data/products'
import { formatPrice, formatVolume } from '../format'
import { defaultInputs, INDICATOR_BY_TYPE, instanceTitle } from '../indicators/catalog'
import type { IndicatorDef, IndicatorInstance } from '../indicators/types'
import type { UserDrawing } from '../drawings/types'
import { useChartData } from '../useChartData'
import { CoinLogo } from '../ui/common'
import { Plot } from '../ui/FloatingCard'
import { buildModel, verdictAt } from '../ui/floatingModel'
import { LAYOUT_BY_ID } from '../ui/layouts'
import { defaults, SCALE_FIT_DEFAULTS, type ChartState, type Settings } from '../ui/settings'
import { phoneFetch, PhoneRequestError } from './auth'

/** How often the phone rereads the desktop's workspace, to follow its symbol, interval and indicators. */
const FOLLOW_MS = 15_000
/** The bars an indicator card holds: about what the price card shows at its width. */
const CARD_BARS = 60
/** An indicator card's plot, in svg units (it is drawn at the card's width). */
const CARD_PLOT = { width: 340, height: 120, padTop: 10, padBottom: 10 }
/** The cards' background (phone.css), under the price chart too. */
const CARD_BG = '#151a21'

interface Desktop {
  charts: ChartState[]
  active: number
  scaleFit: Settings['scaleFit']
  /** Each symbol's drawings, unless the desktop hides them. */
  drawings: Settings['drawings']
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
    scaleFit: { ...SCALE_FIT_DEFAULTS, ...settings?.scaleFit },
    drawings: settings?.drawingPrefs?.hidden ? {} : (settings?.drawings ?? {}),
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
 * V2's charts screen for this app: a sticky header with the symbol, the desktop's charts as tabs,
 * then cards — the price with the desktop's overlays and drawings, and one card per indicator that
 * has a pane of its own (floating ones too), each with its call and its values. Touch the price
 * chart to read a bar: the cards follow it. Everything follows the desktop's workspace.
 */
export function PhoneCharts({ local, onSignOut, onSignedOut }: { local: boolean; onSignOut: () => void; onSignedOut: () => void }) {
  const { desktop, problem } = useDesktop(onSignedOut)
  const [picked, setPicked] = useState<number | null>(null)
  const index = desktop ? Math.min(picked ?? desktop.active, desktop.charts.length - 1) : 0
  const chart = desktop?.charts[index] ?? null

  return (
    <div className="phone">
      <header className="phone-head">
        {chart ? (
          <span className="phone-title">
            <CoinLogo symbol={chart.symbol.split('-')[0]} size={22} />
            <b>{chart.symbol.replace('-', '/')}</b>
            <span className="phone-chip">{intervalLabel(chart.interval)}</span>
          </span>
        ) : (
          <span className="phone-title">
            <b>CryptoAnal</b>
          </span>
        )}
        <span className="phone-spacer" />
        <span className="phone-note phone-dim">{desktop ? 'desktop · live' : 'connecting…'}</span>
        {!local && (
          <button className="phone-icon-btn" onClick={onSignOut} title="Sign out" aria-label="Sign out">
            <SignOutIcon />
          </button>
        )}
      </header>
      {desktop && desktop.charts.length > 1 && (
        <nav className="phone-tabs">
          {desktop.charts.map((c, k) => (
            <button key={k} className={k === index ? 'on' : undefined} onClick={() => setPicked(k)}>
              {c.symbol.split('-')[0]} · {intervalLabel(c.interval)}
            </button>
          ))}
        </nav>
      )}
      {problem && <div className="phone-problem">{problem}</div>}
      {chart && desktop ? (
        <ChartCards key={index} chart={chart} scaleFit={desktop.scaleFit} drawings={desktop.drawings[chart.symbol]} />
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

function ChartCards({ chart, scaleFit, drawings }: { chart: ChartState; scaleFit: Desktop['scaleFit']; drawings: UserDrawing[] | undefined }) {
  const catalog = useCatalog()
  const product = getProduct(catalog, chart.symbol)
  const interval = parseInterval(chart.interval)
  const hostRef = useRef<HTMLDivElement>(null)
  const [engine, setEngine] = useState<ChartEngine | null>(null)
  const [legend, setLegend] = useState<LegendState | null>(null)

  // Every shown indicator. The ones with a pane of their own are computed but not drawn on the
  // chart (as a floating window is): each gets a card instead.
  const indicators = useMemo<IndicatorInstance[]>(
    () =>
      chart.indicators
        .filter((i) => !i.hidden && INDICATOR_BY_TYPE.has(i.type))
        .map((i) => (INDICATOR_BY_TYPE.get(i.type)!.overlay ? i : { ...i, floating: { ...i.floating, open: true } })),
    [chart.indicators],
  )
  const overlays = indicators.filter((i) => INDICATOR_BY_TYPE.get(i.type)!.overlay)
  const cards = indicators.filter((i) => !INDICATOR_BY_TYPE.get(i.type)!.overlay)
  const [chartPx] = useState(() => Math.round(Math.max(280, Math.min(460, window.innerHeight * 0.5))))

  useEffect(() => {
    const e = new ChartEngine(hostRef.current!)
    e.setIndicatorLabels(false)
    e.setBackground(CARD_BG)
    const off = e.on('legend', setLegend)
    setEngine(e)
    return () => {
      off()
      e.destroy()
    }
  }, [])

  useEffect(() => engine?.setChartType(chart.chartType), [engine, chart.chartType])
  useEffect(() => engine?.setPriceMode(chart.priceMode), [engine, chart.priceMode])
  useEffect(() => engine?.setScaleFit(scaleFit), [engine, scaleFit])
  useEffect(() => engine?.setCenterPrice(!!chart.centerPrice), [engine, chart.centerPrice])
  // Drawn on the desktop; the phone only shows them.
  useEffect(() => engine?.setDrawings(drawings ?? []), [engine, drawings])
  useEffect(() => engine?.setProduct(product.id), [engine, product.id])
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

  const bar = legend?.bar
  const change = bar && legend.prevClose ? bar.close - legend.prevClose : null
  const tone = change === null ? '' : change >= 0 ? 'is-up' : 'is-down'
  const price = (v: number) => formatPrice(v, product.precision)

  return (
    <main className="phone-cards">
      <section className="phone-card">
        <header className="phone-card-head">
          <span className="phone-card-title">
            Price
            {overlays.length > 0 && (
              <span className="phone-card-name phone-dim">{overlays.map((i) => INDICATOR_BY_TYPE.get(i.type)!.short).join(' + ')}</span>
            )}
          </span>
          {bar && (
            <span className={`phone-price ${tone}`}>
              <b>{price(bar.close)}</b>
              {change !== null && legend.prevClose ? (
                <small>
                  {change >= 0 ? '+' : ''}
                  {((change / legend.prevClose) * 100).toFixed(2)}%
                </small>
              ) : null}
            </span>
          )}
        </header>
        <div className="phone-ohlc">
          {bar ? (
            <>
              <span>O {price(bar.open)}</span>
              <span>H {price(bar.high)}</span>
              <span>L {price(bar.low)}</span>
              <span>C {price(bar.close)}</span>
              <span className="phone-dim">{legend.live ? 'live' : 'bar'}</span>
            </>
          ) : (
            <span className="phone-dim">Loading candles…</span>
          )}
        </div>
        <div className="phone-price-chart" style={{ height: chartPx }}>
          <div className="chart-host" ref={hostRef} />
          {status === 'error' && <div className="chart-toast">Can't reach Coinbase — retrying…</div>}
        </div>
      </section>
      {engine &&
        cards.map((inst) => {
          const def = INDICATOR_BY_TYPE.get(inst.type)!
          return <IndicatorCard key={inst.id} inst={inst} def={def} engine={engine} legend={legend} />
        })}
    </main>
  )
}

/**
 * One indicator as a card, like V2's: its name and the call it is read for, the last bars of what
 * its pane would plot, and its values. Touch the plot (or the price chart) to read another bar.
 */
function IndicatorCard({ inst, def, engine, legend }: { inst: IndicatorInstance; def: IndicatorDef; engine: ChartEngine; legend: LegendState | null }) {
  const [touchBar, setTouchBar] = useState<number | null>(null)
  const clipId = `phone-clip-${useId().replace(/:/g, '')}`
  const snap = engine.indicatorSnapshot(inst.id)
  if (!snap || !snap.bars.length) return null

  const newest = snap.bars.length - 1
  const input = { def, out: snap.out, bars: snap.bars, styles: inst.styles, end: newest, count: CARD_BARS }
  const model = buildModel(input)
  const end = model.start + model.count - 1
  const chartBar = legend && !legend.live ? legend.index : null
  const readIndex = touchBar !== null ? model.start + touchBar : (chartBar ?? end)
  const cursor = readIndex >= model.start && readIndex <= end && (touchBar !== null || chartBar !== null) ? readIndex - model.start : null
  const verdict = verdictAt({ ...input, i: readIndex }, model)
  const values = engine.indicatorValues(inst.id, readIndex)
  const readouts = def.plots
    .filter((p) => p.kind !== 'value' && p.kind !== 'dots')
    .map((p) => {
      const v = values.find((x) => x.key === p.key)
      return v && { key: p.key, label: p.title, text: v.text, color: v.color }
    })
    .filter((r): r is NonNullable<typeof r> => !!r)
    .slice(0, 4)
  const accent = model.lines[0]?.color ?? model.histograms[0]?.colors.at(-1) ?? '#2962ff'

  const plotH = CARD_PLOT.height - CARD_PLOT.padTop - CARD_PLOT.padBottom
  const y = (v: number) => CARD_PLOT.padTop + ((model.domain.max - v) / (model.domain.max - model.domain.min || 1)) * plotH
  const scale = (v: number) => (def.format === 'volume' ? formatVolume(v) : axisLabel(v))
  const touch = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setTouchBar(Math.min(model.count - 1, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * model.count))))
  }

  return (
    <section className={`phone-card is-${verdict.tone}`}>
      <header className="phone-card-head">
        <span className="phone-card-title">
          <span className="phone-dot" style={{ background: accent }} />
          <span className="phone-card-name" title={instanceTitle(def, inst)}>
            {def.short}
          </span>
        </span>
        <span className={`phone-verdict tone-${verdict.tone}`}>{verdict.text}</span>
      </header>
      <div className="phone-plot">
        <svg
          viewBox={`0 0 ${CARD_PLOT.width} ${CARD_PLOT.height}`}
          preserveAspectRatio="none"
          onPointerDown={touch}
          onPointerMove={(e) => (e.pointerType === 'mouse' || e.buttons) && touch(e)}
          onPointerLeave={() => setTouchBar(null)}
          onPointerUp={(e) => e.pointerType !== 'mouse' && setTouchBar(null)}
        >
          <defs>
            <clipPath id={clipId}>
              <rect width={CARD_PLOT.width} height={CARD_PLOT.height} />
            </clipPath>
          </defs>
          <Plot model={model} y={y} cursor={cursor} clipId={clipId} size={CARD_PLOT} />
        </svg>
        <div className="phone-axis">
          <span>{scale(model.domain.max)}</span>
          <span>{scale(model.domain.min)}</span>
        </div>
      </div>
      <div className="phone-readouts">
        {readouts.map((r) => (
          <span key={r.key}>
            <small>{r.label}</small>
            <b style={{ color: r.color }}>{r.text}</b>
          </span>
        ))}
      </div>
    </section>
  )
}

/** Scale, not measurement: a card of MACD needs no four decimals. */
function axisLabel(value: number): string {
  if (value === 0) return '0'
  const abs = Math.abs(value)
  return formatPrice(value, abs >= 100 ? 0 : abs >= 1 ? 1 : abs >= 0.01 ? 3 : 5)
}

const SignOutIcon = () => (
  <svg width={20} height={20} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 4H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3M12 6l4 4-4 4M16 10H8" />
  </svg>
)
