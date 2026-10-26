import type { LegendState } from '../chart/ChartEngine'
import type { IntervalDef } from '../data/intervals'
import type { Product } from '../data/types'
import { formatChange, formatPercent, formatPrice, formatVolume } from '../format'
import { CoinLogo } from './common'

interface Props {
  product: Product
  description: string
  interval: IntervalDef | null
  state: LegendState | null
}

/** The top-left legend: name, interval, exchange, then OHLC and change, then volume. */
export function Legend({ product, description, interval, state }: Props) {
  const bar = state?.bar
  const p = product.precision
  const dir = bar ? (bar.close >= bar.open ? 'up' : 'down') : ''
  const change = bar && state?.prevClose != null ? bar.close - state.prevClose : null
  const label = interval ? (interval.intraday ? interval.label : `1${interval.label}`) : ''

  return (
    <div className="legend">
      <div className="legend-row">
        <span className="legend-title">
          <CoinLogo symbol={product.base} />
          <span>
            {description} · {label} · Coinbase
          </span>
        </span>
        <span className="market-dot" title="Market open" />
        {bar && (
          <span className={`ohlc ${dir}`}>
            <span>
              O<b>{formatPrice(bar.open, p)}</b>
            </span>
            <span>
              H<b>{formatPrice(bar.high, p)}</b>
            </span>
            <span>
              L<b>{formatPrice(bar.low, p)}</b>
            </span>
            <span>
              C<b>{formatPrice(bar.close, p)}</b>
            </span>
            {change !== null && (
              <b className={change >= 0 ? 'up' : 'down'}>
                {formatChange(change, p)} ({formatPercent((change / state!.prevClose!) * 100)})
              </b>
            )}
          </span>
        )}
      </div>
      <div className="legend-row study">
        <span className="legend-study">Vol · {product.base}</span>
        {bar && <b className={dir}>{formatVolume(bar.volume, true)}</b>}
      </div>
    </div>
  )
}
