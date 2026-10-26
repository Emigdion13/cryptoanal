import { useEffect, useState } from 'react'
import type { PriceMode } from '../chart/ChartEngine'
import { formatClock } from '../format'

export interface RangePreset {
  label: string
  title: string
  interval: string
  /** Start of the range, in seconds. */
  from: () => number
}

const DAY = 86400
const now = () => Math.floor(Date.now() / 1000)

/** The date-range buttons, with the interval TradingView switches each one to. */
export const RANGES: RangePreset[] = [
  { label: '1D', title: '1 day in 1 minute intervals', interval: '1', from: () => now() - DAY },
  { label: '5D', title: '5 days in 5 minute intervals', interval: '5', from: () => now() - 5 * DAY },
  { label: '1M', title: '1 month in 30 minute intervals', interval: '30', from: () => now() - 30 * DAY },
  { label: '3M', title: '3 months in 1 hour intervals', interval: '60', from: () => now() - 91 * DAY },
  { label: '6M', title: '6 months in 2 hour intervals', interval: '120', from: () => now() - 182 * DAY },
  {
    label: 'YTD',
    title: 'Year to date in 1 day intervals',
    interval: '1D',
    from: () => Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000,
  },
  { label: '1Y', title: '1 year in 1 day intervals', interval: '1D', from: () => now() - 365 * DAY },
  { label: '5Y', title: '5 years in 1 week intervals', interval: '1W', from: () => now() - 5 * 365 * DAY },
  { label: 'All', title: 'All data in 1 week intervals', interval: '1W', from: () => 0 },
]

interface Props {
  priceMode: PriceMode
  autoScale: boolean
  onRange: (r: RangePreset) => void
  onPriceMode: (mode: PriceMode) => void
  onAutoScale: (on: boolean) => void
}

export function BottomBar(props: Props) {
  const [clock, setClock] = useState(() => formatClock(new Date()))
  useEffect(() => {
    const t = setInterval(() => setClock(formatClock(new Date())), 1000)
    return () => clearInterval(t)
  }, [])
  const toggle = (mode: PriceMode) => props.onPriceMode(props.priceMode === mode ? 'normal' : mode)

  return (
    <div className="bottom-bar">
      <div className="ranges">
        {RANGES.map((r) => (
          <button key={r.label} className="bb-btn" title={r.title} onClick={() => props.onRange(r)}>
            {r.label}
          </button>
        ))}
      </div>
      <div className="header-spacer" />
      <span className="bb-clock">{clock}</span>
      <div className="sep" />
      <button
        className={`bb-btn${props.priceMode === 'percent' ? ' on' : ''}`}
        title="Toggle percentage"
        onClick={() => toggle('percent')}
      >
        %
      </button>
      <button
        className={`bb-btn${props.priceMode === 'log' ? ' on' : ''}`}
        title="Toggle log scale"
        onClick={() => toggle('log')}
      >
        log
      </button>
      <button
        className={`bb-btn${props.autoScale ? ' on' : ''}`}
        title="Toggle auto scale"
        onClick={() => props.onAutoScale(!props.autoScale)}
      >
        auto
      </button>
    </div>
  )
}
