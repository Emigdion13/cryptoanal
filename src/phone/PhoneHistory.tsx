import { useCallback, useEffect, useState } from 'react'
import {
  HISTORY_PERIODS,
  historyCurve,
  historyMoney as money,
  historyRoundText,
  historyWhen,
  periodStart,
  type HistoryPeriod,
  type TradeHistory,
} from '../trade/history'
import { phoneFetch } from './auth'
import type { Trade } from './useTrade'

const PERIOD_KEY = 'cryptoanal.phone.historyPeriod'
/** How often the shown history is read again, ms (a trade reads it at once). */
const REFRESH_MS = 60_000

function storedPeriod(): HistoryPeriod {
  try {
    const value = localStorage.getItem(PERIOD_KEY)
    return HISTORY_PERIODS.some((p) => p.key === value) ? (value as HistoryPeriod) : 'today'
  } catch {
    return 'today'
  }
}

/**
 * btcAnalyzerV2's History screen, one swipe left of the charts: every buy and sale on Kalshi, per
 * round, with what it made or lost after fees, the total and its running line, for today, 7 or 30
 * days, or everything. It follows the header's DEMO / LIVE.
 */
export function PhoneHistory({ active, trade, onCharts }: { active: boolean; trade: Trade; onCharts: () => void }) {
  const { env } = trade
  const [period, setPeriodState] = useState<HistoryPeriod>(storedPeriod)
  const [data, setData] = useState<TradeHistory | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  // The cash moves when a trade fills or a round settles: the history has news then.
  const balance = trade.state?.balance ?? null

  const setPeriod = (next: HistoryPeriod) => {
    try {
      localStorage.setItem(PERIOD_KEY, next)
    } catch {
      // Remembered for this visit only.
    }
    setPeriodState(next)
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await phoneFetch<TradeHistory>(`/api/trade/history?${new URLSearchParams({ env, from: String(periodStart(period)) })}`))
      setError('')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Kalshi did not answer.')
    } finally {
      setLoading(false)
    }
  }, [env, period])

  useEffect(() => {
    if (!active) return
    void load()
    const timer = setInterval(() => void load(), REFRESH_MS)
    return () => clearInterval(timer)
  }, [active, load, balance])

  const shown = data && data.env === env ? data : null
  const totals = shown?.totals
  const curve = shown ? historyCurve(shown.rounds) : []
  const tone = !totals || totals.pnl === 0 ? 'flat' : totals.pnl > 0 ? 'up' : 'down'

  return (
    <>
      <header className="phone-head">
        <span className="phone-title">
          <b>History</b>
        </span>
        <span className="phone-spacer" />
        <button type="button" className="phone-icon-btn" onClick={() => void load()} disabled={loading} aria-label="Read the history again" title="Refresh">
          <RefreshIcon spinning={loading} />
        </button>
        <span className={`phone-env is-${env}`}>{env === 'live' ? 'LIVE' : 'DEMO'}</span>
        <button type="button" className="phone-icon-btn" onClick={onCharts} aria-label="Charts" title="Charts">
          <ChartsIcon />
        </button>
      </header>
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
          <section className="phone-card phone-history-total">
            <span className="phone-dim">P&amp;L after fees</span>
            <b className={`is-${tone}`}>{money(totals.pnl)}</b>
            <span className="phone-dim">
              {totals.rounds} round{totals.rounds === 1 ? '' : 's'}
              {totals.rounds ? ` · ${totals.won} won (${Math.round((totals.won / totals.rounds) * 100)}%)` : ''} · fees ${totals.fees.toFixed(2)}
            </span>
            {curve.length >= 2 ? <Curve points={curve} tone={tone} /> : null}
          </section>
        ) : !error ? (
          <div className="phone-wait">Reading Kalshi…</div>
        ) : null}
        {shown?.truncated ? <p className="phone-history-note phone-dim">Only the latest 10,000 fills are counted.</p> : null}
        {shown && !shown.rounds.length ? <p className="phone-history-note phone-dim">No trades in this period.</p> : null}
        {shown?.rounds.length ? (
          <ul className="phone-card phone-history-list">
            {shown.rounds.map((r) => (
              <li key={r.ticker}>
                <span className="phone-history-when phone-dim">{historyWhen(r.time)}</span>
                <span className="phone-history-what" title={r.ticker}>
                  {r.ticker.split('-')[0].replace(/^KX/, '').replace(/15M$/, '')} · {historyRoundText(r)}
                </span>
                <b className={r.pnl === null ? 'is-open' : r.pnl > 0 ? 'is-up' : r.pnl < 0 ? 'is-down' : ''}>{r.pnl === null ? 'open' : money(r.pnl)}</b>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </>
  )
}

/** The running total after each round, oldest to newest, with a zero line. */
function Curve({ points, tone }: { points: { time: number; pnl: number }[]; tone: string }) {
  const width = 340
  const height = 70
  const values = points.map((p) => p.pnl)
  const top = Math.max(0, ...values)
  const bottom = Math.min(0, ...values)
  const span = top - bottom || 1
  const y = (v: number) => 4 + ((top - v) / span) * (height - 8)
  const x = (i: number) => (i / (points.length - 1)) * width
  return (
    <svg className={`phone-history-curve is-${tone}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Running P&L, round by round">
      <line x1={0} x2={width} y1={y(0)} y2={y(0)} className="phone-history-zero" />
      <polyline points={points.map((p, i) => `${x(i)},${y(p.pnl)}`).join(' ')} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

const RefreshIcon = ({ spinning }: { spinning: boolean }) => (
  <svg className={spinning ? 'is-spinning' : undefined} width={18} height={18} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M16 10a6 6 0 1 1-1.8-4.3M16 3.5v3h-3" />
  </svg>
)

const ChartsIcon = () => (
  <svg width={20} height={20} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
    <path d="M6 3v14M6 6h-2v6h2M6 6h2v6H6M14 4v12M14 7h-2v5h2M14 7h2v5h-2" />
  </svg>
)

export const HistoryIcon = () => (
  <svg width={20} height={20} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.5 10a6.5 6.5 0 1 0 1.9-4.6M3.5 3.5v3h3M10 6.5V10l2.5 1.5" />
  </svg>
)
