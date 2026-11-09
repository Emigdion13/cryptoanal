/**
 * Chainlink's prices as Polymarket streams them: the feed its crypto up/down markets settle on.
 *
 * Polymarket's Real-Time Data Socket (wss://ws-live-data.polymarket.com, topic
 * `crypto_prices_chainlink`) pushes one Chainlink price a second per coin, and a minute of them
 * when a subscription starts. There is no history to page back through, so this records every
 * price while the dev server runs, to memory and to `.chainlink/` (one CSV a coin a UTC day), and
 * serves candles of any size from what it has: /api/chainlink/candles. The browser takes the live
 * prices from the socket itself (src/data/chainlink.ts); this is the history behind them.
 */
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Plugin } from 'vite'
import { parseRtds, RTDS_URL } from '../src/data/rtds'

export { parseRtds, RTDS_URL, type ChainlinkTick } from '../src/data/rtds'

/** Coins Polymarket runs up/down markets on, in the socket's spelling. */
export const CHAINLINK_SYMBOLS = ['btc/usd', 'eth/usd', 'sol/usd', 'xrp/usd'] as const
/** Seconds of prices kept in memory (and read back from disk on start). */
const KEEP_SECONDS = 3 * 86400
/** Candles answered at most per read, as Coinbase does. */
export const CHAINLINK_PAGE = 300
const PING_MS = 5000
/** No price for this long means a dead socket. */
const SILENT_MS = 20_000

export interface ChainlinkCandle {
  time: number
  open: number
  high: number
  low: number
  close: number
  /** Prices in the candle (Chainlink has no volume): one a second when the feed is healthy. */
  volume: number
}

export interface ChainlinkCandlesReply {
  symbol: string
  candles: ChainlinkCandle[]
  /** The first second recorded, or null with nothing yet. */
  earliest: number | null
  /** The newest price's time in milliseconds, or null. */
  lastTick: number | null
  connected: boolean
}

/** One coin's prices, one a second at most, oldest first. */
export class PriceSeries {
  /** Seconds. */
  times: number[] = []
  values: number[] = []
  lastMs: number | null = null

  /** Adds a price; false when it is not newer than the last one. */
  add(ms: number, value: number): boolean {
    const t = Math.floor(ms / 1000)
    const last = this.times.length - 1
    if (last >= 0 && t < this.times[last]) return false
    if (last >= 0 && t === this.times[last]) {
      if (this.lastMs !== null && ms <= this.lastMs) return false
      this.values[last] = value
    } else {
      this.times.push(t)
      this.values.push(value)
    }
    this.lastMs = ms
    return true
  }

  /** Drops everything before `t`. */
  trim(t: number) {
    const i = this.indexFrom(t)
    if (i > 0) {
      this.times.splice(0, i)
      this.values.splice(0, i)
    }
  }

  get earliest(): number | null {
    return this.times.length ? this.times[0] : null
  }

  /** The first index at or after `t`. */
  indexFrom(t: number): number {
    let lo = 0
    let hi = this.times.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.times[mid] < t) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** Candles of `g` seconds whose open lies in [start, end], oldest first; empty buckets left out. */
  candles(g: number, start: number, end: number): ChainlinkCandle[] {
    const out: ChainlinkCandle[] = []
    const from = Math.floor(start / g) * g
    for (let i = this.indexFrom(from); i < this.times.length; i++) {
      const bucket = Math.floor(this.times[i] / g) * g
      if (bucket > end) break
      if (bucket < start) continue
      const v = this.values[i]
      const last = out[out.length - 1]
      if (last && last.time === bucket) {
        if (v > last.high) last.high = v
        if (v < last.low) last.low = v
        last.close = v
        last.volume++
      } else out.push({ time: bucket, open: v, high: v, low: v, close: v, volume: 1 })
    }
    return out
  }
}

const fileSymbol = (symbol: string) => symbol.replace('/', '-')
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10)

export interface RecorderOptions {
  /** Where the CSVs go; null keeps prices in memory only (tests). */
  dir: string | null
  symbols?: readonly string[]
  url?: string
  now?: () => number
  log?: (line: string) => void
}

/** Keeps one socket to Polymarket open and every price it sends. */
export class ChainlinkRecorder {
  readonly series = new Map<string, PriceSeries>()
  connected = false
  private ws: WebSocket | null = null
  private retry = 0
  private lastMessage = 0
  private timers: ReturnType<typeof setInterval>[] = []
  private stopped = true
  /** CSV lines waiting to be written, by file. */
  private pending = new Map<string, string[]>()
  private writing: Promise<void> = Promise.resolve()
  private readonly symbols: readonly string[]
  private readonly now: () => number

  constructor(private readonly opts: RecorderOptions) {
    this.symbols = opts.symbols ?? CHAINLINK_SYMBOLS
    this.now = opts.now ?? Date.now
    for (const s of this.symbols) this.series.set(s, new PriceSeries())
  }

  /** Reads back what earlier runs recorded, then connects. */
  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    await this.load().catch((error: unknown) => this.opts.log?.(`chainlink: could not read history: ${String(error)}`))
    this.connect()
    this.timers.push(
      setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('PING')
      }, PING_MS),
      setInterval(() => {
        if (this.ws && this.now() - this.lastMessage > SILENT_MS) this.ws.close()
      }, 5000),
      setInterval(() => void this.flush(), 2000),
      setInterval(() => {
        const cut = Math.floor(this.now() / 1000) - KEEP_SECONDS
        for (const s of this.series.values()) s.trim(cut)
      }, 600_000),
    )
  }

  stop() {
    this.stopped = true
    this.timers.forEach(clearInterval)
    this.timers = []
    const ws = this.ws
    this.ws = null
    ws?.close()
    this.connected = false
    void this.flush()
  }

  /** Folds in one socket message; also the way tests feed prices in. */
  ingest(text: string): number {
    let added = 0
    for (const tick of parseRtds(text)) {
      const s = this.series.get(tick.symbol)
      if (!s || !s.add(tick.ms, tick.value)) continue
      added++
      if (this.opts.dir) {
        const t = Math.floor(tick.ms / 1000)
        const file = join(this.opts.dir, fileSymbol(tick.symbol), `${day(t)}.csv`)
        const lines = this.pending.get(file) ?? []
        lines.push(`${tick.ms},${tick.value}\n`)
        this.pending.set(file, lines)
      }
    }
    return added
  }

  reply(symbol: string, g: number, start: number, end: number): ChainlinkCandlesReply {
    const s = this.series.get(symbol)
    if (!s) throw Object.assign(new Error(`No Chainlink feed for ${symbol}`), { status: 404 })
    // A page at most, the newest of the range, as Coinbase answers.
    const from = Math.max(start, end - (CHAINLINK_PAGE - 1) * g)
    return { symbol, candles: s.candles(g, from, end), earliest: s.earliest, lastTick: s.lastMs, connected: this.connected }
  }

  private connect() {
    if (this.stopped || this.ws) return
    let ws: WebSocket
    try {
      // Node's socket (undici) takes headers: an Origin, as Polymarket's own page sends.
      ws = new WebSocket(this.opts.url ?? RTDS_URL, { headers: { Origin: 'https://polymarket.com' } } as unknown as string[])
    } catch (error) {
      this.opts.log?.(`chainlink: ${String(error)}`)
      this.reconnectLater()
      return
    }
    this.ws = ws
    this.lastMessage = this.now()
    ws.onopen = () => {
      this.retry = 0
      this.connected = true
      // One subscription a coin: each filtered one also sends that coin's last minute.
      ws.send(
        JSON.stringify({
          action: 'subscribe',
          subscriptions: this.symbols.map((symbol) => ({ topic: 'crypto_prices_chainlink', type: '*', filters: JSON.stringify({ symbol }) })),
        }),
      )
    }
    ws.onmessage = (event) => {
      this.lastMessage = this.now()
      this.ingest(typeof event.data === 'string' ? event.data : String(event.data))
    }
    // Node's socket follows an error with a close by itself; closing it here again recurses.
    ws.onerror = () => {}
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.connected = false
      this.reconnectLater()
    }
  }

  private reconnectLater() {
    if (this.stopped) return
    setTimeout(() => this.connect(), Math.min(15_000, 500 * 2 ** this.retry++))
  }

  private flush(): Promise<void> {
    if (!this.pending.size) return this.writing
    const batch = this.pending
    this.pending = new Map()
    this.writing = this.writing.then(async () => {
      for (const [file, lines] of batch) {
        try {
          await mkdir(join(file, '..'), { recursive: true })
          await appendFile(file, lines.join(''))
        } catch (error) {
          this.opts.log?.(`chainlink: could not write ${file}: ${String(error)}`)
        }
      }
    })
    return this.writing
  }

  /** The last KEEP_SECONDS of earlier runs, out of the CSVs. */
  private async load() {
    const dir = this.opts.dir
    if (!dir) return
    const cut = Math.floor(this.now() / 1000) - KEEP_SECONDS
    const firstDay = day(cut)
    for (const [symbol, s] of this.series) {
      const folder = join(dir, fileSymbol(symbol))
      const files = (await readdir(folder).catch(() => [] as string[])).filter((f) => f.endsWith('.csv') && f.slice(0, 10) >= firstDay).sort()
      for (const f of files) {
        const text = await readFile(join(folder, f), 'utf8')
        for (const line of text.split('\n')) {
          const comma = line.indexOf(',')
          if (comma < 0) continue
          const ms = Number(line.slice(0, comma))
          const value = Number(line.slice(comma + 1))
          if (Number.isFinite(ms) && ms >= cut * 1000 && value > 0) s.add(ms, value)
        }
      }
    }
  }
}

export function createChainlinkApi(recorder: ChainlinkRecorder) {
  return {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== '/api/chainlink/candles') return false
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      const symbol = (url.searchParams.get('symbol') ?? '').toLowerCase()
      const g = Number(url.searchParams.get('granularity'))
      const start = Number(url.searchParams.get('start'))
      const end = Number(url.searchParams.get('end'))
      if (!(g >= 1) || !Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        send(400, { error: 'granularity, start and end (unix seconds) are required' })
        return true
      }
      try {
        send(200, recorder.reply(symbol, Math.floor(g), Math.floor(start), Math.floor(end)))
      } catch (error) {
        send((error as { status?: number }).status ?? 500, { error: error instanceof Error ? error.message : String(error) })
      }
      return true
    },
  }
}

/** Records Chainlink prices from the moment `npm run dev` (or preview) starts, and serves them. */
export function chainlinkPlugin(): Plugin {
  let recorder: ChainlinkRecorder | null = null
  const setup = (root: string, middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void }) => {
    recorder ??= new ChainlinkRecorder({ dir: join(root, '.chainlink'), log: (line) => console.warn(line) })
    void recorder.start()
    const api = createChainlinkApi(recorder)
    middlewares.use((req, res, next) => {
      void api.handle(req, res).then((handled) => !handled && next())
    })
  }
  return {
    name: 'cryptoanal-chainlink',
    configureServer(server) {
      // Vitest starts a dev server too: tests record nothing.
      if (process.env.VITEST) return
      setup(server.config.root, server.middlewares)
      server.httpServer?.once('close', () => recorder?.stop())
    },
    configurePreviewServer(server) {
      setup(server.config.root, server.middlewares)
    },
  }
}
