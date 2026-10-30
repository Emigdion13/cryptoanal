import type { ChartEngine, LegendState } from '../chart/ChartEngine'
import type { IntervalDef } from '../data/intervals'
import type { Product } from '../data/types'
import { formatChange, formatPercent, formatPrice } from '../format'
import { INDICATOR_BY_TYPE, instanceTitle } from '../indicators/catalog'
import type { IndicatorInstance } from '../indicators/types'
import type { StatusLine } from './settings'
import { CoinLogo } from './common'
import { canFloat } from './floatingModel'
import { ChevronDown, CloseIcon, EyeIcon, FloatIcon, GearIcon } from './icons'

export interface IndicatorActions {
  onToggle: (id: string) => void
  onSettings: (id: string) => void
  onRemove: (id: string) => void
  /** Opens or closes its floating window; left out where indicators can't float (a chart window). */
  onFloat?: (id: string) => void
}

interface RowProps extends IndicatorActions {
  inst: IndicatorInstance
  status: StatusLine
  product: Product
  engine: ChartEngine | null
  state: LegendState | null
  /** The phone page: title and values only, no buttons. */
  readOnly?: boolean
}

/** One indicator in the legend: title, values, and TradingView's hover buttons. */
export function IndicatorRow({ inst, status, product, engine, state, readOnly, onToggle, onSettings, onRemove, onFloat }: RowProps) {
  const def = INDICATOR_BY_TYPE.get(inst.type)
  if (!def) return null
  // The volume's "· BTC" is the symbol's name: it goes with the symbol title.
  const title = !status.indicatorTitles
    ? ''
    : def.type === 'volume'
      ? status.indicatorArgs && status.title
        ? `Vol · ${product.base}`
        : 'Vol'
      : status.indicatorArgs
        ? instanceTitle(def, inst)
        : def.short
  const values = engine && state && !inst.hidden && status.indicatorValues ? engine.indicatorValues(inst.id, state.index) : []
  return (
    <div className={`legend-row ind-row${inst.hidden ? ' off' : ''}`} onDoubleClick={() => !readOnly && onSettings(inst.id)}>
      {title && <span className="ind-title">{title}</span>}
      <span className="ind-values">
        {values.map((v) => (
          <b key={v.key} style={{ color: v.color }}>
            {v.text}
          </b>
        ))}
      </span>
      {!readOnly && (
        <span className="ind-actions">
          <button title={inst.hidden ? 'Show' : 'Hide'} onClick={() => onToggle(inst.id)}>
            <EyeIcon off={inst.hidden} />
          </button>
          {onFloat && canFloat(def) && (
            <button
              className={inst.floating?.open ? 'on' : undefined}
              title="Float in a window (instead of this pane)"
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
      )}
    </div>
  )
}

interface MainProps extends IndicatorActions {
  status: StatusLine
  product: Product
  description: string
  interval: IntervalDef | null
  state: LegendState | null
  engine: ChartEngine | null
  overlays: IndicatorInstance[]
  /** The overlays' rows are folded away, as TradingView's arrow under the legend does. */
  collapsed: boolean
  onCollapse: (collapsed: boolean) => void
  readOnly?: boolean
}

/** The price pane's legend: name, interval, exchange, OHLC and change, then its overlays. */
export function MainLegend({
  status,
  product,
  description,
  interval,
  state,
  engine,
  overlays,
  collapsed,
  onCollapse,
  ...actions
}: MainProps) {
  const bar = state?.bar
  const p = product.precision
  const dir = bar ? (bar.close >= bar.open ? 'up' : 'down') : ''
  const change = bar && state?.prevClose != null ? bar.close - state.prevClose : null
  const label = interval ? (interval.intraday ? interval.label : `1${interval.label}`) : ''

  return (
    <div className="legend">
      <div className="legend-row">
        {(status.logo || status.title) && (
          <span className="legend-title">
            {status.logo && <CoinLogo symbol={product.base} />}
            {status.title && (
              <span>
                {description} · {label} · Coinbase
              </span>
            )}
          </span>
        )}
        {status.title && <span className="market-dot" title="Market open" />}
        {bar && status.ohlc && (
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
            {change !== null && status.change && (
              <b className={change >= 0 ? 'up' : 'down'}>
                {formatChange(change, p)} ({formatPercent((change / state!.prevClose!) * 100)})
              </b>
            )}
          </span>
        )}
      </div>
      {!collapsed &&
        overlays.map((inst) => (
          <IndicatorRow key={inst.id} inst={inst} status={status} product={product} engine={engine} state={state} {...actions} />
        ))}
      {overlays.length > 0 && (
        <button
          className={`legend-toggle${collapsed ? ' collapsed' : ''}`}
          title={collapsed ? 'Show indicator legend' : 'Hide indicator legend'}
          onClick={() => onCollapse(!collapsed)}
        >
          <ChevronDown />
          {collapsed && <span>{overlays.length}</span>}
        </button>
      )}
    </div>
  )
}
