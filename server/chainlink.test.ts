import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChainlinkRecorder, createChainlinkApi, parseRtds, PriceSeries } from './chainlink'

// Shaped as Polymarket sent them on 2026-11-09.
const snapshot = (symbol: string, points: [number, number][]) =>
  JSON.stringify({ payload: { data: points.map(([timestamp, value]) => ({ timestamp, value })), symbol }, timestamp: points.at(-1)![0], topic: 'crypto_prices', type: 'subscribe' })
const update = (symbol: string, timestamp: number, value: number) =>
  JSON.stringify({
    connection_id: 'ggIxyc49DWeIKEhcSA==',
    payload: { full_accuracy_value: String(BigInt(Math.round(value * 1e6)) * 10n ** 12n), symbol, timestamp, value },
    timestamp: timestamp + 900,
    topic: 'crypto_prices_chainlink',
    type: 'update',
  })

describe('parseRtds', () => {
  it('reads an update and a subscription’s minute', () => {
    expect(parseRtds(update('btc/usd', 1794184200000, 74943.12169612426))).toEqual([{ symbol: 'btc/usd', ms: 1794184200000, value: 74943.12169612426 }])
    const ticks = parseRtds(snapshot('eth/usd', [[1794184162000, 2138.85], [1794184163000, 2138.9]]))
    expect(ticks.map((t) => t.ms)).toEqual([1794184162000, 1794184163000])
    expect(ticks[0].symbol).toBe('eth/usd')
  })
  it('ignores blanks, PONG, other topics and junk', () => {
    expect(parseRtds('')).toEqual([])
    expect(parseRtds('PONG')).toEqual([])
    expect(parseRtds('{"topic":"comments","payload":{"symbol":"btc/usd","value":1,"timestamp":1}}')).toEqual([])
    expect(parseRtds('{"topic":"crypto_prices","type":"update","payload":{"symbol":"btcusdt","value":1,"timestamp":1}}')).toEqual([])
    expect(parseRtds('{not json')).toEqual([])
  })
})

describe('PriceSeries', () => {
  it('keeps one price a second, newest wins, nothing older', () => {
    const s = new PriceSeries()
    expect(s.add(10_000, 1)).toBe(true)
    expect(s.add(10_500, 2)).toBe(true)
    expect(s.add(10_400, 3)).toBe(false)
    expect(s.add(9_000, 4)).toBe(false)
    expect(s.add(11_000, 5)).toBe(true)
    expect(s.times).toEqual([10, 11])
    expect(s.values).toEqual([2, 5])
  })
  it('builds candles of any size, leaving empty ones out', () => {
    const s = new PriceSeries()
    for (const [t, v] of [[60, 5], [61, 7], [90, 3], [119, 4], [240, 9]]) s.add(t * 1000, v)
    expect(s.candles(60, 0, 1000)).toEqual([
      { time: 60, open: 5, high: 7, low: 3, close: 4, volume: 4 },
      { time: 240, open: 9, high: 9, low: 9, close: 9, volume: 1 },
    ])
    expect(s.candles(60, 120, 1000).map((c) => c.time)).toEqual([240])
    expect(s.candles(1, 61, 90).map((c) => c.time)).toEqual([61, 90])
  })
})

describe('ChainlinkRecorder', () => {
  it('answers the newest page of a range and what it holds', () => {
    const r = new ChainlinkRecorder({ dir: null })
    r.ingest(snapshot('btc/usd', [[1000_000, 1], [1001_000, 2]]))
    for (let t = 1002; t < 1400; t++) r.ingest(update('btc/usd', t * 1000, t))
    const reply = r.reply('btc/usd', 1, 0, 1399)
    expect(reply.candles.map((c) => c.time)).toEqual(Array.from({ length: 300 }, (_, k) => 1100 + k))
    // Asked past the newest price: the page is the range's end, empty.
    expect(r.reply('btc/usd', 1, 0, 2000).candles).toEqual([])
    expect(reply.earliest).toBe(1000)
    expect(reply.lastTick).toBe(1399_000)
    expect(r.reply('btc/usd', 60, 0, 2000).candles.map((c) => c.time)).toEqual([960, 1020, 1080, 1140, 1200, 1260, 1320, 1380])
    expect(() => r.reply('doge/usd', 60, 0, 1)).toThrow()
  })

  it('writes prices to disk and reads them back on start', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chainlink-'))
    try {
      const now = 1794184300_000
      const a = new ChainlinkRecorder({ dir, now: () => now, url: 'ws://127.0.0.1:9' })
      a.ingest(update('btc/usd', now - 2000, 100))
      a.ingest(update('btc/usd', now - 1000, 101))
      a.stop()
      await new Promise((r) => setTimeout(r, 50))
      expect(await readFile(join(dir, 'btc-usd', '2026-11-09.csv'), 'utf8')).toBe(`${now - 2000},100\n${now - 1000},101\n`)
      const b = new ChainlinkRecorder({ dir, now: () => now, url: 'ws://127.0.0.1:9' })
      await b.start()
      b.stop()
      expect(b.series.get('btc/usd')!.values).toEqual([100, 101])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('serves /api/chainlink/candles', async () => {
    const r = new ChainlinkRecorder({ dir: null })
    r.ingest(update('btc/usd', 60_000, 5))
    const api = createChainlinkApi(r)
    const call = async (url: string) => {
      let status = 0
      let body = ''
      const res = { writeHead: (s: number) => (status = s), end: (b: string) => (body = b) }
      const handled = await api.handle({ url } as never, res as never)
      return { handled, status, body: body ? JSON.parse(body) : null }
    }
    expect((await call('/api/other')).handled).toBe(false)
    const ok = await call('/api/chainlink/candles?symbol=BTC/USD&granularity=60&start=0&end=120')
    expect(ok.status).toBe(200)
    expect(ok.body.candles).toEqual([{ time: 60, open: 5, high: 5, low: 5, close: 5, volume: 1 }])
    expect((await call('/api/chainlink/candles?symbol=btc/usd')).status).toBe(400)
    expect((await call('/api/chainlink/candles?symbol=x/y&granularity=60&start=0&end=1')).status).toBe(404)
  })
})
