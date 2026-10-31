/**
 * `/api/trade/*`: the quick-trade circles' routes, and the computer's Kalshi trading settings.
 *
 * Money moves only for this computer's own browser (loopback, a local Host, the app's Origin and
 * header) or a signed-in phone through Tailscale (server/phone.ts checks the session, the page's
 * origin and header). A phone may read and trade; keys and the real-money switch stay on the computer.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import type { Plugin } from 'vite'
import { isEnv, type TradeEnv } from '../../src/trade/kalshiTrade'
import { Lab } from '../lab/lab'
import { PhoneAccess, PhoneError, guardLocal, readJson } from '../phone'
import { workspaceFile } from '../workspace'
import { TradeEngine } from './engine'
import { TradeError } from './kalshi'
import { KalshiKeyStore, KeyError } from './keys'

/** What a signed-in phone may use (the ones that change something are in server/phone.ts PHONE_WRITES too). */
export const PHONE_ROUTES = new Set(['state', 'stream', 'history', 'buy', 'sell-now', 'target', 'target/cancel', 'auto-sell', 'arm', 'disarm'])
/** How often the stream pushes at most, ms: a busy book moves many times a second. */
const PUSH_MS = 120

export function createTradeApi(
  dir = dirname(workspaceFile()),
  phone = new PhoneAccess(join(dir, 'phone.json')),
  engine = new TradeEngine(new KalshiKeyStore(join(dir, 'kalshi.json')), join(dir, 'kalshi-targets.json')),
  log: (line: string) => void = (line) => console.log(line),
  /** The paper-trading lab (server/lab), recording while the server runs. */
  lab: Lab | null = null,
) {
  const json = (res: ServerResponse, status: number, value: unknown) => {
    if (res.destroyed || res.writableEnded) return
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    res.end(JSON.stringify(value))
  }

  const envOf = (value: unknown): TradeEnv => {
    if (!isEnv(value)) throw new TradeError(400, 'Choose demo or live.', 'BAD_ENV')
    return value
  }

  /** Server-sent events: the state now, then again whenever Kalshi says something changed. */
  const stream = async (req: IncomingMessage, res: ServerResponse, env: TradeEnv, product: string) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' })
    res.flushHeaders()
    let timer: ReturnType<typeof setTimeout> | null = null
    let last = 0
    const send = () => {
      timer = null
      last = Date.now()
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(engine.snapshot(env, product))}\n\n`)
    }
    const schedule = () => {
      if (!timer) timer = setTimeout(send, Math.max(0, PUSH_MS - (Date.now() - last)))
    }
    const off = engine.subscribe((changed) => changed === env && schedule())
    // Keeps the coin watched while the phone looks, and the countdown moving when the book is quiet.
    const keep = setInterval(() => {
      void engine.watch(env, product)
      schedule()
    }, 5_000)
    req.on('close', () => {
      off()
      clearInterval(keep)
      if (timer) clearTimeout(timer)
    })
    await engine.watch(env, product)
    send()
  }

  const settings = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'POST') {
      const body = await readJson(req)
      const store = new KalshiKeyStore(engine.keysView.file)
      if (body.save && typeof body.save === 'object') {
        const save = body.save as Record<string, unknown>
        const env = envOf(save.env)
        await store.saveKey(env, save.keyId, save.path)
        log(`[trade] ${env} key saved`)
      }
      if (body.clear !== undefined) {
        const env = envOf(body.clear)
        await store.clearKey(env)
        log(`[trade] ${env} key removed`)
      }
      if (typeof body.liveTrading === 'boolean') {
        await store.setLiveTrading(body.liveTrading)
        log(`[trade] real-money orders ${body.liveTrading ? 'ON' : 'off'}`)
      }
      engine.reloadKeys()
    } else if (req.method !== 'GET') throw new TradeError(405, 'Use GET or POST.', 'METHOD')
    json(res, 200, engine.keysView)
  }

  const dispatch = async (req: IncomingMessage, res: ServerResponse, route: string) => {
    if (phone.phoneHost(req) !== null) {
      phone.guard(req)
      if (!PHONE_ROUTES.has(route)) throw new TradeError(403, 'Change that on the computer.', 'LOCAL_ONLY')
    } else guardLocal(req)
    if (route === 'settings') return settings(req, res)
    if (route === 'state' || route === 'stream' || route === 'history') {
      if (req.method !== 'GET') throw new TradeError(405, 'Use GET.', 'METHOD')
      const url = new URL(req.url ?? '/', 'http://trade.internal')
      const env = envOf(url.searchParams.get('env'))
      const product = url.searchParams.get('product') ?? 'BTC-USD'
      if (route === 'stream') return stream(req, res, env, product)
      if (route === 'history') return json(res, 200, await engine.history(env, url.searchParams.get('from')))
      await engine.watch(env, product)
      return json(res, 200, engine.snapshot(env, product))
    }
    if (req.method !== 'POST') throw new TradeError(405, 'Use POST.', 'METHOD')
    const body = await readJson(req)
    const env = envOf(body.env)
    const who = phone.phoneHost(req) ? 'phone' : 'computer'
    log(`[trade] ${env} ${route} from the ${who}`)
    if (route === 'buy') return json(res, 200, await engine.buy(env, body))
    if (route === 'sell-now') return json(res, 200, await engine.sellNow(env, body))
    if (route === 'target') return json(res, 200, await engine.setTarget(env, body))
    if (route === 'target/cancel') return json(res, 200, await engine.cancelTarget(env, body))
    if (route === 'auto-sell') return json(res, 200, await engine.setAutoSell(env, body))
    if (route === 'arm') return json(res, 200, await engine.arm(env, body))
    if (route === 'disarm') return json(res, 200, await engine.disarm(env, body))
    throw new TradeError(404, 'Not found.', 'NOT_FOUND')
  }

  /** `/api/lab/*`: paper trading, for this computer only (never a phone). */
  const labDispatch = async (req: IncomingMessage, res: ServerResponse, route: string) => {
    if (phone.phoneHost(req) !== null) throw new TradeError(403, 'The lab is for this computer.', 'LOCAL_ONLY')
    if (!lab) throw new TradeError(404, 'The lab is not running.', 'NOT_FOUND')
    await lab.handle(req, res, route)
  }

  lab?.start()

  return {
    engine,
    lab,
    close: () => {
      lab?.close()
      engine.close()
    },
    /** True when the request was answered here. */
    handle(req: IncomingMessage, res: ServerResponse): boolean {
      const path = req.url?.split('?')[0] ?? ''
      const isLab = path.startsWith('/api/lab/')
      if (!path.startsWith('/api/trade/') && !isLab) return false
      const run = isLab ? labDispatch(req, res, path.slice('/api/lab/'.length)) : dispatch(req, res, path.slice('/api/trade/'.length))
      void run.catch((error: unknown) => {
        const e =
          error instanceof TradeError
            ? error
            : error instanceof PhoneError || error instanceof KeyError
              ? new TradeError(error.status, error.message, error instanceof PhoneError ? error.code : 'BAD_KEY')
              : new TradeError(500, 'The trade request failed.')
        if (e.status >= 500 && !(error instanceof TradeError)) log(`[trade] ${error instanceof Error ? error.stack : String(error)}`)
        json(res, e.status, { ok: false, error: e.code, message: e.message })
      })
      return true
    },
  }
}

/** The trading engine for `npm run dev` and `npm run preview`, behind the phone gate. */
export function tradePlugin(): Plugin {
  let api: ReturnType<typeof createTradeApi> | null = null
  const use = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!api) {
      const dir = dirname(workspaceFile())
      const engine = new TradeEngine(new KalshiKeyStore(join(dir, 'kalshi.json')), join(dir, 'kalshi-targets.json'))
      api = createTradeApi(dir, undefined, engine, undefined, new Lab(engine, join(dir, 'lab')))
    }
    if (!api.handle(req, res)) next()
  }
  const stop = () => {
    api?.close()
    api = null
  }
  return {
    name: 'cryptoanal-trade',
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
