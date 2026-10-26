import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChartEngine, type LegendState } from './chart/ChartEngine'
import { parseInterval } from './data/intervals'
import { describe, getProduct, useCatalog } from './data/products'
import { useQuotes } from './data/quotes'
import type { Product } from './data/types'
import { formatPercent, formatPrice } from './format'
import { BottomBar, type RangePreset } from './ui/BottomBar'
import { Header } from './ui/Header'
import { IntervalDialog } from './ui/IntervalDialog'
import { RealtimeIcon } from './ui/icons'
import { Legend } from './ui/Legend'
import { useSettings } from './ui/settings'
import { LeftToolbar, RightToolbar } from './ui/Sidebars'
import { SymbolSearch } from './ui/SymbolSearch'
import { Watchlist } from './ui/Watchlist'
import { useChartData } from './useChartData'

type SearchState = { initial: string; mode: 'symbol' | 'watchlist' }

export function App() {
  const [settings, update] = useSettings()
  const catalog = useCatalog()
  const product = getProduct(catalog, settings.symbol)
  const interval = parseInterval(settings.interval)
  const hostRef = useRef<HTMLDivElement>(null)
  const [engine, setEngine] = useState<ChartEngine | null>(null)
  const [legend, setLegend] = useState<LegendState | null>(null)
  const [autoScale, setAutoScale] = useState(true)
  const [realtime, setRealtime] = useState(true)
  const [search, setSearch] = useState<SearchState | null>(null)
  const [intervalText, setIntervalText] = useState<string | null>(null)

  useEffect(() => {
    const e = new ChartEngine(hostRef.current!)
    const offs = [e.on('legend', setLegend), e.on('autoScale', setAutoScale), e.on('realtime', setRealtime)]
    setEngine(e)
    if (import.meta.env.DEV) Object.assign(window, { engine: e })
    return () => {
      offs.forEach((off) => off())
      e.destroy()
    }
  }, [])
  useEffect(() => engine?.setChartType(settings.chartType), [engine, settings.chartType])
  useEffect(() => engine?.setPriceMode(settings.priceMode), [engine, settings.priceMode])
  useEffect(() => engine?.setCursor(settings.cursor), [engine, settings.cursor])

  const { status, showRange } = useChartData(engine, product, settings.interval)

  const quoteIds = useMemo(
    () => [...new Set([...settings.watchlist, settings.symbol])],
    [settings.watchlist, settings.symbol],
  )
  const quotes = useQuotes(quoteIds)

  // TradingView's tab title: "BTCUSD 80,019.66 ▼ −0.04%".
  const quote = quotes[settings.symbol]
  useEffect(() => {
    if (!quote || !Number.isFinite(quote.price)) {
      document.title = `${product.ticker} — CryptoAnal`
      return
    }
    const pct = quote.prevClose ? ((quote.price - quote.prevClose) / quote.prevClose) * 100 : null
    const arrow = pct === null ? '' : pct >= 0 ? ' ▲' : ' ▼'
    document.title = `${product.ticker} ${formatPrice(quote.price, product.precision)}${arrow}${pct === null ? '' : ' ' + formatPercent(pct)}`
  }, [quote, product])

  const pickSymbol = useCallback(
    (p: Product) => {
      if (search?.mode === 'watchlist') {
        if (!settings.watchlist.includes(p.id)) update({ watchlist: [...settings.watchlist, p.id] })
      } else update({ symbol: p.id })
      setSearch(null)
    },
    [search, settings.watchlist, update],
  )

  const pickRange = (r: RangePreset) => {
    if (r.interval !== settings.interval) update({ interval: r.interval })
    showRange(r.from(), r.interval, settings.symbol)
  }

  const screenshot = () => {
    if (!engine) return
    const canvas = engine.screenshot(`${describe(catalog, product)} · ${interval?.label ?? ''} · Coinbase`)
    canvas.toBlob((blob) => {
      if (!blob) return
      const a = document.createElement('a')
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')
      a.href = URL.createObjectURL(blob)
      a.download = `${product.ticker}_${stamp}.png`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    })
  }

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen().catch(() => {})
  }

  // TradingView's keyboard: type a number for the interval box, letters for symbol search,
  // arrows to scroll and zoom, Alt+R to reset the chart.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('input, textarea, [contenteditable]') || search || intervalText !== null) return
      if (e.altKey && e.code === 'KeyR') {
        e.preventDefault()
        engine?.reset()
      } else if (e.ctrlKey || e.metaKey || e.altKey) return
      else if (/^[0-9]$/.test(e.key)) {
        e.preventDefault()
        setIntervalText(e.key)
      } else if (/^[a-zA-Z]$/.test(e.key)) {
        e.preventDefault()
        setSearch({ initial: e.key.toUpperCase(), mode: 'symbol' })
      } else if (e.key === 'ArrowLeft') engine?.scrollBy(-1)
      else if (e.key === 'ArrowRight') engine?.scrollBy(1)
      else if (e.key === 'ArrowUp') engine?.zoomBy(1.15)
      else if (e.key === 'ArrowDown') engine?.zoomBy(1 / 1.15)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine, search, intervalText])

  return (
    <div
      className="app"
      style={{
        gridTemplateColumns: settings.watchlistOpen ? '52px minmax(0, 1fr) 300px 45px' : '52px minmax(0, 1fr) 45px',
      }}
    >
      <Header
        product={product}
        interval={settings.interval}
        favorites={settings.favorites}
        chartType={settings.chartType}
        onSymbolSearch={() => setSearch({ initial: '', mode: 'symbol' })}
        onInterval={(id) => update({ interval: id })}
        onFavorites={(favorites) => update({ favorites })}
        onChartType={(chartType) => update({ chartType })}
        onFullscreen={toggleFullscreen}
        onScreenshot={screenshot}
      />
      <LeftToolbar cursor={settings.cursor} onCursor={(cursor) => update({ cursor })} />
      <main className="center">
        <div className="chart-wrap">
          <div className="chart-host" ref={hostRef} />
          <Legend product={product} description={describe(catalog, product)} interval={interval} state={legend} />
          {!realtime && (
            <button className="realtime-btn" title="Scroll to the most recent bar" onClick={() => engine?.scrollToRealtime()}>
              <RealtimeIcon />
            </button>
          )}
          {status === 'error' && <div className="chart-toast">Can't reach Coinbase — retrying…</div>}
        </div>
        <BottomBar
          priceMode={settings.priceMode}
          autoScale={autoScale}
          onRange={pickRange}
          onPriceMode={(priceMode) => update({ priceMode })}
          onAutoScale={(on) => engine?.setAutoScale(on)}
        />
      </main>
      {settings.watchlistOpen && (
        <Watchlist
          catalog={catalog}
          symbols={settings.watchlist}
          active={settings.symbol}
          quotes={quotes}
          onSelect={(symbol) => update({ symbol })}
          onRemove={(id) => update({ watchlist: settings.watchlist.filter((s) => s !== id) })}
          onAdd={() => setSearch({ initial: '', mode: 'watchlist' })}
        />
      )}
      <RightToolbar
        watchlistOpen={settings.watchlistOpen}
        onWatchlist={() => update({ watchlistOpen: !settings.watchlistOpen })}
      />
      {search && (
        <SymbolSearch
          catalog={catalog}
          title={search.mode === 'watchlist' ? 'Add symbol' : 'Symbol Search'}
          initial={search.initial}
          onPick={pickSymbol}
          onClose={() => setSearch(null)}
        />
      )}
      {intervalText !== null && (
        <IntervalDialog
          initial={intervalText}
          onPick={(id) => {
            update({ interval: id })
            setIntervalText(null)
          }}
          onClose={() => setIntervalText(null)}
        />
      )}
    </div>
  )
}
