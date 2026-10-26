import { useEffect, useRef, useState } from 'react'
import { fetchCandles } from './coinbase'
import { feed } from './socket'

export interface Quote {
  price: number
  /** Close of the previous UTC day: TradingView's reference for the day's change. */
  prevClose: number | null
}

const DAY = 86400

async function previousClose(product: string): Promise<number | null> {
  const today = Math.floor(Date.now() / 1000 / DAY) * DAY
  const candles = await fetchCandles(product, DAY, today - 3 * DAY, today)
  const prev = candles.filter((c) => c.time < today).pop()
  return prev ? prev.close : null
}

/** Live prices for `products`, batched to a few renders a second. */
export function useQuotes(products: string[]): Record<string, Quote> {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})
  const pending = useRef<Record<string, Partial<Quote>>>({})
  const key = products.join(',')

  useEffect(() => {
    const list = key ? key.split(',') : []
    let alive = true
    const queue = (id: string, patch: Partial<Quote>) => {
      pending.current[id] = { ...pending.current[id], ...patch }
    }
    const loadCloses = () =>
      list.forEach((id) =>
        previousClose(id)
          .then((prevClose) => alive && queue(id, { prevClose }))
          .catch(() => {}),
      )
    loadCloses()
    let day = Math.floor(Date.now() / 1000 / DAY)
    const unsubs = list.map((id) => feed.subscribe('ticker', id, (t) => queue(id, { price: t.price })))
    const flush = setInterval(() => {
      const batch = pending.current
      if (!Object.keys(batch).length) return
      pending.current = {}
      setQuotes((prev) => {
        const next = { ...prev }
        for (const [id, patch] of Object.entries(batch))
          next[id] = { ...(prev[id] ?? { price: NaN, prevClose: null }), ...patch }
        return next
      })
    }, 250)
    // A new UTC day moves the reference close.
    const midnight = setInterval(() => {
      const now = Math.floor(Date.now() / 1000 / DAY)
      if (now !== day) {
        day = now
        loadCloses()
      }
    }, 60000)
    return () => {
      alive = false
      unsubs.forEach((u) => u())
      clearInterval(flush)
      clearInterval(midnight)
    }
  }, [key])

  return quotes
}
