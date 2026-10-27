import type { ChartEngine, LegendState } from '../chart/ChartEngine'
import type { IntervalDef } from '../data/intervals'
import type { Product } from '../data/types'
import { formatChange, formatPercent, formatPrice } from '../format'
import { INDICATOR_BY_TYPE, instanceTitle } from '../indicators/catalog'
import type { IndicatorInstance } from '../indicators/types'
import { CoinLogo } from './common'
import { canFloat } from './floatingModel'
import { CloseIcon, EyeIcon, FloatIcon, GearIcon } from './icons'

export interface IndicatorActions {
  onToggle: (id: string) => void
  onSettings: (id: string) => void
  onRemove: (id: string) => void
  /** Opens or closes its floating window. */
  onFloat: (id: string) => void
}

interface RowProps extends IndicatorActions {
  inst: IndicatorInstance
  product: Product
  engine: ChartEngine | null
  state: LegendState | null
}

/** One indicator in the legend: title, values, and TradingView's hover buttons. */
export function IndicatorRow({ inst, product, engine, state, onToggle, onSettings, onRemove, onFloat }: RowProps) {
  const def = INDICATOR_BY_TYPE.get(inst.type)
  if (!def) return null
  const title = def.type === 'volume' ? `Vol · ${product.base}` : instanceTitle(def, inst)
  const values = engine && state && !inst.hidden ? engine.indicatorValues(inst.id, state.index) : []
  return (
    <div className={`legend-row ind-row${inst.hidden ? ' off' : ''}`} onDoubleClick={() => onSettings(inst.id)}>
      <span className="ind-title">{title}</span>
      <span className="ind-values">
        {values.map((v) => (
          <b key={v.key} style={{ color: v.color }}>
            {v.text}
          </b>
        ))}
      </span>
      <span className="ind-actions">
        <button title={inst.hidden ? 'Show' : 'Hide'} onClick={() => onToggle(inst.id)}>
          <EyeIcon off={inst.hidden} />
        </button>
        {canFloat(def) && (
          <button
            className={inst.floating?.open ? 'on' : undefined}
            title={inst.floating?.open ? 'Close the floating window' : 'Floating window'}
            onClick={() => onFloat(inst.id)}
          >
            <FloatIcon />
          </button>
        )}
        <button title="Settings" onClick={() => onSettings(inst.id)}>
          <GearIcon />
        </button>
        <button title="Remove" onClick={() => onRemove(inst.id)}>
          <CloseIcon size={18} />
        </button>
      </span>
    </div>
  )
}

interface MainProps extends IndicatorActions {
  product: Product
  description: string
  interval: IntervalDef | null
  state: LegendState | null
  engine: ChartEngine | null
  overlays: IndicatorInstance[]
}

/** The price pane's legend: name, interval, exchange, OHLC and change, then its overlays. */
export function MainLegend({ product, description, interval, state, engine, overlays, ...actions }: MainProps) {
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
      {overlays.map((inst) => (
        <IndicatorRow key={inst.id} inst={inst} product={product} engine={engine} state={state} {...actions} />
      ))}
    </div>
  )
}
