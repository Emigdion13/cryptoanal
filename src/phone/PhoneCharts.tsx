import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
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
import { HistoryIcon, PhoneHistory } from './PhoneHistory'
import { IndicatorsIcon, PhoneIndicatorSheet, reordered, usePhoneIndicators } from './PhoneIndicators'
import { FlowPill, TimingPicker, usePhoneTiming } from './PhoneFlow'
import { KalshiOdds, NextRoundSheet, NextRoundTimer } from './PhoneNextRound'
import { HoldingColumn, PhoneQuickTrade, TradeNote } from './PhoneQuickTrade'
import { useTrade, type Trade } from './useTrade'

/** How often the phone rereads the desktop's workspace, to follow its symbol, interval and indicators. */
const FOLLOW_MS = 15_000
/** The bars an indicator card holds: about what the price card shows at its width. */
const CARD_BARS = 60
/** An indicator card's plot, in svg units (it is drawn at the card's width). */
const CARD_PLOT = { width: 340, height: 120, padTop: 10, padBottom: 10 }
/** A closed indicator, a tile three to a row: its last bars as a sparkline, about at its pixel size. */
const TILE_BARS = 30
const TILE_PLOT = { width: 120, height: 40, padTop: 4, padBottom: 4 }
/** A touch that moves less than this (px) is a tap; more is a scroll or a scrub. */
const TAP_SLOP = 10
/** A tap is shorter than this, ms; a longer press on an open card is reading a bar. */
const TAP_MS = 300
/** A press this long on a closed tile lifts it, to be dragged to another place, ms. */
const HOLD_MS = 400
/** A dragged tile this close to the screen's top or bottom scrolls the cards, px. */
const EDGE_PX = 100
/** The cards' background (phone.css), under the price chart too. */
const CARD_BG = '#151a21'
/** How often the indicator cards follow the live bar, ms: every tick redrew them all, and a phone
 * busy redrawing cards could not follow a finger on the chart. A touched bar is followed at once. */
const CARD_LIVE_MS = 1_000
/** The screens left to right: History, then Charts (where the page opens). */
/** The page opens on the 1-minute chart, whichever chart the desktop has active. */
const OPEN_INTERVAL = '1'
const LANES = ['history', 'charts'] as const
type Lane = (typeof LANES)[number]

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

/** The tab the page opens on: the first 1-minute chart, else the desktop's active one. */
function firstChart(desktop: Desktop): number {
  const oneMinute = desktop.charts.findIndex((c) => c.interval === OPEN_INTERVAL)
  return oneMinute >= 0 ? oneMinute : desktop.active
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
 * then the price card with the desktop's overlays and drawings, and a tile per indicator that has a
 * pane of its own (floating ones too): its call, its value and a sparkline. A tap opens a tile into
 * the whole card; a tap on it, anywhere else or on another tile closes it. Press and hold a tile
 * to drag it to another place: the order is saved as the phone's own. Touch the price chart to read
 * a bar: the tiles and the card follow it. The charts follow the desktop's workspace; the
 * indicators are the phone's own once it has some (the header's chart button, PhoneIndicators.tsx).
 *
 * The button at the bottom middle shows V2's quick-trade circles on the coin's 15-minute Kalshi
 * market, and turns into an X that hides them. The
 * header's DEMO / LIVE badge picks the account (a tap switches); Live needs the computer's switch.
 * One swipe right (or the clock button) shows the History: every trade and what it made.
 */
export function PhoneCharts({ local, onSignOut, onSignedOut }: { local: boolean; onSignOut: () => void; onSignedOut: () => void }) {
  const { desktop, problem } = useDesktop(onSignedOut)
  const [picked, setPicked] = useState<number | null>(null)
  const index = desktop ? Math.min(picked ?? firstChart(desktop), desktop.charts.length - 1) : 0
  const desktopChart = desktop?.charts[index] ?? null
  // The phone's own indicators on every tab, once it has saved some; the desktop chart's until then.
  const mine = usePhoneIndicators(onSignedOut)
  const [editing, setEditing] = useState(false)
  // The phone's own timing (right of the quick-trade button): the chart and every indicator on it.
  const [timing, setTiming] = usePhoneTiming()
  const chart = useMemo(
    () => (desktopChart ? { ...desktopChart, ...(mine.list ? { indicators: mine.list } : {}), ...(timing ? { interval: timing } : {}) } : null),
    [desktopChart, mine.list, timing],
  )
  // Tiles dragged into a new order: saved as the phone's own list (a copy of the desktop's, the first time).
  const reorder = useCallback(
    (ids: string[]) => {
      if (chart) mine.save(reordered(chart.indicators, ids))
    },
    [chart, mine.save],
  )
  const trade = useTrade(chart?.symbol ?? 'BTC-USD')
  // The quick-trade circles are showing.
  const [quick, setQuick] = useState(false)
  // The Next round sheet, opened from the timer beside the quick-trade button.
  const [nextRound, setNextRound] = useState(false)

  // Two screens side by side (scroll snapping): History, and Charts where the page opens.
  const lanesRef = useRef<HTMLDivElement>(null)
  const [lane, setLane] = useState<Lane>('charts')
  const laneRef = useRef<Lane>(lane)
  laneRef.current = lane
  const go = (to: Lane) => {
    const lanes = lanesRef.current
    lanes?.scrollTo({ left: LANES.indexOf(to) * lanes.clientWidth, behavior: 'smooth' })
    setLane(to)
  }
  // Open on Charts, and stay on the same screen when the phone turns.
  useLayoutEffect(() => {
    const lanes = lanesRef.current
    if (!lanes) return
    const place = () => {
      lanes.scrollLeft = LANES.indexOf(laneRef.current) * lanes.clientWidth
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [])

  return (
    <>
      <div
        className="phone-lanes"
        ref={lanesRef}
        onScroll={(event) => {
          const el = event.currentTarget
          setLane(LANES[Math.round(el.scrollLeft / el.clientWidth)] ?? 'charts')
        }}
      >
        <section className="phone-lane phone" aria-label="History">
          <PhoneHistory active={lane === 'history'} trade={trade} onCharts={() => go('charts')} />
        </section>
        <section className={`phone-lane phone is-charts${quick ? ' has-quick' : ''}`} aria-label="Charts">
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
            <span className="phone-note phone-dim">{desktop ? (mine.list ? 'phone · live' : 'desktop · live') : 'connecting…'}</span>
            <AccountBadge trade={trade} />
            <button className="phone-icon-btn" onClick={() => setEditing(true)} title="Indicators" aria-label="Indicators">
              <IndicatorsIcon />
            </button>
            <button className="phone-icon-btn" onClick={() => go('history')} title="History" aria-label="History">
              <HistoryIcon />
            </button>
            {!local && (
              <button className="phone-icon-btn" onClick={onSignOut} title="Sign out" aria-label="Sign out">
                <SignOutIcon />
              </button>
            )}
          </header>
          {desktop && desktop.charts.length > 1 && (
            <nav className="phone-tabs">
              {desktop.charts.map((c, k) => (
                <button
                  key={k}
                  className={k === index ? 'on' : undefined}
                  onClick={() => {
                    // A tab is the desktop chart as it is: its own interval again.
                    setPicked(k)
                    setTiming(null)
                  }}
                >
                  {c.symbol.split('-')[0]} · {intervalLabel(c.interval)}
                </button>
              ))}
            </nav>
          )}
          {problem && <div className="phone-problem">{problem}</div>}
          {chart && desktop && (mine.ready || mine.problem) ? (
            <ChartCards
              key={`${index}:${chart.interval}`}
              chart={chart}
              scaleFit={desktop.scaleFit}
              drawings={desktop.drawings[chart.symbol]}
              onReorder={reorder}
            />
          ) : (
            !problem && <div className="phone-wait">Reading the desktop's chart…</div>
          )}
        </section>
      </div>
      {/* Outside the scrolling screens, so fixed means the phone's screen. */}
      {editing && chart && (
        <PhoneIndicatorSheet
          shown={chart.indicators}
          own={mine.list !== null}
          problem={mine.problem}
          onChange={mine.save}
          onReset={() => mine.save(null)}
          onClose={() => setEditing(false)}
        />
      )}
      {quick && chart && lane === 'charts' && <PhoneQuickTrade trade={trade} />}
      {!quick && !nextRound && chart && lane === 'charts' && <TradeNote trade={trade} />}
      {chart && lane === 'charts' && (
        <>
          <FlowPill product={chart.symbol} interval={chart.interval} />
          <HoldingColumn trade={trade} />
          <KalshiOdds trade={trade} />
          <TimingPicker interval={chart.interval} onChange={setTiming} />
        </>
      )}
      {chart && lane === 'charts' && <NextRoundTimer trade={trade} open={nextRound} onToggle={() => setNextRound(!nextRound)} />}
      {nextRound && chart && lane === 'charts' && <NextRoundSheet trade={trade} onClose={() => setNextRound(false)} />}
      {chart && lane === 'charts' && (
        <button
          type="button"
          className={`phone-quick-toggle${quick ? ' is-on' : ''}`}
          aria-pressed={quick}
          aria-label={quick ? 'Close quick trade' : 'Quick trade'}
          onClick={() => setQuick(!quick)}
        >
          {quick ? <CloseMark /> : <TradeMark />}
        </button>
      )}
    </>
  )
}

/**
 * DEMO or LIVE, and the account's cash. A tap switches; Live asks first, and says so when the
 * computer has not turned real-money orders on.
 */
function AccountBadge({ trade }: { trade: Trade }) {
  const { env, setEnv, state } = trade
  const flip = () => {
    if (env === 'live') return setEnv('demo')
    if (state && !state.liveEnabled && !window.confirm('Real-money orders are off on the computer (⚙ → Kalshi trading). Show Live anyway?')) return
    if (state?.liveEnabled && !window.confirm('Switch to LIVE? Orders will use real money.')) return
    setEnv('live')
  }
  return (
    <button type="button" className="phone-account" onClick={flip} title={env === 'live' ? 'Switch to Demo' : 'Switch to Live'}>
      <span className={`phone-env is-${env}`}>{env === 'live' ? 'LIVE' : 'DEMO'}</span>
      {state?.balance != null ? <span>${state.balance.toFixed(2)}</span> : null}
    </button>
  )
}

function intervalLabel(id: string): string {
  const iv = parseInterval(id)
  return iv ? (iv.intraday ? iv.label : `1${iv.label}`) : id
}

/** Memoized: the trade stream re-renders the page many times a second, and the charts need none of it. */
const ChartCards = memo(function ChartCards({
  chart,
  scaleFit,
  drawings,
  onReorder,
}: {
  chart: ChartState
  scaleFit: Desktop['scaleFit']
  drawings: UserDrawing[] | undefined
  onReorder: (ids: string[]) => void
}) {
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
  // The indicator opened from its tile; at most one.
  const [open, setOpen] = useState<string | null>(null)
  useCloseOnTapOutside(open !== null, () => setOpen(null))
  // It opens under the price chart, which a tap on a lower tile may have scrolled away.
  const tilesRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) tilesRef.current?.querySelector('.phone-tile.is-open')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [open])
  const tileDrag = useTileDrag(tilesRef, !!engine && cards.length > 0, cards, onReorder)

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

  const cardLegend = useCardLegend(legend)
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
      {engine && cards.length > 0 && (
        <div className="phone-tiles" ref={tilesRef} {...tileDrag}>
          {cards.map((inst) => {
            const def = INDICATOR_BY_TYPE.get(inst.type)!
            return (
              <IndicatorCard
                key={inst.id}
                inst={inst}
                def={def}
                engine={engine}
                legend={cardLegend}
                open={open === inst.id}
                onOpen={setOpen}
              />
            )
          })}
        </div>
      )}
    </main>
  )
})

/**
 * While an indicator is open, a tap outside every tile closes it. A tap, not a touch: a scroll or a
 * scrub of the price chart keeps it open (its reading follows the scrub). The quick-trade circles
 * float over the cards and are not outside. Pointer events, in capture: the chart's own handlers
 * see the touch first and may keep a click from ever firing.
 */
function useCloseOnTapOutside(active: boolean, close: () => void) {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!active) return
    let down: { x: number; y: number; id: number } | null = null
    const inside = (target: EventTarget | null) => target instanceof Element && !!target.closest('.phone-tile, .phone-quick, .phone-quick-toggle, .phone-next-timer, .phone-timings, .phone-hold, .phone-quick-pad-back')
    const onDown = (e: PointerEvent) => {
      down = e.isPrimary && !inside(e.target) ? { x: e.clientX, y: e.clientY, id: e.pointerId } : null
    }
    const onUp = (e: PointerEvent) => {
      if (down && e.pointerId === down.id && Math.hypot(e.clientX - down.x, e.clientY - down.y) < TAP_SLOP) closeRef.current()
      down = null
    }
    const onCancel = () => (down = null)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current()
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('pointerup', onUp, true)
    document.addEventListener('pointercancel', onCancel, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('pointerup', onUp, true)
      document.removeEventListener('pointercancel', onCancel, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [active])
}

/**
 * Press and hold a closed tile, then drag it: the tiles make room as it passes, and where it is let
 * go is its place. While it moves the tiles only take a CSS `order`, so nothing is moved in the page
 * under the finger; the new order goes to `onReorder` once, when it is let go (not if the press is
 * cancelled). A press that moves first is a scroll, and lifts nothing.
 */
function useTileDrag(tilesRef: RefObject<HTMLDivElement | null>, ready: boolean, cards: IndicatorInstance[], onReorder: (ids: string[]) => void) {
  const idsRef = useRef<string[]>([])
  idsRef.current = cards.map((c) => c.id)
  const onReorderRef = useRef(onReorder)
  onReorderRef.current = onReorder
  const lifted = useRef(false)
  const swallowClickUntil = useRef(0)
  const stop = useRef<((drop: boolean) => void) | null>(null)

  useEffect(() => {
    const tiles = tilesRef.current
    if (!ready || !tiles) return
    // The lifted tile follows the finger and the page stays put. Not passive, to be able to keep it.
    const hold = (e: TouchEvent) => lifted.current && e.cancelable && e.preventDefault()
    tiles.addEventListener('touchmove', hold, { passive: false })
    return () => tiles.removeEventListener('touchmove', hold)
  }, [tilesRef, ready])
  useEffect(() => () => stop.current?.(false), [])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const tiles = e.currentTarget
    const tile = e.target instanceof Element ? e.target.closest<HTMLElement>('.phone-tile:not(.is-open)') : null
    const id = tile?.dataset.id
    if (!tile || !id || !e.isPrimary || e.button !== 0) return
    stop.current?.(false)
    const pointer = e.pointerId
    const start = { x: e.clientX, y: e.clientY }
    let at = start
    let grab = start
    let order = idsRef.current
    let frame = 0
    // How far the cards scroll, read before the lifted tile (whose transform makes the page longer) moves.
    let most = 0
    const lane = tiles.closest<HTMLElement>('.phone-lane')
    const closed = () => [...tiles.querySelectorAll<HTMLElement>('.phone-tile[data-id]:not(.is-open)')]
    // Where a tile sits in the grid, whatever transform or glide it has.
    const slot = (el: HTMLElement) => {
      const box = tiles.getBoundingClientRect()
      return { left: box.left + el.offsetLeft, top: box.top + el.offsetTop, width: el.offsetWidth, height: el.offsetHeight }
    }
    const follow = () => {
      const s = slot(tile)
      tile.style.transform = `translate(${at.x - grab.x - s.left}px, ${at.y - grab.y - s.top}px) scale(1.05)`
    }
    // Over another tile, the lifted one takes its place; the ones between glide over by one.
    const place = () => {
      const others = closed().filter((el) => el !== tile)
      const over = others.find((el) => {
        const s = slot(el)
        return at.x >= s.left && at.x < s.left + s.width && at.y >= s.top && at.y < s.top + s.height
      })
      const to = over ? order.indexOf(over.dataset.id!) : -1
      if (to < 0 || !order.includes(id)) return
      const was = new Map(others.map((el) => [el, el.getBoundingClientRect()]))
      order = order.filter((x) => x !== id)
      order.splice(to, 0, id)
      for (const el of closed()) el.style.order = String(order.indexOf(el.dataset.id!))
      for (const [el, r] of was) {
        const s = slot(el)
        const dx = r.left - s.left
        const dy = r.top - s.top
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1)
          el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 160, easing: 'ease-out' })
      }
      follow()
    }
    // Taken toward the screen's top or bottom, near it, the cards scroll (one lifted there stays put).
    const scroll = () => {
      const step = at.y > innerHeight - EDGE_PX && at.y > start.y + TAP_SLOP ? 8 : at.y < EDGE_PX && at.y < start.y - TAP_SLOP ? -8 : 0
      const top = lane?.scrollTop
      if (lane && step) lane.scrollTop = Math.max(0, Math.min(most, lane.scrollTop + step))
      if (lane && lane.scrollTop !== top) {
        follow()
        place()
      }
      frame = requestAnimationFrame(scroll)
    }
    const lift = () => {
      lifted.current = true
      most = lane ? lane.scrollHeight - lane.clientHeight : 0
      const s = slot(tile)
      grab = { x: at.x - s.left, y: at.y - s.top }
      for (const el of closed()) el.style.order = String(order.indexOf(el.dataset.id!))
      tile.dataset.lifted = ''
      follow()
      navigator.vibrate?.(10)
      frame = requestAnimationFrame(scroll)
    }
    const timer = setTimeout(lift, HOLD_MS)

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return
      at = { x: ev.clientX, y: ev.clientY }
      if (!lifted.current) {
        if (Math.hypot(at.x - start.x, at.y - start.y) >= TAP_SLOP) end(false)
        return
      }
      follow()
      place()
    }
    const up = (ev: PointerEvent) => ev.pointerId === pointer && end(true)
    const cancel = (ev: PointerEvent) => ev.pointerId === pointer && end(false)
    const end = (drop: boolean) => {
      clearTimeout(timer)
      cancelAnimationFrame(frame)
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', cancel)
      stop.current = null
      if (!lifted.current) return
      lifted.current = false
      // The click that ends the press is not a tap on the tile.
      swallowClickUntil.current = performance.now() + 400
      delete tile.dataset.lifted
      tile.style.transform = ''
      for (const el of closed()) el.style.order = ''
      if (drop && order.some((x, k) => x !== idsRef.current[k])) onReorderRef.current(order)
    }
    stop.current = end
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', cancel)
  }
  const onClickCapture = (e: ReactMouseEvent) => {
    if (performance.now() >= swallowClickUntil.current) return
    e.stopPropagation()
    e.preventDefault()
  }
  // A long press on a tile lifts it; it is not asking for the browser's menu.
  const onContextMenu = (e: ReactMouseEvent) => {
    if (e.target instanceof Element && e.target.closest('.phone-tile:not(.is-open)')) e.preventDefault()
  }
  return { onPointerDown, onClickCapture, onContextMenu }
}

/** The legend the indicator cards follow: a touched bar at once, the live bar once a CARD_LIVE_MS. */
function useCardLegend(legend: LegendState | null): LegendState | null {
  const [shown, setShown] = useState(legend)
  const last = useRef(0)
  useEffect(() => {
    const show = () => {
      last.current = Date.now()
      setShown(legend)
    }
    const wait = legend?.live ? CARD_LIVE_MS - (Date.now() - last.current) : 0
    if (wait <= 0) return show()
    const timer = setTimeout(show, wait)
    return () => clearTimeout(timer)
  }, [legend])
  return shown
}

/**
 * One indicator. Closed, a tile: its name, the call it is read for, its main value and a sparkline,
 * tinted by the call; a tap opens it (press and hold to drag it, useTileDrag). Open, a card like
 * V2's: the last bars of what its pane would plot and its values; a tap closes it. Touch the plot
 * (or the price chart) to read another bar.
 */
const IndicatorCard = memo(function IndicatorCard({
  inst,
  def,
  engine,
  legend,
  open,
  onOpen,
}: {
  inst: IndicatorInstance
  def: IndicatorDef
  engine: ChartEngine
  legend: LegendState | null
  open: boolean
  onOpen: (id: string | null) => void
}) {
  const [touchBar, setTouchBar] = useState<number | null>(null)
  // The open card's press, to tell a tap (it closes the card) from a scrub or a held reading.
  const press = useRef<{ x: number; y: number; at: number } | null>(null)
  const clipId = `phone-clip-${useId().replace(/:/g, '')}`
  const snap = engine.indicatorSnapshot(inst.id)
  if (!snap || !snap.bars.length) return null

  const newest = snap.bars.length - 1
  const input = { def, out: snap.out, bars: snap.bars, styles: inst.styles, end: newest, count: open ? CARD_BARS : TILE_BARS }
  const model = buildModel(input)
  const end = model.start + model.count - 1
  const chartBar = legend && !legend.live ? legend.index : null
  const readIndex = open && touchBar !== null ? model.start + touchBar : (chartBar ?? end)
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

  const size = open ? CARD_PLOT : TILE_PLOT
  const plotH = size.height - size.padTop - size.padBottom
  const y = (v: number) => size.padTop + ((model.domain.max - v) / (model.domain.max - model.domain.min || 1)) * plotH
  const clip = (
    <defs>
      <clipPath id={clipId}>
        <rect width={size.width} height={size.height} />
      </clipPath>
    </defs>
  )

  if (!open) {
    const main = readouts[0]
    return (
      <section
        className={`phone-card phone-tile is-${verdict.tone}`}
        data-id={inst.id}
        role="button"
        tabIndex={0}
        aria-expanded={false}
        aria-label={`${instanceTitle(def, inst)}: ${verdict.text}${main ? `, ${main.label} ${main.text}` : ''}`}
        onClick={() => onOpen(inst.id)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          onOpen(inst.id)
        }}
      >
        {/* No name: the tiles keep their places, and the call is what is read. */}
        <span className={`phone-tile-call tone-${verdict.tone}`}>{verdict.text}</span>
        <b className="phone-tile-value" style={main?.color ? { color: readable(main.color) } : undefined}>
          {main?.text ?? ' '}
        </b>
        <svg viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" aria-hidden>
          {clip}
          {/* Labels and markers are noise at this size: the lines, bars and fills tell the story. */}
          <Plot model={{ ...model, texts: [], marks: [] }} y={y} cursor={cursor} clipId={clipId} size={size} />
        </svg>
      </section>
    )
  }

  const scale = (v: number) => (def.format === 'volume' ? formatVolume(v) : axisLabel(v))
  const touch = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setTouchBar(Math.min(model.count - 1, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * model.count))))
  }

  return (
    <section
      className={`phone-card phone-tile is-open is-${verdict.tone}`}
      data-id={inst.id}
      aria-expanded
      onPointerDown={(e) => (press.current = e.isPrimary ? { x: e.clientX, y: e.clientY, at: e.timeStamp } : null)}
      onClick={(e) => {
        const p = press.current
        if (p && e.timeStamp - p.at < TAP_MS && Math.hypot(e.clientX - p.x, e.clientY - p.y) < TAP_SLOP) onOpen(null)
      }}
    >
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
          {clip}
          <Plot model={model} y={y} cursor={cursor} clipId={clipId} size={size} />
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
})

/** The quick-trade button's mark: a bolt, for fast trading. */
const TradeMark = () => (
  <svg width={24} height={24} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M13.5 2 4.5 13.5h6L9.5 22l9-11.5h-6L13.5 2Z" />
  </svg>
)

const CloseMark = () => (
  <svg width={22} height={22} viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l10 10M16 6 6 16" />
  </svg>
)

/** A plot's colour as a tile's big value: one too dark to read on the card (a dimmed MACD bar's
 * maroon) is mixed halfway to white; a colour it cannot parse is kept. */
function readable(color: string): string {
  const hex = /^#([0-9a-f]{6})/i.exec(color)?.[1]
  const rgb = hex ? [0, 2, 4].map((k) => parseInt(hex.slice(k, k + 2), 16)) : /^rgba?\(([^)]+)\)/.exec(color)?.[1].split(',').slice(0, 3).map(Number)
  if (!rgb || rgb.some((v) => !Number.isFinite(v))) return color
  const [r, g, b] = rgb
  if (0.2126 * r + 0.7152 * g + 0.0722 * b >= 110) return `rgb(${r}, ${g}, ${b})`
  return `rgb(${[r, g, b].map((v) => Math.round((v + 255) / 2)).join(', ')})`
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
