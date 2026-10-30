const WS_URL = 'wss://ws-feed.exchange.coinbase.com'

export interface Match {
  product: string
  price: number
  size: number
  /** Seconds since the epoch, with fractions. */
  time: number
  /** Coinbase's trade id: rising per product. */
  id: number
}

export interface Ticker {
  product: string
  price: number
  open24h: number
}

type Channel = 'matches' | 'ticker'
type Handler = (msg: Match | Ticker) => void

/**
 * One shared connection to Coinbase's public feed. Subscriptions are counted per channel and
 * product, survive reconnects, and a silent socket is replaced after a while.
 */
class CoinbaseFeed {
  private ws: WebSocket | null = null
  private handlers = new Map<string, Set<Handler>>()
  private reconnectListeners = new Set<() => void>()
  private retry = 0
  private lastMessage = 0
  private watchdog: ReturnType<typeof setInterval> | undefined
  private opened = false

  subscribe(channel: 'matches', product: string, fn: (m: Match) => void): () => void
  subscribe(channel: 'ticker', product: string, fn: (t: Ticker) => void): () => void
  subscribe(channel: Channel, product: string, fn: (m: never) => void): () => void {
    const key = `${channel}:${product}`
    let set = this.handlers.get(key)
    const handler = fn as Handler
    if (!set) {
      set = new Set()
      this.handlers.set(key, set)
      this.send('subscribe', channel, product)
    }
    set.add(handler)
    this.ensure()
    return () => {
      const s = this.handlers.get(key)
      if (!s) return
      s.delete(handler)
      if (!s.size) {
        this.handlers.delete(key)
        this.send('unsubscribe', channel, product)
      }
    }
  }

  /** Called after the socket comes back, so callers can fill the gap from REST. */
  onReconnect(fn: () => void): () => void {
    this.reconnectListeners.add(fn)
    return () => this.reconnectListeners.delete(fn)
  }

  private send(type: 'subscribe' | 'unsubscribe', channel: Channel, product: string) {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify({ type, product_ids: [product], channels: [channel] }))
  }

  private ensure() {
    if (this.ws) return
    const ws = new WebSocket(WS_URL)
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      this.lastMessage = Date.now()
      const byChannel = new Map<Channel, string[]>()
      for (const key of this.handlers.keys()) {
        const [channel, product] = key.split(':') as [Channel, string]
        byChannel.set(channel, [...(byChannel.get(channel) ?? []), product])
      }
      for (const [channel, products] of byChannel)
        ws.send(JSON.stringify({ type: 'subscribe', product_ids: products, channels: [channel] }))
      if (this.opened) for (const fn of this.reconnectListeners) fn()
      this.opened = true
    }
    ws.onmessage = (event) => {
      this.lastMessage = Date.now()
      this.dispatch(JSON.parse(event.data as string))
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      if (!this.handlers.size) return
      const delay = Math.min(15000, 500 * 2 ** this.retry++)
      setTimeout(() => this.ensure(), delay)
    }
    ws.onerror = () => ws.close()
    clearInterval(this.watchdog)
    this.watchdog = setInterval(() => {
      // Tickers for a handful of products arrive every few seconds; silence means a dead socket.
      if (this.ws === ws && ws.readyState === WebSocket.OPEN && Date.now() - this.lastMessage > 30000)
        ws.close()
    }, 5000)
  }

  private dispatch(msg: Record<string, string>) {
    // 'last_match' repeats a trade the REST candles already counted, so only live matches count.
    if (msg.type === 'match') {
      const set = this.handlers.get(`matches:${msg.product_id}`)
      if (!set) return
      const m: Match = {
        product: msg.product_id,
        price: Number(msg.price),
        size: Number(msg.size),
        time: Date.parse(msg.time) / 1000,
        id: Number(msg.trade_id),
      }
      for (const fn of set) fn(m)
    } else if (msg.type === 'ticker') {
      const set = this.handlers.get(`ticker:${msg.product_id}`)
      if (!set) return
      const t: Ticker = {
        product: msg.product_id,
        price: Number(msg.price),
        open24h: Number(msg.open_24h),
      }
      for (const fn of set) fn(t)
    }
  }
}

export const feed = new CoinbaseFeed()
