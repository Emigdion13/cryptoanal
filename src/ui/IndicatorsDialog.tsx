import { useMemo, useState } from 'react'
import { INDICATORS } from '../indicators/catalog'
import type { Category } from '../indicators/types'
import { CloseIcon, SearchIcon } from './icons'

const CATEGORIES: ('All' | Category)[] = ['All', 'Trend', 'Oscillators', 'Volatility', 'Volume', 'Price Action']

/** TradingView's "Indicators" dialog: search, categories, click a name to add it. */
export function IndicatorsDialog(props: { onAdd: (type: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('All')
  const [added, setAdded] = useState<string | null>(null)

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return INDICATORS.filter(
      (d) =>
        (category === 'All' || d.category === category) &&
        (!q || d.name.toLowerCase().includes(q) || d.short.toLowerCase().includes(q)),
    ).sort((a, b) => a.name.localeCompare(b.name))
  }, [query, category])

  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="dialog indicators-dialog" onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <div className="dialog-head">
          <span className="dialog-title">Indicators</span>
          <button className="dialog-close" onClick={props.onClose} title="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="search-row">
          <SearchIcon />
          <input autoFocus value={query} spellCheck={false} placeholder="Search" onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="ind-body">
          <nav className="ind-categories">
            <div className="ind-cat-head">Technicals</div>
            {CATEGORIES.map((c) => (
              <button key={c} className={`ind-cat${c === category ? ' active' : ''}`} onClick={() => setCategory(c)}>
                {c === 'All' ? 'Indicators' : c}
              </button>
            ))}
          </nav>
          <div className="ind-list">
            <div className="ind-list-head">Script name</div>
            {list.map((d) => (
              <div
                key={d.type}
                className="ind-item"
                onClick={() => {
                  props.onAdd(d.type)
                  setAdded(d.type)
                }}
              >
                <span>{d.name}</span>
                {added === d.type && <span className="ind-added">Added</span>}
              </div>
            ))}
            {!list.length && <div className="search-empty">No indicators match</div>}
          </div>
        </div>
      </div>
    </div>
  )
}
