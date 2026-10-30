import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChartEngine } from './chart/ChartEngine'
import { getCache } from './data/cache'
import { aggregate, aggregateLast, baseGranularity, granularityFor, parseInterval, type IntervalDef } from './data/intervals'
import { feed } from './data/socket'
import type { Product } from './data/types'
import { defaultInputs, INDICATOR_BY_TYPE } from './indicators/catalog'
import type { IndicatorInstance } from './indicators/types'

/** Bars to have on hand when a chart opens; more load as you scroll back. */
const TARGET_BARS = 500
/** Coinbase pages fetched at most when a chart opens. */
const MAX_INITIAL_PAGES = 12

export type DataStatus = 'loading' | 'ready' | 'error'

/** Coinbase granularities a chart's shown indicators read besides the chart's own bars. */
export function feedGranularitiesFor(indicators: readonly IndicatorInstance[], interval: IntervalDef | null): number[] {
  if (!interval) return []
  const grans = new Set<number>()
  for (const inst of indicators) {
    const def = INDICATOR_BY_TYPE.get(inst.type)
    if (!def?.feeds || inst.hidden) continue
    for (const seconds of def.feeds({ ...defaultInputs(def), ...inst.inputs }, interval)) grans.add(granularityFor(seconds))
  }
  return [...grans].sort((a, b) => a - b)
}

interface PendingRange {
  product: string
  interval: string
  from: number
}

/**
 * Feeds the chart: cached bars at once, then the newest page, enough history to fill the
 * screen, older pages as you scroll left, and live trades from the socket.
 */
export function useChartData(
  engine: ChartEngine | null,
  product: Product,
  intervalId: string,
  /** Coinbase granularities the chart's indicators read besides its own (e.g. TMO Scalper's). */
  feedGranularities: number[] = [],
) {
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
        if (!alive) return
        // Seconds charts page back through trades slowly: show each page as it lands.
        let shown = false
        await cache.ensureCount(Math.min(MAX_INITIAL_PAGES * 300, Math.ceil(TARGET_BARS * ratio)), () => {
          render(hadCache || shown)
          shown = true
        })
        if (!alive) return
        render(hadCache || shown)
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
      if (!cache.applyTrade(m.price, m.size, m.time, m.id)) return
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

  // Other-timeframe candles for indicators: as far back as the chart, kept live by the same trades.
  const feedKey = feedGranularities.join(',')
  useEffect(() => {
    if (!engine) return
    const grans = feedKey ? feedKey.split(',').map(Number) : []
    if (!grans.length) {
      engine.setFeeds(new Map())
      return
    }
    const def = parseInterval(intervalId) ?? parseInterval('1D')!
    const chartGran = baseGranularity(def)
    const caches = grans.map((g) => getCache(product.id, g))
    let alive = true
    let syncing = false
    /** The chart's first bar the feeds were last loaded back to. */
    let coveredFrom = Infinity
    const push = () => alive && engine.setFeeds(new Map(caches.map((c) => [c.granularity, c])))
    /**
     * Loads each feed back to the chart's first bar (40 pages at most: a year of 1m is too much).
     * `latest` also refreshes the newest page (at the start, after a reconnect); otherwise only
     * history the chart has newly scrolled into is fetched.
     */
    const sync = async (latest: boolean) => {
      const first = engine.getBars()[0]?.time
      if (syncing || (!latest && (first === undefined || first >= coveredFrom))) return
      syncing = true
      try {
        for (const c of caches) {
          if (latest) await c.loadLatest()
          // Before the chart's bars are in, the newest page is all there is to match.
          if (first !== undefined) await c.ensureFrom(first - 60 * c.granularity, 40)
          if (!alive) return
        }
        coveredFrom = first ?? Infinity
        push()
      } catch {
        // Retried when the chart loads more history or the socket reconnects.
      } finally {
        syncing = false
      }
    }
    push()
    void sync(true)
    // The chart's own bars may still be loading: catch up with them once they're in.
    let tries = 0
    const settle = setInterval(() => {
      if (++tries > 20 || coveredFrom !== Infinity) clearInterval(settle)
      else void sync(false)
    }, 1500)
    // The chart's own cache already gets every trade; the others are folded in here.
    const others = caches.filter((c) => c.granularity !== chartGran)
    const offTrades = feed.subscribe('matches', product.id, (m) => {
      let changed = false
      for (const c of others) if (c.applyTrade(m.price, m.size, m.time, m.id)) changed = true
      if (changed && alive) engine.feedsTicked()
    })
    // History the chart loads later (scrolling back) is matched once its new bars are in.
    const offMore = engine.on('needMore', () => setTimeout(() => void sync(false), 1500))
    const offReconnect = feed.onReconnect(() => void sync(true))
    return () => {
      alive = false
      clearInterval(settle)
      offTrades()
      offMore()
      offReconnect()
    }
  }, [engine, product.id, intervalId, feedKey])

  /** Shows `interval` bars from `from` to now, loading history as far back as needed. */
  const showRange = useCallback((from: number, interval: string, productId: string) => {
    pending.current = { product: productId, interval, from }
    const run = runRef.current
    if (run && run.product === productId && run.interval === interval) run.show()
  }, [])

  return { status, showRange }
}
