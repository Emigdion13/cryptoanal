import { describe, expect, it } from 'vitest'
import { createPolymarketApi, cryptoPriceUrl, parseHistory, parseRound } from './polymarket'

const at = (iso: string) => Date.parse(iso) / 1000
const START = '2026-11-06T11:30:00Z'
const END = '2026-11-06T11:35:00Z'
const SLUG = `btc-updown-5m-${at(START)}`

const market = (start: string, end: string, extra: Record<string, unknown> = {}) => ({
  slug: `btc-updown-5m-${at(start)}`,
  eventStartTime: start,
  endDate: end,
  outcomes: '["Up", "Down"]',
  clobTokenIds: '["111", "222"]',
  cryptoMarketConfig: { asset: 'btc', duration: '5m', twapEnabled: true, twapLookbackSeconds: 60 },
  ...extra,
})
const LIVE = [{ slug: SLUG, eventMetadata: null, markets: [market(START, END)] }]
const CLOSED = [
  { slug: 'b', eventMetadata: { priceToBeat: 75992.08, finalPrice: 75993.3 }, markets: [market('2026-11-06T11:25:00Z', START)] },
  { slug: 'a', eventMetadata: { priceToBeat: 75910.53, finalPrice: 75992.08 }, markets: [market('2026-11-06T11:20:00Z', '2026-11-06T11:25:00Z')] },
  // Closed, its numbers not out yet.
  { slug: 'c', eventMetadata: null, markets: [market('2026-11-06T11:15:00Z', '2026-11-06T11:20:00Z')] },
]
const ROUND = { slug: SLUG, start: at(START), end: at(END), upToken: '111', twapSeconds: 60 }

describe('Polymarket pages', () => {
  it('reads a round, with its TWAP settings and the Up token', () => {
    expect(parseRound(LIVE)).toEqual(ROUND)
    // Whichever way round Gamma lists the outcomes.
    const flipped = [{ markets: [market(START, END, { outcomes: '["Down", "Up"]' })] }]
    expect(parseRound(flipped)?.upToken).toBe('222')
    const spot = [{ markets: [market(START, END, { cryptoMarketConfig: { twapEnabled: false } })] }]
    expect(parseRound(spot)?.twapSeconds).toBeNull()
  })

  it('takes no round without its price settings, or that is not 5 minutes', () => {
    expect(parseRound([{ markets: [market(START, END, { cryptoMarketConfig: undefined })] }])).toBeNull()
    expect(parseRound([{ markets: [market(START, END, { cryptoMarketConfig: { twapEnabled: true } })] }])).toBeNull()
    expect(parseRound([{ markets: [market(START, '2026-11-06T11:45:00Z')] }])).toBeNull()
    expect(parseRound([])).toBeNull()
    expect(parseRound({ error: 'nope' })).toBeNull()
  })

  it('asks crypto-price for the TWAP, not the spot price', () => {
    const url = new URL(cryptoPriceUrl('BTC', ROUND))
    expect(url.searchParams.get('twapEnabled')).toBe('true')
    expect(url.searchParams.get('twapLookbackSeconds')).toBe('60')
    expect(new Date(url.searchParams.get('eventStartTime')!).getTime() / 1000).toBe(at(START))
    expect(new URL(cryptoPriceUrl('BTC', { ...ROUND, twapSeconds: null })).searchParams.has('twapEnabled')).toBe(false)
  })

  it('reads past windows oldest first and skips those without a strike', () => {
    expect(parseHistory(CLOSED).map((w) => [w.slug, w.strike])).toEqual([
      ['a', 75910.53],
      ['b', 75992.08],
    ])
    expect(parseHistory('nope')).toEqual([])
  })
})

describe('Polymarket proxy', () => {
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  const setup = (over: { price?: () => Response; gamma?: () => Response; mid?: () => Response } = {}) => {
    const calls: string[] = []
    let clock = Date.parse('2026-11-06T11:31:00Z')
    const fetcher = (async (url: string) => {
      calls.push(url)
      if (url.includes('series_slug=')) return reply(CLOSED)
      if (url.includes('/events?slug=')) return over.gamma?.() ?? reply(LIVE)
      if (url.includes('/crypto-price')) return over.price?.() ?? reply({ openPrice: 75993.3, closePrice: null })
      if (url.includes('/midpoint')) return over.mid?.() ?? reply({ mid: '0.57' })
      return reply([])
    }) as unknown as typeof fetch
    return { api: createPolymarketApi(fetcher, () => clock), calls, advance: (ms: number) => (clock += ms) }
  }

  it('answers the running window with its strike and Up price', async () => {
    const { api } = setup()
    const out = await api.strikeFor('BTC-USD')
    expect(out.current).toEqual({ slug: SLUG, start: at(START), end: at(END), strike: 75993.3, upPrice: 0.57 })
    expect(out.history).toHaveLength(2)
    // Coinbase's answer here is no candles: the strike still comes, unmoved.
    expect(out.basis).toBeNull()
  })

  it('reads a published strike once, and keeps asking until it is published', async () => {
    let open: number | null = null
    const { api, calls, advance } = setup({ price: () => reply({ openPrice: open, closePrice: null }) })
    const waiting = await api.strikeFor('BTC-USD')
    expect(waiting.current).toBeNull()
    expect(waiting.message).toMatch(/not published/)
    open = 75993.3
    advance(2000)
    expect((await api.strikeFor('BTC-USD')).current?.strike).toBe(75993.3)
    const reads = calls.filter((u) => u.includes('/crypto-price')).length
    expect(reads).toBe(2)
    advance(5000)
    await api.strikeFor('BTC-USD')
    expect(calls.filter((u) => u.includes('/crypto-price'))).toHaveLength(reads)
  })

  it('shows the strike without the Up price when the book does not answer', async () => {
    const { api } = setup({ mid: () => reply({}, 503) })
    expect((await api.strikeFor('BTC-USD')).current).toMatchObject({ strike: 75993.3, upPrice: null })
  })

  it('draws nothing for a round whose settings it cannot read', async () => {
    const { api, calls } = setup({ gamma: () => reply([{ markets: [market(START, END, { cryptoMarketConfig: undefined })] }]) })
    expect((await api.strikeFor('BTC-USD')).current).toBeNull()
    expect(calls.some((u) => u.includes('/crypto-price'))).toBe(false)
  })

  it('keeps past windows and reports the problem when the live read fails', async () => {
    const { api } = setup({ price: () => reply({}, 500) })
    const out = await api.strikeFor('BTC-USD')
    expect(out.current).toBeNull()
    expect(out.history).toHaveLength(2)
    expect(out.message).toBe('Polymarket answered 500')
  })

  it('refuses other coins', async () => {
    const { api } = setup()
    await expect(api.strikeFor('ETH-USD')).rejects.toThrow('Bitcoin only')
  })

  it('reads the next round’s event when the window rolls over', async () => {
    const { api, calls, advance } = setup()
    await api.strikeFor('BTC-USD')
    advance(301_000)
    await api.strikeFor('BTC-USD')
    expect(calls.filter((u) => u.includes('/events?slug=')).map((u) => u.split('-').pop())).toEqual([String(at(START)), String(at(START) + 300)])
  })
})
