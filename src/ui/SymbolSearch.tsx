import { useEffect, useMemo, useRef, useState } from 'react'
import { describe, type Catalog } from '../data/products'
import type { Product } from '../data/types'
import { CoinLogo } from './common'
import { CloseIcon, SearchIcon } from './icons'

const QUOTES = ['All', 'USD', 'USDC', 'USDT', 'EUR', 'BTC'] as const
const QUOTE_RANK: Record<string, number> = { USD: 0, USDC: 1, USDT: 2, EUR: 3, GBP: 4, BTC: 5, ETH: 6 }

interface Props {
  catalog: Catalog
  title: string
  initial: string
  onPick: (product: Product) => void
  onClose: () => void
}

function rank(p: Product, q: string): number {
  if (!q) return QUOTE_RANK[p.quote] ?? 9
  if (p.ticker === q || p.base === q) return QUOTE_RANK[p.quote] ?? 9
  if (p.base.startsWith(q)) return 20 + (QUOTE_RANK[p.quote] ?? 9)
  if (p.ticker.startsWith(q)) return 40
  return 60
}

function Highlight({ text, query }: { text: string; query: string }) {
  const i = query ? text.toUpperCase().indexOf(query) : -1
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  )
}

/** TradingView's Symbol Search dialog over Coinbase's products. */
export function SymbolSearch({ catalog, title, initial, onPick, onClose }: Props) {
  const [query, setQuery] = useState(initial)
  const [quote, setQuote] = useState<(typeof QUOTES)[number]>('All')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const q = query.trim().toUpperCase().replace(/[-/ ]/g, '')

  const results = useMemo(() => {
    const matches = catalog.products.filter((p) => {
      if (quote !== 'All' && p.quote !== quote) return false
      if (!q) return true
      return p.ticker.includes(q) || describe(catalog, p).toUpperCase().replace(/ /g, '').includes(q)
    })
    return matches
      .map((p) => [rank(p, q), p] as const)
      .sort((a, b) => a[0] - b[0] || a[1].ticker.localeCompare(b[1].ticker))
      .slice(0, 150)
      .map(([, p]) => p)
  }, [catalog, q, quote])

  useEffect(() => setCursor(0), [q, quote])
  useEffect(() => {
    listRef.current?.querySelector('.selected')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(results.length - 1, c + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(0, c - 1))
    } else if (e.key === 'Enter' && results[cursor]) onPick(results[cursor])
    else if (e.key === 'Escape') onClose()
  }

  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog symbol-search" onKeyDown={onKey}>
        <div className="dialog-head">
          <span className="dialog-title">{title}</span>
          <button className="dialog-close" onClick={onClose} title="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="search-row">
          <SearchIcon />
          <input
            autoFocus
            value={query}
            spellCheck={false}
            placeholder="Symbol or coin name"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="clear-btn" onClick={() => setQuery('')}>
              <CloseIcon size={20} />
            </button>
          )}
        </div>
        <div className="search-tabs">
          {QUOTES.map((t) => (
            <button key={t} className={`pill${t === quote ? ' active' : ''}`} onClick={() => setQuote(t)}>
              {t === 'All' ? 'All' : `${t} pairs`}
            </button>
          ))}
        </div>
        <div className="search-list" ref={listRef}>
          {!catalog.products.length && <div className="search-empty">Loading symbols…</div>}
          {catalog.products.length > 0 && !results.length && (
            <div className="search-empty">No symbols match your criteria</div>
          )}
          {results.map((p, i) => (
            <div
              key={p.id}
              className={`search-item${i === cursor ? ' selected' : ''}`}
              onPointerEnter={() => setCursor(i)}
              onClick={() => onPick(p)}
            >
              <CoinLogo symbol={p.base} size={22} />
              <span className="search-ticker">
                <Highlight text={p.ticker} query={q} />
              </span>
              <span className="search-desc">{describe(catalog, p)}</span>
              <span className="search-type">spot crypto</span>
              <span className="search-exchange">
                COINBASE <span className="exchange-logo">C</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
