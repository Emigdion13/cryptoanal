/**
 * Who is winning the candle: buyers or sellers. Every Coinbase trade has an aggressor, the side
 * that crossed the spread (a buyer taking an ask, or a seller hitting a bid). Their volumes over
 * the last 30 s to 15 min split 100%, the way Kalshi shows Up and Down.
 *
 * Live trades come from the shared socket; the window before the page opened is read from
 * Coinbase's trade history, a page of 1000 at a time, only as far back as the window asks.
 */
import { useEffect, useState } from 'react'
import { fetchTrades } from './coinbase'
import { feed } from './socket'

/** The windows, in seconds. */
export const FLOW_WINDOWS = [30, 60, 180, 300, 900] as const
export type FlowWindow = (typeof FLOW_WINDOWS)[number]
export const flowWindowText = (sec: number) => (sec < 60 ? `${sec}s` : `${sec / 60}m`)

/** Trades older than the longest window (and a minute) are dropped. */
const KEEP_SEC = 900 + 60
/** At most this many pages of history for one window (BTC trades a few thousand times in 15 min). */
const MAX_PAGES = 40

export interface FlowTrade {
  id: number
  /** Seconds since the epoch. */
  time: number
  size: number
  /** The aggressor bought. */
  buy: boolean
}

export interface Flow {
  /** Volume bought and sold by aggressors in the window, in the coin. */
  buy: number
  sell: number
  /** Buyers' share of it, 0–100; null with no trades. */
  buyPct: number | null
  trades: number
  /** The trades read reach back over the whole window (else it is the part since they start). */
  complete: boolean
}

/** The split over the `windowSec` before `now` (seconds), from trades sorted oldest first. */
export function flowOver(trades: readonly FlowTrade[], now: number, windowSec: number, coveredFrom: number): Flow {
  const from = now - windowSec
  let buy = 0,
    sell = 0,
    count = 0
  for (let i = trades.length - 1; i >= 0 && trades[i].time >= from; i--) {
    const t = trades[i]
    if (t.time > now) continue
    if (t.buy) buy += t.size
    else sell += t.size
    count++
  }
  const total = buy + sell
  return { buy, sell, buyPct: total > 0 ? (buy / total) * 100 : null, trades: count, complete: coveredFrom <= from }
}

/** One coin's recent trades: live ones as they come, history filled backwards on demand. */
export class OrderFlow {
  trades: FlowTrade[] = []
  /** Every trade from this time (seconds) on is here. */
  coveredFrom: number
  private ids = new Set<number>()
  private filling: Promise<void> | null = null
  private pages = 0

  constructor(
    readonly product: string,
    now = Date.now() / 1000,
    private readonly read: (product: string, olderThan?: number) => Promise<FlowTrade[]> = fetchFlowTrades,
  ) {
    this.coveredFrom = now
  }

  /** A live trade. */
  add(t: FlowTrade): void {
    if (this.ids.has(t.id)) return
    this.ids.add(t.id)
    const last = this.trades[this.trades.length - 1]
    this.trades.push(t)
    if (last && last.id > t.id) this.trades.sort((a, b) => a.id - b.id)
  }

  /** Reads history until the trades reach `windowSec` back (one fill at a time). */
  fill(windowSec: number, now = Date.now() / 1000): Promise<void> {
    if (this.filling) return this.filling
    const want = now - windowSec
    if (this.coveredFrom <= want || this.pages >= MAX_PAGES) return Promise.resolve()
    this.filling = (async () => {
      while (this.coveredFrom > want && this.pages < MAX_PAGES) {
        // The first page is the newest trades, which also closes any gap to the live ones.
        const page = await this.read(this.product, this.pages ? this.trades[0]?.id : undefined)
        this.pages++
        if (!page.length) break
        for (const t of page)
          if (!this.ids.has(t.id)) {
            this.ids.add(t.id)
            this.trades.push(t)
          }
        this.trades.sort((a, b) => a.id - b.id)
        this.coveredFrom = Math.min(this.coveredFrom, this.trades[0].time)
      }
    })().finally(() => {
      this.filling = null
    })
    return this.filling
  }

  /** Drops what no window needs. */
  prune(now = Date.now() / 1000): void {
    const cut = now - KEEP_SEC
    let i = 0
    while (i < this.trades.length && this.trades[i].time < cut) this.ids.delete(this.trades[i++].id)
    if (i) {
      this.trades.splice(0, i)
      this.coveredFrom = Math.max(this.coveredFrom, cut)
    }
  }

  /** After a dropped socket: what came in between is unknown, so start over from now. */
  reset(now = Date.now() / 1000): void {
    this.trades = []
    this.ids.clear()
    this.pages = 0
    this.coveredFrom = now
  }
}

async function fetchFlowTrades(product: string, olderThan?: number): Promise<FlowTrade[]> {
  return (await fetchTrades(product, olderThan)).map((t) => ({ id: t.id, time: t.time, size: t.size, buy: t.buy === true }))
}

/** One book per coin, shared by everything showing it; kept while something shows it. */
const books = new Map<string, { flow: OrderFlow; users: number; stop: () => void }>()

function takeBook(product: string): OrderFlow {
  let entry = books.get(product)
  if (!entry) {
    const book = new OrderFlow(product)
    const offTrades = feed.subscribe('matches', product, (m) => book.add({ id: m.id, time: m.time, size: m.size, buy: m.buy }))
    const offReconnect = feed.onReconnect(() => book.reset())
    entry = { flow: book, users: 0, stop: () => (offTrades(), offReconnect()) }
    books.set(product, entry)
  }
  entry.users++
  return entry.flow
}

function dropBook(product: string): void {
  const entry = books.get(product)
  if (entry && --entry.users <= 0) {
    entry.stop()
    books.delete(product)
  }
}

/** The buyers / sellers split over the last `windowSec`, again every half second. */
export function useOrderFlow(product: string, windowSec: number): Flow | null {
  const [book, setBook] = useState<OrderFlow | null>(null)
  const [flow, setFlow] = useState<Flow | null>(null)
  // The book follows the coin only: another window keeps the trades already read.
  useEffect(() => {
    setBook(takeBook(product))
    setFlow(null)
    return () => dropBook(product)
  }, [product])
  useEffect(() => {
    if (!book) return
    const update = () => {
      const now = Date.now() / 1000
      book.prune(now)
      void book.fill(windowSec, now).catch(() => undefined)
      setFlow(flowOver(book.trades, now, windowSec, book.coveredFrom))
    }
    update()
    const timer = setInterval(update, 500)
    return () => clearInterval(timer)
  }, [book, windowSec])
  return flow
}
