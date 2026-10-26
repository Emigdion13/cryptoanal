import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChartEngine } from './chart/ChartEngine'
import { getCache } from './data/cache'
import { aggregate, aggregateLast, baseGranularity, parseInterval } from './data/intervals'
import { feed } from './data/socket'
import type { Product } from './data/types'

/** Bars to have on hand when a chart opens; more load as you scroll back. */
const TARGET_BARS = 500
/** Coinbase pages fetched at most when a chart opens. */
const MAX_INITIAL_PAGES = 12

export type DataStatus = 'loading' | 'ready' | 'error'

interface PendingRange {
  product: string
  interval: string
  from: number
}

/**
 * Feeds the chart: cached bars at once, then the newest page, enough history to fill the
 * screen, older pages as you scroll left, and live trades from the socket.
 */
export function useChartData(engine: ChartEngine | null, product: Product, intervalId: string) {
  const [status, setStatus] = useState<DataStatus>('loading')
  const [attempt, setAttempt] = useState(0)
  const pending = useRef<PendingRange | null>(null)
  const runRef = useRef<{ product: string; interval: string; show: () => void } | null>(null)

  useEffect(() => {
    if (!engine) return
    const def = parseInterval(intervalId) ?? parseInterval('1D')!
    const cache = getCache(product.id, baseGranularity(def))
    const ratio = def.kind === 'fixed' ? def.seconds / cache.granularity : def.kind === 'week' ? 7 : 31
    let alive = true
    let ready = false
    let loadingMore = false

    const render = (keep: boolean) => {
      if (alive) engine.setBars(aggregate(cache.candles, def), keep)
    }

    /** A date-range button asked for this chart from a given time. */
    const show = async () => {
      const p = pending.current
      if (!p || p.product !== product.id || p.interval !== intervalId) return
      pending.current = null
      await cache.ensureFrom(p.from, 80)
      render(true)
      if (alive) engine.showFrom(p.from)
    }
    runRef.current = { product: product.id, interval: intervalId, show: () => ready && void show() }

    engine.setInterval(def)
    engine.setPrecision(product.precision)
    const hadCache = cache.candles.length > 0
    engine.setBars(hadCache ? aggregate(cache.candles, def) : [], false)
    setStatus('loading')

    ;(async () => {
      try {
        await cache.loadLatest()
        await cache.ensureCount(Math.min(MAX_INITIAL_PAGES * 300, Math.ceil(TARGET_BARS * ratio)))
        if (!alive) return
        render(hadCache)
        ready = true
        setStatus('ready')
        await show()
      } catch {
        if (!alive) return
        setStatus('error')
        setTimeout(() => alive && setAttempt((a) => a + 1), 3000)
      }
    })()

    const offTrades = feed.subscribe('matches', product.id, (m) => {
      if (!cache.applyTrade(m.price, m.size, m.time)) return
      const bar = aggregateLast(cache.candles, def)
      if (bar && alive) engine.updateLast(bar)
    })

    const offMore = engine.on('needMore', () => {
      if (!ready || loadingMore || cache.exhausted) return
      loadingMore = true
      cache
        .loadOlder(Math.min(4, Math.ceil(ratio)))
        .then((added) => added && render(true))
        .catch(() => {})
        .finally(() => (loadingMore = false))
    })

    // Fill whatever the socket missed while it was down or the tab slept.
    const catchUp = () => {
      if (ready) cache.loadLatest().then(() => render(true), () => {})
    }
    const offReconnect = feed.onReconnect(catchUp)
    let hiddenAt = 0
    const onVisibility = () => {
      if (document.hidden) hiddenAt = Date.now()
      else if (hiddenAt && Date.now() - hiddenAt > 30000) catchUp()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      alive = false
      offTrades()
      offMore()
      offReconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [engine, product.id, product.precision, intervalId, attempt])

  /** Shows `interval` bars from `from` to now, loading history as far back as needed. */
  const showRange = useCallback((from: number, interval: string, productId: string) => {
    pending.current = { product: productId, interval, from }
    const run = runRef.current
    if (run && run.product === productId && run.interval === interval) run.show()
  }, [])

  return { status, showRange }
}
