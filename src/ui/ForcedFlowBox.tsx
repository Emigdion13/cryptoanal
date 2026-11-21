import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import {
  BANKRUPTCY_PRICE_VENUES,
  FORCED_FOLLOW_THROUGH,
  LIQUIDATION_BURST_USD,
  LIQUIDATION_VENUES,
  VENUE_LABEL,
  formatChange,
  isForcedFlow,
  type FlowLeader,
  type ForcedFlow,
  type OptionsPositioning,
  type SpotVsPerps,
} from '../data/forcedFlow'
import {
  FORCED_BOX_WAKE_LABEL,
  FORCED_STATE_LABEL as STATE_LABEL,
  FORCED_STATE_PILL as STATE_PILL,
  forcedBoxTransparency,
  forcedBoxWake,
  forcedTone as tone,
  formatNotional,
  newSqueezes,
  usd,
} from './forcedFlowRules'
import { CloseIcon } from './icons'
import type { ForcedFlowWindow } from './settings'

/** How often the window asks the dev server for a new reading. */
const POLL_MS = 2_000

/** The derivatives reading for `product` while the window is open, every couple of seconds. */
export function useForcedFlow(product: string | null): { flow: ForcedFlow | null; problem: string | null } {
  const [flow, setFlow] = useState<ForcedFlow | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    setFlow(null)
    setProblem(null)
    if (!product) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const response = await fetch(`/api/forced-flow?product=${encodeURIComponent(product)}`, { cache: 'no-store' })
        const data = (await response.json().catch(() => null)) as { flow?: unknown } | null
        if (!alive) return
        if (!response.ok || !data) throw new Error('The dev server is not answering.')
        setFlow(isForcedFlow(data.flow) ? data.flow : null)
        setProblem(null)
      } catch (e) {
        if (alive) setProblem(e instanceof Error ? e.message : 'The dev server is not answering.')
      }
      if (alive) timer = setTimeout(tick, document.hidden ? POLL_MS * 5 : POLL_MS)
    }
    void tick()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [product])
  return { flow, problem }
}

const clockTime = (seconds: number) => new Date(seconds * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })

/** 40s / 12m / 2h 5m */
const age = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/** "OKX, Kraken and Deribit" */
const venueList = (venues: readonly (keyof typeof VENUE_LABEL)[]) => {
  const names = venues.map((v) => VENUE_LABEL[v])
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

const unsigned = (value: number) => formatNotional(value).replace('+', '')

/** What the state means, in one sentence built from the live numbers. */
function explain(flow: ForcedFlow): string {
  const price = formatChange(flow.priceChange)
  const oi = formatChange(flow.oiChange)
  const oiSize = flow.oiChange === null ? '—' : `${Math.abs(flow.oiChange * 100).toFixed(2)}%`
  const longs = flow.liquidations.longUsd
  const shorts = flow.liquidations.shortUsd
  switch (flow.state) {
    case 'longs-liquidating':
      return longs >= LIQUIDATION_BURST_USD
        ? `${unsigned(longs)} of longs force-closed in the last minute. The drop is margin calls, not new sellers.`
        : `Price ${price} in 5m while open interest fell ${oiSize}: longs are being closed out, not shorts piling in.`
    case 'shorts-liquidating':
      return shorts >= LIQUIDATION_BURST_USD
        ? `${unsigned(shorts)} of shorts force-closed in the last minute. The pump is margin calls, not new buyers.`
        : `Price ${price} in 5m while open interest fell ${oiSize}: shorts are being closed out, not longs piling in.`
    case 'new-shorts':
      return `Price ${price} in 5m with open interest up ${oiSize}: fresh shorts are pushing it, nobody is being forced.`
    case 'new-longs':
      return `Price ${price} in 5m with open interest up ${oiSize}: fresh longs are pushing it, nobody is being forced.`
    case 'big-move':
      return `Price ${price} in 5m with open interest ${oi}, inside its usual range: the move came from spot or hedged flow, not liquidations.`
    case 'calm':
      return 'Price and open interest are inside their usual five-minute range.'
    case 'warming-up':
      return 'Needs five minutes of open-interest samples before it can compare.'
  }
}

/** Squeezes stay in the window's log this long after they end. */
const EVENT_LOG_SECONDS = 300

const percent = (rate: number) => `${Math.round(rate * 100)}%`

const LEADER_LABEL: Record<FlowLeader, string> = { spot: 'Spot led', perps: 'Perps led', together: 'Moved together' }

const LEADER_TITLE: Record<FlowLeader, string> = {
  spot: 'The perp premium moved against the move: Coinbase spot pulled price and the perps followed.',
  perps: 'The perp premium widened with the move: leveraged futures pushed price and spot followed.',
  together: 'The perp premium barely changed: spot and perps moved as one.',
}

/** 21.4k / 950 / 2.3 — base-coin open interest. */
const coins = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value >= 10 ? value.toFixed(0) : value.toFixed(1))

/** Strikes are round numbers; cents only add width. */
const strikePrice = (value: number) => usd(value, value >= 100 ? 0 : undefined)

const expiryLabel = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

/** Coinbase spot against the perps: who pushed the five-minute move. */
function SpotSection({ spot }: { spot: SpotVsPerps }) {
  const net = spot.boughtUsd - spot.soldUsd
  const status = spot.leader
    ? LEADER_LABEL[spot.leader]
    : spot.premium === null
      ? 'Waiting for perps'
      : spot.premiumChange === null
        ? 'Collecting'
        : 'Price quiet'
  return (
    <section className="forced-box-section" aria-label="Spot against perps">
      <div className="forced-box-section-head">
        <span className="forced-box-label">SPOT VS PERPS · 5M</span>
        <span className="forced-box-leader" data-leader={spot.leader ?? 'none'} title={spot.leader ? LEADER_TITLE[spot.leader] : undefined}>
          {status}
        </span>
      </div>
      <div className="forced-box-stats">
        <div className="forced-box-stat" title={`Coinbase spot taker buys ${unsigned(spot.boughtUsd)} / sells ${unsigned(spot.soldUsd)} in 5m`}>
          <span className="forced-box-label">SPOT TAKER NET</span>
          <span className="forced-box-value" data-sign={Math.sign(net)}>
            {spot.boughtUsd + spot.soldUsd > 0 ? formatNotional(net) : '—'}
          </span>
        </div>
        <div
          className="forced-box-stat"
          title={`Median last price of ${spot.perpVenues.map((v) => VENUE_LABEL[v]).join(', ') || 'no USD perps'} over Coinbase spot. In brackets: its change over 5m.`}
        >
          <span className="forced-box-label">PERP PREMIUM</span>
          <span className="forced-box-value">
            {formatChange(spot.premium, 3)}
            {spot.premiumChange !== null ? <span className="forced-box-delta"> ({formatChange(spot.premiumChange, 3)})</span> : null}
          </span>
        </div>
      </div>
    </section>
  )
}

/** Deribit options open interest for the coming week: settlement dates and the big strikes. */
function OptionsSection({ options, base }: { options: OptionsPositioning; base: string }) {
  if (!options.expiries.length) return null
  const main = options.expiries.reduce((a, b) => (b.openInterest > a.openInterest ? b : a))
  const next = options.expiries[0]
  const total = options.expiries.reduce((sum, e) => sum + e.openInterest, 0)
  const price = options.underlying
  const line = (e: OptionsPositioning['expiries'][number]) =>
    [`${coins(e.openInterest)} ${base}`, e.maxPain !== null ? `max pain ${strikePrice(e.maxPain)}` : null, e.putCall !== null ? `P/C ${e.putCall.toFixed(2)}` : null]
      .filter(Boolean)
      .join(' · ')
  // One strike a side keeps the box short: the biggest open interest above and below price.
  const biggest = (strikes: OptionsPositioning['strikes']) =>
    strikes.length ? [strikes.reduce((a, b) => (b.callOi + b.putOi > a.callOi + a.putOi ? b : a))] : []
  const below = price === null ? [] : biggest(options.strikes.filter((s) => s.strike < price))
  const above = biggest(price === null ? options.strikes : options.strikes.filter((s) => s.strike >= price))
  const strikeRow = (s: OptionsPositioning['strikes'][number]) => (
    <li key={s.strike}>
      <span>{strikePrice(s.strike)}</span>
      <span className="is-up">C {coins(s.callOi)}</span>
      <span className="is-down">P {coins(s.putOi)}</span>
    </li>
  )
  return (
    <section className="forced-box-section" aria-label="Options open interest">
      <div className="forced-box-section-head">
        <span className="forced-box-label">OPTIONS · DERIBIT · {options.horizonDays}D</span>
        <span className="forced-box-section-note">
          {coins(total)} {base} open
        </span>
      </div>
      <p className="forced-box-expiry" title={`Largest expiry inside ${options.horizonDays} days (${main.code}, 08:00 UTC)`}>
        <strong>{expiryLabel(main.time)}</strong> {line(main)}
      </p>
      {next !== main ? (
        <p className="forced-box-expiry is-minor" title={`Next expiry (${next.code}, 08:00 UTC)`}>
          Next {expiryLabel(next.time)} · {line(next)}
        </p>
      ) : null}
      {options.strikes.length ? (
        <ul className="forced-box-strikes" aria-label="Largest option strike above and below price">
          {above.map(strikeRow)}
          {price !== null ? (
            <li className="forced-box-strike-price" aria-label="Current price">
              <span>{strikePrice(price)}</span>
              <span>◂ price</span>
            </li>
          ) : null}
          {below.map(strikeRow)}
        </ul>
      ) : null}
    </section>
  )
}

/** A short two-note chime for a new squeeze. */
function chime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    ;[880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.frequency.value = freq
      const at = ctx.currentTime + i * 0.14
      gain.gain.setValueAtTime(0.0001, at)
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.3)
      osc.connect(gain).connect(ctx.destination)
      osc.start(at)
      osc.stop(at + 0.32)
    })
    setTimeout(() => void ctx.close(), 1000)
  } catch {
    // No sound is no harm.
  }
}

/** How close to the window's edge the box may sit. */
const EDGE = 4

/**
 * Forced flow (from btcAnalyzerV2): perpetual-futures positioning behind the charted move. Is it
 * leverage being force-closed (open interest collapsing, liquidation prints) or new positions
 * opening? Descriptive, not predictive: the info panel carries the measured follow-through, which is
 * the same for forced and unforced moves.
 */
export function ForcedFlowBox({
  product,
  ticker,
  state: saved,
  onChange,
}: {
  /** The perpetuals' coin, "BTC-USD"; null when the chart's market has none. */
  product: string | null
  /** The chart's ticker, for the "no perpetuals" note. */
  ticker: string
  state: ForcedFlowWindow
  onChange: (patch: Partial<ForcedFlowWindow>) => void
}) {
  const { flow, problem } = useForcedFlow(product)
  const [showInfo, setShowInfo] = useState(false)
  const transparency = forcedBoxTransparency(saved.transparency ?? 0)
  const wakeOn = saved.wake !== false
  const alerts = !!saved.alerts
  const wake = wakeOn ? forcedBoxWake(flow) : null
  const awake = transparency > 0 && wake !== null
  const boxRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight, boxW: 268, boxH: 0 })

  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    const measure = () => setViewport({ w: window.innerWidth, h: window.innerHeight, boxW: box.offsetWidth, boxH: box.offsetHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  // The bell: a chime for each new live squeeze. The first reading only learns what is already there.
  const seen = useRef<Set<string> | null>(null)
  useEffect(() => {
    seen.current = null
  }, [product])
  useEffect(() => {
    if (!flow) return
    const fresh = newSqueezes(flow, seen.current ?? new Set())
    const first = seen.current === null
    seen.current = new Set([...(seen.current ?? []), ...fresh])
    if (!first && fresh.length && alerts) chime()
  }, [flow, alerts])

  const clamp = (p: { x: number; y: number }) => ({
    x: Math.round(Math.min(Math.max(EDGE, p.x), Math.max(EDGE, viewport.w - viewport.boxW - EDGE))),
    y: Math.round(Math.min(Math.max(EDGE, p.y), Math.max(EDGE, viewport.h - Math.min(viewport.boxH, 120) - EDGE))),
  })
  const placed = drag ?? (saved.x !== undefined && saved.y !== undefined ? clamp({ x: saved.x, y: saved.y }) : null)
  const style: CSSProperties = placed ? { left: placed.x, top: placed.y, right: 'auto', bottom: 'auto' } : {}

  const startDrag = (e: ReactPointerEvent) => {
    const box = boxRef.current
    if (e.button !== 0 || !box || (e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    const rect = box.getBoundingClientRect()
    const origin = { x: rect.left, y: rect.top }
    const from = { x: e.clientX, y: e.clientY }
    let last = origin
    const move = (ev: PointerEvent) => {
      last = clamp({ x: origin.x + ev.clientX - from.x, y: origin.y + ev.clientY - from.y })
      setDrag(last)
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      setDrag(null)
      if (last !== origin) onChange({ x: last.x, y: last.y })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  const state = flow?.state ?? 'warming-up'
  const measured = state in FORCED_FOLLOW_THROUGH ? FORCED_FOLLOW_THROUGH[state as keyof typeof FORCED_FOLLOW_THROUGH] : null
  const all = FORCED_FOLLOW_THROUGH.all
  const recentEvents = flow ? flow.events.filter((e) => e.end >= flow.asOf - EVENT_LOG_SECONDS) : []
  const leader = flow?.spot?.leader ?? null
  const pill = state === 'big-move' && leader === 'spot' ? 'Spot-led' : state === 'big-move' && leader === 'perps' ? 'Perp-led' : STATE_PILL[state]

  return (
    <div
      ref={boxRef}
      className={`forced-box forced-box-${tone(state)}${transparency > 0 ? ' is-faded' : ''}${awake ? ' is-awake' : ''}${drag ? ' is-dragging' : ''}`}
      style={{ ...style, '--forced-opacity': 1 - transparency / 100 } as CSSProperties}
      role="status"
      aria-live="polite"
      aria-label="Forced flow"
      data-state={state}
      data-wake={awake ? wake : 'none'}
    >
      <header className="forced-box-head" onPointerDown={startDrag} title="Drag to move">
        <h2>Forced flow</h2>
        {product && <span className="forced-box-coin">{product.replace(/-USD$/, '')}</span>}
        <span className={`forced-box-pill forced-box-pill-${tone(state)}`}>{pill}</span>
        <button
          type="button"
          className={`forced-box-icon${alerts ? ' is-active' : ''}`}
          onClick={() => onChange({ alerts: !alerts })}
          aria-label={alerts ? 'Turn squeeze alerts off' : 'Turn squeeze alerts on'}
          aria-pressed={alerts}
          title={alerts ? 'Squeeze alerts on: a chime for each new squeeze' : 'Squeeze alerts off'}
        >
          <BellIcon off={!alerts} />
        </button>
        <button
          type="button"
          className={`forced-box-icon${showInfo ? ' is-active' : ''}`}
          onClick={() => setShowInfo((v) => !v)}
          aria-label="What this measures"
          aria-expanded={showInfo}
          title="What this measures"
        >
          <InfoIcon />
        </button>
        {saved.x !== undefined && (
          <button type="button" className="forced-box-icon" onClick={() => onChange({ x: undefined, y: undefined })} title="Back to its corner">
            <CornerIcon />
          </button>
        )}
        <button type="button" className="forced-box-icon" onClick={() => onChange({ open: false })} aria-label="Hide the forced flow window" title="Hide">
          <CloseIcon size={14} />
        </button>
      </header>

      <div className="forced-box-transparency" title="How see-through the whole window is. Hover it to read it; double-click the bar for solid.">
        <span className="forced-box-label">TRANSPARENCY</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={transparency}
          onChange={(event) => onChange({ transparency: forcedBoxTransparency(Number(event.target.value)) })}
          onDoubleClick={() => onChange({ transparency: 0 })}
          aria-label="Forced flow transparency"
          aria-valuetext={`${transparency}% transparent`}
        />
        <span className="forced-box-transparency-value">{transparency}%</span>
        <button
          type="button"
          className={`forced-box-icon forced-box-wake${wakeOn ? ' is-active' : ''}`}
          onClick={() => onChange({ wake: !wakeOn })}
          aria-pressed={wakeOn}
          title={
            awake && wake
              ? `Showing: ${FORCED_BOX_WAKE_LABEL[wake].toLowerCase()}`
              : wakeOn
                ? 'Comes back to solid while liquidations or a big move are happening'
                : 'Stays faded whatever happens'
          }
        >
          <ZapIcon off={!wakeOn} />
        </button>
      </div>

      {showInfo ? (
        <div className="forced-box-info">
          <p>
            Reads <strong>perpetual futures</strong>, where liquidations happen: open interest from{' '}
            {venueList(['okx', 'kraken', 'deribit', 'hyperliquid', 'coinbase-intl'])}, and liquidation prints from {venueList(LIQUIDATION_VENUES)}. Price
            falling while open interest falls unusually fast means longs are being closed out; rising, shorts.
          </p>
          <p>
            <strong>It explains the move, it does not call the next one.</strong> Over 180 days of BTC, a big 5m move got half of itself back within 15
            minutes {percent(all.back15m)} of the time
            {measured && state !== 'big-move' ? `; when this rule called it "${STATE_LABEL[state].toLowerCase()}", ${percent(measured.back15m)}` : ''}. No
            label beat the all-moves rate by more than noise, and crowded funding did not predict direction either.
          </p>
          <p>
            <strong>Spot vs perps</strong> compares Coinbase spot with the USD perps on Kraken and Deribit. If the perps&apos; premium widens in the
            direction of the move, futures pushed it; if it moves the other way, spot pulled it. <strong>Options</strong> are Deribit&apos;s open interest
            for the next {flow?.options?.horizonDays ?? 7} days; max pain is the settlement price that pays option holders least. All of these describe
            positioning; none has been tested as a signal.
          </p>
          <p>
            Binance and Bybit block US connections, so liquidation totals are a floor. OKX&apos;s live feed carries at most one order per contract each
            second; its full list is re-read every 30 seconds to fill in the rest. {venueList(BANKRUPTCY_PRICE_VENUES)} report the bankruptcy price, a
            little past where the market traded.
          </p>
        </div>
      ) : null}

      {!product ? (
        <p className="forced-box-explain">{ticker} has no perpetual futures to read. Chart a dollar market (BTC-USD, ETH-USD, SOL-USD…).</p>
      ) : problem && !flow ? (
        <p className="forced-box-explain">{problem}</p>
      ) : !flow ? (
        <p className="forced-box-explain">Waiting for the derivatives feed…</p>
      ) : (
        <>
          <div className="forced-box-headline" data-tone={tone(state)}>
            {STATE_LABEL[state]}
          </div>
          <p className="forced-box-explain">{explain(flow)}</p>

          <div className="forced-box-stats">
            <div
              className="forced-box-stat"
              title={flow.thresholds.move !== null ? `Big move = beyond ±${(flow.thresholds.move * 100).toFixed(2)}% (90th percentile of recent 5m windows)` : undefined}
            >
              <span className="forced-box-label">PRICE 5M</span>
              <span className="forced-box-value" data-sign={Math.sign(flow.priceChange ?? 0)}>
                {formatChange(flow.priceChange)}
              </span>
            </div>
            <div
              className="forced-box-stat"
              title={
                flow.thresholds.oiDrop !== null && flow.thresholds.oiRise !== null
                  ? `Usual 5m range ${formatChange(flow.thresholds.oiDrop)} … ${formatChange(flow.thresholds.oiRise)}`
                  : undefined
              }
            >
              <span className="forced-box-label">OPEN INT 5M</span>
              <span className="forced-box-value" data-sign={Math.sign(flow.oiChange ?? 0)}>
                {formatChange(flow.oiChange)}
              </span>
            </div>
            <div className="forced-box-stat" title="USD force-closed in the last minute">
              <span className="forced-box-label">LIQ 1M L / S</span>
              <span className="forced-box-value">
                <span className="is-down">{unsigned(flow.liquidations.longUsd)}</span>
                {' / '}
                <span className="is-up">{unsigned(flow.liquidations.shortUsd)}</span>
              </span>
            </div>
            <div className="forced-box-stat" title={`Mean of ${flow.funding.venues.map((v) => VENUE_LABEL[v]).join(', ') || 'no venues'}, per 8 hours`}>
              <span className="forced-box-label">FUNDING 8H</span>
              <span className="forced-box-value">
                {flow.funding.rate8h === null ? '—' : formatChange(flow.funding.rate8h, 4)}
                {flow.funding.crowded ? <span className="forced-box-crowded"> {flow.funding.crowded} crowded</span> : null}
              </span>
            </div>
          </div>

          {flow.spot ? <SpotSection spot={flow.spot} /> : null}
          {flow.options ? <OptionsSection options={flow.options} base={flow.product.replace(/-USD$/, '')} /> : null}

          {flow.liquidations.recent.length ? (
            <ul className="forced-box-prints" aria-label="Recent liquidations">
              {flow.liquidations.recent.slice(0, 4).map((l, i) => (
                <li key={`${l.venue}:${l.time}:${i}`} className={l.side === 'long' ? 'is-down' : 'is-up'}>
                  <span>{VENUE_LABEL[l.venue]}</span>
                  <span>{l.side === 'long' ? 'long liq' : 'short liq'}</span>
                  <span
                    title={
                      BANKRUPTCY_PRICE_VENUES.includes(l.venue)
                        ? `Bankruptcy price: ${VENUE_LABEL[l.venue]} reports where the position's margin ran out, a little past the market`
                        : undefined
                    }
                  >
                    {usd(l.price)}
                  </span>
                  <span>{unsigned(l.notional)}</span>
                </li>
              ))}
            </ul>
          ) : flow.liquidations.last ? (
            <p className="forced-box-quiet">
              No liquidations in 5m · last {VENUE_LABEL[flow.liquidations.last.venue]} {age(flow.asOf - flow.liquidations.last.time)} ago
            </p>
          ) : null}

          {recentEvents.length ? (
            <ul className="forced-box-events" aria-label="Recent forced-flow events">
              {[...recentEvents]
                .reverse()
                .slice(0, 3)
                .map((event) => (
                  <li key={event.id} className={event.state === 'longs-liquidating' ? 'is-down' : 'is-up'}>
                    <span>{clockTime(event.start)}</span>
                    <span>{event.state === 'longs-liquidating' ? 'Long squeeze' : 'Short squeeze'}</span>
                    <span>{formatChange(event.priceChange, 1)}</span>
                    <span>OI {formatChange(event.oiChange, 1)}</span>
                  </li>
                ))}
            </ul>
          ) : null}

          <footer className="forced-box-foot">
            <span title="Venues inside the open-interest change">OI: {flow.oiVenues.map((v) => VENUE_LABEL[v]).join(' · ') || 'none yet'}</span>
            <span className="forced-box-feeds" title="Liquidation feeds">
              {LIQUIDATION_VENUES.map((venue) => (
                <span key={venue} data-feed={flow.feeds[venue] ?? 'down'}>
                  {VENUE_LABEL[venue]}
                </span>
              ))}
            </span>
            {!flow.thresholds.calibrated ? (
              <span className="forced-box-calibrating">Calibrating · {flow.thresholds.samples} windows of history</span>
            ) : null}
          </footer>
        </>
      )}
    </div>
  )
}

const BellIcon = ({ off }: { off?: boolean }) => (
  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    {off && <path d="M2 2l20 20" />}
  </svg>
)

const InfoIcon = () => (
  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4M12 8h.01" />
  </svg>
)

const ZapIcon = ({ off }: { off?: boolean }) => (
  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
    {off && <path d="M2 2l20 20" />}
  </svg>
)

const CornerIcon = () => (
  <svg width={13} height={13} viewBox="0 0 14 14" fill="none" stroke="currentColor" aria-hidden>
    <path d="M3 7a4 4 0 1 0 1.2-2.9M3 2.5v2.2h2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
