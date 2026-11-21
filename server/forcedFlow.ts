import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { perpetualsFor, type ForcedFlow } from '../src/data/forcedFlow'
import { DerivativesService, type DerivativesFeed } from './derivatives'

/**
 * `GET /api/forced-flow?product=BTC-USD`: the Forced flow window's reading (src/ui/ForcedFlowBox.tsx),
 * from btcAnalyzerV2. The page asks every couple of seconds; each ask holds the product's watch for
 * `LEASE_MS`, so the venues are read only while a window is open, and stop shortly after it closes.
 *
 * The spot side of "spot vs perps" is Coinbase's public match feed for the same product, read here
 * on the server because the tracker lives here.
 */
export const LEASE_MS = 20_000

const COINBASE_WS = 'wss://ws-feed.exchange.coinbase.com'
/** Coinbase spot products with perpetuals: "BTC-USD", "ETH-USD"… */
const PRODUCT = /^[A-Z0-9]{1,12}-USD$/

type SpotTrade = Parameters<DerivativesFeed['spotTrade']>[1]

/** Coinbase spot matches for the products being watched, one reconnecting socket for all. */
export class CoinbaseSpotFeed {
  private socket: WebSocket | null = null
  private products = new Set<string>()
  private subscribed = new Set<string>()
  private retry = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private watchdog: ReturnType<typeof setInterval> | undefined
  private lastMessage = 0
  private closed = false
  private onTrade: (product: string, trade: SpotTrade) => void
  private factory: (url: string) => WebSocket

  constructor(onTrade: (product: string, trade: SpotTrade) => void, factory: (url: string) => WebSocket = (url) => new WebSocket(url)) {
    this.onTrade = onTrade
    this.factory = factory
  }

  watch(product: string) {
    this.products.add(product)
    this.ensure()
    this.reconcile()
  }

  unwatch(product: string) {
    this.products.delete(product)
    this.reconcile()
    if (!this.products.size) this.drop()
  }

  close() {
    this.closed = true
    this.products.clear()
    this.drop()
  }

  private ensure() {
    if (this.closed || this.socket || !this.products.size) return
    let socket: WebSocket
    try {
      socket = this.factory(COINBASE_WS)
    } catch {
      this.schedule()
      return
    }
    this.socket = socket
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return
      this.retry = 0
      this.subscribed.clear()
      this.lastMessage = Date.now()
      this.reconcile()
      clearInterval(this.watchdog)
      // The heartbeat channel speaks every second; silence means a dead socket.
      this.watchdog = setInterval(() => {
        if (this.socket === socket && Date.now() - this.lastMessage > 30_000) socket.close()
      }, 10_000)
    })
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket || typeof event.data !== 'string') return
      this.lastMessage = Date.now()
      this.dispatch(event.data)
    })
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      clearInterval(this.watchdog)
      this.schedule()
    })
    socket.addEventListener('error', () => socket.close())
  }

  private schedule() {
    if (this.closed || this.timer || !this.products.size) return
    const wait = Math.min(30_000, 1000 * 2 ** Math.min(this.retry++, 5))
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.ensure()
    }, wait)
  }

  private drop() {
    clearTimeout(this.timer)
    this.timer = undefined
    clearInterval(this.watchdog)
    const socket = this.socket
    this.socket = null
    this.subscribed.clear()
    socket?.close()
  }

  private reconcile() {
    const socket = this.socket
    if (!socket || socket.readyState !== 1) return
    const add = [...this.products].filter((p) => !this.subscribed.has(p))
    const remove = [...this.subscribed].filter((p) => !this.products.has(p))
    if (add.length) socket.send(JSON.stringify({ type: 'subscribe', product_ids: add, channels: ['matches', 'heartbeat'] }))
    if (remove.length) socket.send(JSON.stringify({ type: 'unsubscribe', product_ids: remove, channels: ['matches', 'heartbeat'] }))
    this.subscribed = new Set(this.products)
  }

  private dispatch(data: string) {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(data) as Record<string, unknown>
    } catch {
      return
    }
    // 'last_match' is the trade before the subscription; only live matches count as flow.
    if (msg.type !== 'match' || typeof msg.product_id !== 'string' || !this.products.has(msg.product_id)) return
    const time = Date.parse(String(msg.time)) / 1000
    this.onTrade(msg.product_id, {
      time,
      price: Number(msg.price),
      size: Number(msg.size),
      // Coinbase names the resting order's side: a resting sell was taken by a buyer.
      takerSide: msg.side === 'sell' ? 'buy' : msg.side === 'buy' ? 'sell' : null,
    })
  }
}

/** Holds a product's derivatives and spot watch while it is asked for, and lets go `LEASE_MS` after. */
export class ForcedFlowLeases {
  private leases = new Map<string, { release: () => void; timer: ReturnType<typeof setTimeout> }>()
  private feed: DerivativesFeed
  private spot: Pick<CoinbaseSpotFeed, 'watch' | 'unwatch' | 'close'>
  private leaseMs: number

  constructor(feed: DerivativesFeed, spot: Pick<CoinbaseSpotFeed, 'watch' | 'unwatch' | 'close'>, leaseMs = LEASE_MS) {
    this.feed = feed
    this.spot = spot
    this.leaseMs = leaseMs
  }

  /** The product's reading now; null for a product without perpetuals. */
  read(product: string, now = Date.now() / 1000): ForcedFlow | null {
    if (!PRODUCT.test(product) || !perpetualsFor(product)) return null
    const held = this.leases.get(product)
    if (held) clearTimeout(held.timer)
    else this.spot.watch(product)
    const release = held?.release ?? this.feed.watch(product)
    const timer = setTimeout(() => {
      this.leases.delete(product)
      release()
      this.spot.unwatch(product)
    }, this.leaseMs)
    this.leases.set(product, { release, timer })
    return this.feed.snapshot(product, now) ?? null
  }

  close() {
    for (const { release, timer } of this.leases.values()) {
      clearTimeout(timer)
      release()
    }
    this.leases.clear()
    this.spot.close()
    this.feed.close()
  }
}

export function createForcedFlowApi() {
  const service = new DerivativesService()
  const spot = new CoinbaseSpotFeed((product, trade) => service.spotTrade(product, trade))
  const leases = new ForcedFlowLeases(service, spot)
  const handle = (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/api/forced-flow') return false
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end(JSON.stringify({ message: 'GET only.' }))
      return true
    }
    const product = (url.searchParams.get('product') ?? '').toUpperCase()
    res.end(JSON.stringify({ product, flow: leases.read(product) }))
    return true
  }
  return { handle, close: () => leases.close() }
}

export function forcedFlowPlugin(): Plugin {
  let api: ReturnType<typeof createForcedFlowApi> | null = null
  const use = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/forced-flow')) return next()
    api ??= createForcedFlowApi()
    if (!api.handle(req, res)) next()
  }
  const stop = () => {
    api?.close()
    api = null
  }
  return {
    name: 'cryptoanal-forced-flow',
    configureServer(server) {
      server.middlewares.use(use)
      server.httpServer?.on('close', stop)
    },
    configurePreviewServer(server) {
      server.middlewares.use(use)
      server.httpServer?.on('close', stop)
    },
  }
}
