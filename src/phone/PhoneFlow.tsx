import { useState } from 'react'
import { useOrderFlow } from '../data/flow'
import { parseInterval } from '../data/intervals'

const TIMING_KEY = 'cryptoanal.phone.timing'

/** The timings right of the quick-trade button: the phone's chart and every indicator on it. */
export const TIMINGS = [
  { id: '30S', label: '30s' },
  { id: '1', label: '1m' },
  { id: '3', label: '3m' },
  { id: '5', label: '5m' },
  { id: '15', label: '15m' },
] as const

/**
 * The phone's own timing, remembered on the phone; null follows the desktop chart's interval
 * (picking another desktop chart tab goes back to that).
 */
export function usePhoneTiming() {
  const [timing, setTimingState] = useState<string | null>(() => {
    try {
      const saved = localStorage.getItem(TIMING_KEY)
      return TIMINGS.some((t) => t.id === saved) ? saved : null
    } catch {
      return null
    }
  })
  const setTiming = (next: string | null) => {
    try {
      if (next) localStorage.setItem(TIMING_KEY, next)
      else localStorage.removeItem(TIMING_KEY)
    } catch {
      // Remembered for this visit only.
    }
    setTimingState(next)
  }
  return [timing, setTiming] as const
}

/** Right of the quick-trade button: the chart's timing. */
export function TimingPicker({ interval, onChange }: { interval: string; onChange: (id: string) => void }) {
  return (
    <div className="phone-timings" role="radiogroup" aria-label="Chart timing">
      {TIMINGS.map((t) => (
        <button key={t.id} type="button" role="radio" aria-checked={interval === t.id} className={interval === t.id ? 'is-on' : ''} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  )
}

/** Buyers vs sellers are counted over one bar of the chart's timing, at most 15 minutes. */
const MAX_FLOW_SEC = 900
const flowSeconds = (interval: string) => Math.min(MAX_FLOW_SEC, parseInterval(interval)?.seconds ?? 60)
const pct = (v: number) => `${Math.round(v)}%`
const span = (sec: number) => (sec < 60 ? `${sec}s` : `${sec / 60}m`)

/**
 * Top right: who is winning, buyers or sellers. The split is the volume of Coinbase trades whose
 * aggressor bought (took an ask) vs sold (hit a bid), over the last bar's length of the chart.
 */
export function FlowPill({ product, interval }: { product: string; interval: string }) {
  const seconds = flowSeconds(interval)
  const flow = useOrderFlow(product, seconds)
  const up = flow?.buyPct ?? null
  const coin = product.split('-')[0]
  const lead = up === null ? '' : up > 50 ? ' is-buyers' : up < 50 ? ' is-sellers' : ''
  return (
    <div
      className={`phone-flow${lead}${flow && !flow.complete ? ' is-partial' : ''}`}
      style={up !== null ? { ['--buy' as string]: `${up}%` } : undefined}
      role="status"
      aria-label={
        flow && up !== null
          ? `Last ${span(seconds)}: buyers ${pct(up)} (${flow.buy.toFixed(3)} ${coin}), sellers ${pct(100 - up)} (${flow.sell.toFixed(3)} ${coin})${flow.complete ? '' : ', still reading the start of it'}`
          : 'Buyers and sellers: no trades yet'
      }
    >
      <span className="phone-flow-up">▲ {up !== null ? pct(up) : '–'}</span>
      <span className="phone-flow-down">▼ {up !== null ? pct(100 - up) : '–'}</span>
    </div>
  )
}
