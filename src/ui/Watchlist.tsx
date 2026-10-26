import { getProduct, type Catalog } from '../data/products'
import type { Quote } from '../data/quotes'
import { formatChange, formatPercent, formatPrice } from '../format'
import { CoinLogo } from './common'
import { CloseIcon, PlusIcon } from './icons'

interface Props {
  catalog: Catalog
  symbols: string[]
  active: string
  quotes: Record<string, Quote>
  onSelect: (id: string) => void
  onRemove: (id: string) => void
  onAdd: () => void
}

export function Watchlist({ catalog, symbols, active, quotes, onSelect, onRemove, onAdd }: Props) {
  return (
    <section className="watchlist">
      <div className="wl-head">
        <span className="wl-title">Watchlist</span>
        <button className="tb-btn icon small" onClick={onAdd} title="Add symbol">
          <PlusIcon />
        </button>
      </div>
      <div className="wl-cols">
        <span>Symbol</span>
        <span>Last</span>
        <span>Chg</span>
        <span>Chg%</span>
      </div>
      <div className="wl-rows">
        {symbols.map((id) => {
          const p = getProduct(catalog, id)
          const q = quotes[id]
          const price = q?.price
          const change = q && q.prevClose != null && Number.isFinite(price) ? price - q.prevClose : null
          const dir = change === null ? '' : change >= 0 ? 'up' : 'down'
          return (
            <div key={id} className={`wl-row${id === active ? ' active' : ''}`} onClick={() => onSelect(id)}>
              <span className="wl-symbol">
                <CoinLogo symbol={p.base} size={18} />
                {p.ticker}
              </span>
              <span>{price != null && Number.isFinite(price) ? formatPrice(price, p.precision) : '—'}</span>
              <span className={dir}>{change !== null ? formatChange(change, p.precision) : ''}</span>
              <span className={dir}>{change !== null ? formatPercent((change / q!.prevClose!) * 100) : ''}</span>
              <button
                className="wl-remove"
                title="Remove from watchlist"
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove(id)
                }}
              >
                <CloseIcon size={18} />
              </button>
            </div>
          )
        })}
      </div>
    </section>
  )
}
