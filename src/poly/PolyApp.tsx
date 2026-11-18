import { useCallback, useEffect, useRef, useState } from 'react'
import { phoneFetch, phoneSession, type PhoneSession } from '../phone/auth'
import { SignIn } from '../phone/PhoneApp'
import { Curve } from '../phone/PhoneHistory'
import { HISTORY_PERIODS, historyMoney as money, historyWhen, periodStart, type HistoryPeriod } from '../trade/history'
import { POLY_DOLLARS, type PolyPosition, type PolyResult, type PolySide, type PolyState, type PolyStats } from '../trade/polyUs'

type Tab = 'plays' | 'trade'
const TAB_KEY = 'cryptoanal.poly.tab'
const PERIOD_KEY = 'cryptoanal.poly.period'
const DOLLARS_KEY = 'cryptoanal.poly.dollars'
/** The round and the book are read this often while the Trade tab shows, ms. */
const STATE_MS = 1_000
const STATS_MS = 30_000
const STATUS_MS = 8_000
/** The auto-sell's % moves this much a tap. */
const PCT_STEP = 5

const stored = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
  try {
    const value = localStorage.getItem(key)
    return allowed.includes(value as T) ? (value as T) : fallback
  } catch {
    return fallback
  }
}
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Remembered for this visit only.
  }
}

const cents = (price: number | null) => (price === null ? '—' : `${Number((price * 100).toFixed(1))}¢`)
const usd = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const sideName = (side: PolySide) => (side === 'up' ? 'Up' : 'Down')
const message = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.')

type Screen = { kind: 'loading' } | { kind: 'refused'; message: string } | { kind: 'signIn'; session: PhoneSession } | { kind: 'ready' }

/** polymarket.html: the phone page's sign-in, then Polymarket US's 5-minute rounds, real money. */
export function PolyApp() {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' })
  const check = useCallback(async () => {
    try {
      const session = await phoneSession()
      setScreen(session.signedIn ? { kind: 'ready' } : { kind: 'signIn', session })
    } catch (error) {
      setScreen({ kind: 'refused', message: message(error) })
    }
  }, [])
  useEffect(() => void check(), [check])

  if (screen.kind === 'loading') return <div className="phone-center phone-dim">Connecting…</div>
  if (screen.kind === 'refused')
    return (
      <div className="phone-center">
        <p className="phone-note">{screen.message}</p>
        <button className="phone-btn" onClick={() => void check()}>
          Try again
        </button>
      </div>
    )
  if (screen.kind === 'signIn') return <SignIn session={screen.session} onDone={() => void check()} />
  return <PolyMain />
}

function PolyMain() {
  const [tab, setTabState] = useState<Tab>(() => stored(TAB_KEY, ['plays', 'trade'] as const, 'trade'))
  const [live, setLive] = useState<boolean | null>(null)
  const setTab = (next: Tab) => {
    store(TAB_KEY, next)
    setTabState(next)
  }
  return (
    <div className="phone">
      <header className="phone-head">
        <span className="phone-title">
          <b>Polymarket</b>
          <span className="phone-chip">BTC 5m</span>
        </span>
        <span className="phone-spacer" />
        {live === null ? null : (
          <span className={`phone-env ${live ? 'is-live' : 'is-demo'}`} title={live ? 'Real-money orders on Polymarket US' : 'Real-money orders are off (⚙ on the computer)'}>
            {live ? 'LIVE' : 'OFF'}
          </span>
        )}
      </header>
      <div className="phone-tabs poly-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'plays'} className={tab === 'plays' ? 'on' : undefined} onClick={() => setTab('plays')}>
          Plays
        </button>
        <button type="button" role="tab" aria-selected={tab === 'trade'} className={tab === 'trade' ? 'on' : undefined} onClick={() => setTab('trade')}>
          Trade
        </button>
      </div>
      {tab === 'plays' ? <PlaysTab /> : <TradeTab onLive={setLive} />}
    </div>
  )
}

/** How many plays, how many won, and what they made or lost after fees. */
function PlaysTab() {
  const [period, setPeriodState] = useState<HistoryPeriod>(() => stored(PERIOD_KEY, HISTORY_PERIODS.map((p) => p.key), 'today'))
  const [data, setData] = useState<PolyStats | null>(null)
  const [error, setError] = useState('')
  const setPeriod = (next: HistoryPeriod) => {
    store(PERIOD_KEY, next)
    setPeriodState(next)
  }
  useEffect(() => {
    let live = true
    const load = () =>
      phoneFetch<PolyStats>(`/api/poly/stats?from=${periodStart(period)}`).then(
        (next) => live && (setData(next), setError('')),
        (failure: unknown) => live && setError(message(failure)),
      )
    void load()
    const timer = setInterval(() => void load(), STATS_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [period])

  const totals = data?.totals
  const tone = !totals || totals.pnl === 0 ? 'flat' : totals.pnl > 0 ? 'up' : 'down'
  const curve = data ? [...data.plays].reverse().reduce<{ time: number; pnl: number }[]>((out, p) => [...out, { time: p.closedAt, pnl: (out.at(-1)?.pnl ?? 0) + p.pnl }], []) : []

  return (
    <div className="phone-history">
      <div className="phone-history-periods" role="group" aria-label="Period">
        {HISTORY_PERIODS.map((p) => (
          <button key={p.key} type="button" className={period === p.key ? 'on' : undefined} aria-pressed={period === p.key} onClick={() => setPeriod(p.key)}>
            {p.label}
          </button>
        ))}
      </div>
      {error ? <div className="phone-problem">{error}</div> : null}
      {totals ? (
        <>
          <section className="phone-card phone-history-total">
            <span className="phone-dim">Earned after fees</span>
            <b className={`is-${tone}`}>{money(totals.pnl)}</b>
            <span className="phone-dim">Plays made from this page</span>
            {curve.length >= 2 ? <Curve points={curve} tone={tone} /> : null}
          </section>
          <section className="poly-stats">
            <Stat label="Plays" value={String(totals.plays)} />
            <Stat label="Win rate" value={totals.plays ? `${Math.round((totals.wins / totals.plays) * 100)}%` : '—'} />
            <Stat label="Won / lost" value={`${totals.won} / ${totals.lost}`} hint="settled" />
            <Stat label="Per play" value={totals.plays ? money(totals.pnl / totals.plays) : '—'} />
            <Stat label="Best" value={totals.best === null ? '—' : money(totals.best)} tone="up" />
            <Stat label="Worst" value={totals.worst === null ? '—' : money(totals.worst)} tone="down" />
          </section>
        </>
      ) : !error ? (
        <div className="phone-wait">Reading the plays…</div>
      ) : null}
      {data && !data.plays.length ? <p className="phone-history-note phone-dim">No plays in this period.</p> : null}
      {data?.plays.length ? (
        <ul className="phone-card phone-history-list">
          {data.plays.map((p, i) => (
            <li key={`${p.slug}-${p.side}-${p.closedAt}-${i}`}>
              <span className="phone-history-when phone-dim">{historyWhen(p.closedAt)}</span>
              <span className="phone-history-what">
                {sideName(p.side)} · {p.contracts} for {usd(p.cost)} · {OUTCOME_TEXT[p.outcome]}
              </span>
              <b className={p.pnl > 0 ? 'is-up' : p.pnl < 0 ? 'is-down' : ''}>{money(p.pnl)}</b>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

const OUTCOME_TEXT = { won: 'won', lost: 'lost', sold: 'sold', 'auto-sold': 'auto-sold' } as const

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'up' | 'down' }) {
  return (
    <div className="phone-card poly-stat">
      <span className="phone-dim">
        {label}
        {hint ? <small> · {hint}</small> : null}
      </span>
      <b className={tone ? `is-${tone}` : undefined}>{value}</b>
    </div>
  )
}

/** The running round: its strike, the Up and Down prices, buying, what is held and its auto-sell. */
function TradeTab({ onLive }: { onLive: (live: boolean) => void }) {
  const [state, setState] = useState<PolyState | null>(null)
  const [error, setError] = useState('')
  const [dollars, setDollarsState] = useState<number>(() => {
    try {
      const n = Number(localStorage.getItem(DOLLARS_KEY))
      return n > 0 ? n : POLY_DOLLARS[0]
    } catch {
      return POLY_DOLLARS[0]
    }
  })
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [skew, setSkew] = useState(0)
  const [, setClock] = useState(0)
  const statusTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const setDollars = (n: number) => {
    store(DOLLARS_KEY, String(n))
    setDollarsState(n)
  }

  const load = useCallback(async () => {
    try {
      const next = await phoneFetch<PolyState>('/api/poly/state')
      setSkew(next.asOf - Date.now())
      setState(next)
      onLive(next.live)
      setError('')
    } catch (failure) {
      setError(message(failure))
    }
  }, [onLive])

  useEffect(() => {
    void load()
    const timer = setInterval(() => document.visibilityState === 'visible' && void load(), STATE_MS)
    // The countdown moves between reads.
    const clock = setInterval(() => setClock((n) => n + 1), 250)
    return () => {
      clearInterval(timer)
      clearInterval(clock)
    }
  }, [load])

  const send = async (key: string, route: string, body: Record<string, unknown>) => {
    if (busy) return
    setBusy(key)
    clearTimeout(statusTimer.current)
    try {
      const result = await phoneFetch<PolyResult>(`/api/poly/${route}`, body)
      setStatus({ tone: 'ok', text: result.message })
    } catch (failure) {
      setStatus({ tone: 'error', text: message(failure) })
    } finally {
      setBusy(null)
      statusTimer.current = setTimeout(() => setStatus(null), STATUS_MS)
      void load()
    }
  }

  if (!state) return error ? <div className="phone-problem">{error}</div> : <div className="phone-wait">Reading Polymarket…</div>
  const round = state.round
  const nowSec = (Date.now() + skew) / 1000
  const left = round ? Math.max(0, round.end - nowSec) : 0
  const diff = round?.strike != null && state.btc !== null ? state.btc - round.strike : null
  const held = state.positions.filter((p) => p.slug === round?.slug)

  return (
    <div className="poly-trade">
      {error || state.problem ? <div className="phone-problem">{error || state.problem}</div> : null}
      <section className="phone-card poly-round">
        <div className="poly-round-top">
          <span className="phone-dim">Ends in</span>
          <b className={`poly-clock${left < 30 ? ' is-late' : ''}`}>{round ? `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}` : '—'}</b>
        </div>
        <div className="poly-round-prices">
          <div>
            <span className="phone-dim">Price to beat</span>
            <b>{round?.strike != null ? usd(round.strike) : '—'}</b>
          </div>
          <div>
            <span className="phone-dim">BTC now</span>
            <b>{state.btc !== null ? usd(state.btc) : '—'}</b>
            {diff !== null ? (
              <small className={diff >= 0 ? 'is-up' : 'is-down'}>
                {diff >= 0 ? '▲' : '▼'} {usd(Math.abs(diff))}
              </small>
            ) : null}
          </div>
        </div>
      </section>

      <div className="poly-amounts" role="group" aria-label="Amount">
        {POLY_DOLLARS.map((n) => (
          <button key={n} type="button" className={dollars === n ? 'on' : undefined} aria-pressed={dollars === n} onClick={() => setDollars(n)}>
            ${n}
          </button>
        ))}
        <label className={`poly-custom${POLY_DOLLARS.includes(dollars as (typeof POLY_DOLLARS)[number]) ? '' : ' on'}`}>
          $
          <input
            inputMode="decimal"
            placeholder="Other"
            aria-label="Other amount, dollars"
            defaultValue={POLY_DOLLARS.includes(dollars as (typeof POLY_DOLLARS)[number]) ? '' : String(dollars)}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (n > 0) setDollars(n)
            }}
          />
        </label>
      </div>

      <div className="poly-buys">
        {(['up', 'down'] as const).map((side) => {
          const ask = round?.[side].ask ?? null
          return (
            <button
              key={side}
              type="button"
              className={`poly-buy is-${side}`}
              disabled={!state.live || !round?.open || ask === null || left < 5 || busy !== null}
              onClick={() => void send(`buy-${side}`, 'buy', { side, dollars })}
            >
              <span>
                {busy === `buy-${side}` ? 'Buying…' : `Buy ${sideName(side)}`} <small>${dollars}</small>
              </span>
              <b>{cents(ask)}</b>
              <small className="poly-buy-pays">{ask ? `≈ ${Math.floor(dollars / ask)} contracts, ≈ ${usd(Math.floor(dollars / ask))} if right` : 'nobody selling'}</small>
            </button>
          )
        })}
      </div>

      {status ? (
        <p className={`poly-status is-${status.tone}`} role="status">
          {status.text}
        </p>
      ) : null}

      <AutoSell pct={state.autoSellPct} on={held.length ? held.some((p) => p.autoSell !== null) : true} busy={busy !== null || !state.live} send={send} />

      {held.map((p) => (
        <Holding key={`${p.slug}-${p.side}`} p={p} bid={round?.[p.side].bid ?? null} busy={busy} live={state.live} send={send} />
      ))}
      {state.settling.length ? (
        <section className="phone-card poly-settling">
          {state.settling.map((p) => (
            <div key={`${p.slug}-${p.side}`}>
              <span>
                {sideName(p.side)} · {p.contracts}
                {p.avg !== null ? ` at ${cents(p.avg)}` : ''}
              </span>
              <span className="phone-dim">waiting for the result</span>
            </div>
          ))}
        </section>
      ) : null}
      <p className="phone-history-note phone-dim">
        {state.buyingPower !== null ? `Buying power ${usd(state.buyingPower)} · ` : ''}Polymarket US, real money
      </p>
    </div>
  )
}

/** The auto-sell for the next buys and what is held: the most a buy can make, less this %. */
function AutoSell({ pct, on, busy, send }: { pct: number; on: boolean; busy: boolean; send: (key: string, route: string, body: Record<string, unknown>) => Promise<void> }) {
  const set = (next: number | null) => void send('auto-sell', 'auto-sell', { pct: next })
  return (
    <section className="phone-card poly-auto">
      <div>
        <b>Auto-sell</b>
        <span className="phone-dim">{on ? `a sale on the book at the top profit less ${pct}%` : 'off'}</span>
      </div>
      <div className="poly-stepper">
        <button type="button" disabled={busy || pct - PCT_STEP < 1} onClick={() => set(Math.max(1, pct - PCT_STEP))} aria-label="Less">
          −
        </button>
        <span>{pct}%</span>
        <button type="button" disabled={busy || pct + PCT_STEP > 90} onClick={() => set(pct + PCT_STEP)} aria-label="More">
          +
        </button>
        <button type="button" className={on ? 'on' : undefined} disabled={busy} onClick={() => set(on ? null : pct)}>
          {on ? 'On' : 'Off'}
        </button>
      </div>
    </section>
  )
}

function Holding({
  p,
  bid,
  busy,
  live,
  send,
}: {
  p: PolyPosition
  bid: number | null
  busy: string | null
  live: boolean
  send: (key: string, route: string, body: Record<string, unknown>) => Promise<void>
}) {
  const value = bid !== null ? p.contracts * bid : null
  const open = value !== null && p.cost !== null ? value - p.cost : null
  const target = p.autoSell?.price ?? null
  return (
    <section className={`phone-card poly-holding is-${p.side}`}>
      <div className="poly-holding-head">
        <b>
          {sideName(p.side)} · {p.contracts} contracts
        </b>
        <span className="phone-dim">{p.avg !== null && p.cost !== null ? `at ${cents(p.avg)} · ${usd(p.cost)}` : 'bought in the Polymarket app'}</span>
      </div>
      <div className="poly-holding-row">
        <span className="phone-dim">Now {cents(bid)}</span>
        <b className={open === null ? '' : open >= 0 ? 'is-up' : 'is-down'}>{open === null ? '—' : money(open)}</b>
      </div>
      <div className="poly-holding-row">
        <span className="phone-dim">{target !== null ? `Auto-sells at ${cents(target)}` : 'No auto-sell'}</span>
        <span className="phone-dim">
          {p.cost === null ? '' : target !== null ? `≈ ${money(p.contracts * target - p.cost)}` : `${money(p.contracts - p.cost)} if it wins`}
        </span>
      </div>
      <button type="button" className="phone-btn poly-sell" disabled={!live || busy !== null || bid === null} onClick={() => void send(`sell-${p.side}`, 'sell-now', { slug: p.slug, side: p.side })}>
        {busy === `sell-${p.side}` ? 'Selling…' : `Sell now${bid !== null ? ` · ${cents(bid)}` : ''}`}
      </button>
    </section>
  )
}
