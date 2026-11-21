import { generateKeyPairSync, verify } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePositions, parseUsRound, PolyKeyStore, PolyUsEngine, readSecret, sideAvg, signedHeaders } from './polyUs'

const START = Date.parse('2026-11-18T21:40:00Z')
const SLUG = 'cpc-btc-updown-5m-2026-11-18-2140z'

const market = (extra: Record<string, unknown> = {}) => ({
  market: {
    slug: SLUG,
    active: true,
    closed: false,
    status: 'MARKET_STATUS_OPEN',
    orderPriceMinTickSize: 0.01,
    assetPriceTerms: {
      marketType: 'ASSET_PRICE_MARKET_TYPE_UP_DOWN',
      asset: { assetClass: 'ASSET_CLASS_CRYPTO', symbol: 'btc' },
      horizon: '5m',
      windowStart: '2026-11-18T21:40:00Z',
      windowEnd: '2026-11-18T21:45:00Z',
      priceToBeat: { value: '62296.11', currency: 'USD' },
    },
    ...extra,
  },
})

/** A Secret Key file as polymarket.us/developer gives it (base64; the first 32 bytes are the seed). */
function secretFile(dir: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)
  const path = join(dir, 'poly.key')
  writeFileSync(path, Buffer.concat([seed, publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)]).toString('base64'))
  return { path, publicKey }
}

describe('the key', () => {
  it('signs timestamp + method + path with the Secret Key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'polyus-'))
    const { path, publicKey } = secretFile(dir)
    const secret = readSecret(path)
    if (!('key' in secret)) throw new Error(secret.error)
    const headers = signedHeaders({ keyId: 'k-123', key: secret.key }, 'get', '/v1/portfolio/positions?market=x', 1_700_000_000_123)
    expect(headers['X-PM-Access-Key']).toBe('k-123')
    expect(headers['X-PM-Timestamp']).toBe('1700000000123')
    expect(verify(null, Buffer.from('1700000000123GET/v1/portfolio/positions'), publicKey, Buffer.from(headers['X-PM-Signature'], 'base64'))).toBe(true)
  })
  it('refuses a file that is not a Secret Key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'polyus-'))
    writeFileSync(join(dir, 'bad.key'), 'not a key!')
    expect(readSecret(join(dir, 'bad.key'))).toHaveProperty('error')
    expect(readSecret(join(dir, 'missing.key'))).toHaveProperty('error')
  })
})

describe('what Polymarket US answers', () => {
  it('reads a 5-minute BTC round, its price to beat and tick', () => {
    expect(parseUsRound(market())).toEqual({ slug: SLUG, start: START / 1000, end: START / 1000 + 300, strike: 62296.11, tick: 0.01, open: true, resolved: false })
    expect(parseUsRound(market({ assetPriceTerms: { ...market().market.assetPriceTerms, horizon: '15m' } }))).toBe(null)
  })
  it('reads short positions as Down', () => {
    expect([...parsePositions({ positions: { a: { netPositionDecimal: '12' }, b: { netPositionDecimal: '-3' }, c: { netPositionDecimal: '0' } } })]).toEqual([
      ['a', 12],
      ['b', -3],
    ])
  })
  it('turns a Yes average into the Down price', () => {
    expect(sideAvg('down', 0.34, 0.66)).toBe(0.66)
    expect(sideAvg('down', 0.66, 0.66)).toBe(0.66)
    expect(sideAvg('up', 0.4, 0.4)).toBe(0.4)
  })
})

/** A fake Polymarket US: answers by path, records every request. */
function fakeExchange(previewSide: (body: Record<string, unknown>) => string) {
  const calls: { method: string; path: string; body: Record<string, unknown> | null; signed: boolean }[] = []
  const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ method: init?.method ?? 'GET', path: u.pathname, body, signed: !!headers['X-PM-Signature'] })
    if (u.host === 'api.exchange.coinbase.com') return reply({ price: '62310.5' })
    if (u.pathname === `/v1/market/slug/${SLUG}`) return reply(market())
    if (u.pathname === `/v1/markets/${SLUG}/book`)
      return reply({
        marketData: {
          bids: [{ px: { value: '0.34', currency: 'USD' }, qty: '500' }],
          offers: [{ px: { value: '0.36', currency: 'USD' }, qty: '500' }],
        },
      })
    if (u.pathname === '/v1/portfolio/positions') return reply({ positions: {} })
    if (u.pathname === '/v1/account/balances') return reply({ balances: [{ currency: 'USD', buyingPower: 100 }] })
    if (u.pathname === '/v1/order/preview') {
      const request = body?.request as Record<string, unknown>
      return reply({ order: { side: previewSide(request), price: request.price } })
    }
    if (u.pathname === '/v1/orders') {
      const filled = body?.tif === 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL' ? body.quantity : 0
      return reply({
        id: `o${calls.length}`,
        executions: [{ type: 'EXECUTION_TYPE_FILL', order: { id: `o${calls.length}`, cumQuantity: filled, avgPx: { value: '0.34', currency: 'USD' }, state: 'ORDER_STATE_FILLED' } }],
      })
    }
    return reply({ message: 'not here' }, 404)
  }) as typeof fetch
  return { fetcher, calls }
}

async function engineWith(previewSide: (body: Record<string, unknown>) => string, live = true) {
  const dir = mkdtempSync(join(tmpdir(), 'polyus-'))
  const { path } = secretFile(dir)
  const keys = new PolyKeyStore(join(dir, 'polymarket-us.json'))
  await keys.save('0b9f1c2e-1111-2222-3333-444455556666', path)
  if (live) await keys.setLive(true)
  const exchange = fakeExchange(previewSide)
  const engine = new PolyUsEngine(keys, join(dir, 'plays.json'), exchange.fetcher, () => START + 60_000, () => undefined)
  return { engine, calls: exchange.calls }
}

const asMeant = (r: Record<string, unknown>) => (r.intent === 'ORDER_INTENT_BUY_LONG' || r.intent === 'ORDER_INTENT_SELL_SHORT' ? 'ORDER_SIDE_BUY' : 'ORDER_SIDE_SELL')

describe('buying for real', () => {
  it('buys Down as the Yes side sold, at the Yes price, and leaves the auto-sell on the book', async () => {
    const { engine, calls } = await engineWith(asMeant)
    const result = await engine.buy({ side: 'down', dollars: 15 })
    engine.close()
    expect(result.ok).toBe(true)
    const orders = calls.filter((c) => c.path === '/v1/orders')
    expect(orders.every((c) => c.signed)).toBe(true)
    // Down's ask is 66¢ (Yes bid 34¢); at most 2¢ over: 68¢ Down = Yes sold at 32¢ or better.
    expect(orders[0].body).toMatchObject({
      marketSlug: SLUG,
      type: 'ORDER_TYPE_LIMIT',
      intent: 'ORDER_INTENT_BUY_SHORT',
      price: { value: '0.32', currency: 'USD' },
      tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL',
    })
    expect(Number.isInteger(orders[0].body?.quantity)).toBe(true)
    // Filled at 66¢ Down: the most is 34¢ a contract, less 10% → 97¢ Down = Yes bought back at 3¢.
    expect(orders[1].body).toMatchObject({ intent: 'ORDER_INTENT_SELL_SHORT', price: { value: '0.03', currency: 'USD' }, tif: 'TIME_IN_FORCE_GOOD_TILL_CANCEL' })
    // Each kind was previewed before its first order went out.
    expect(calls.findIndex((c) => c.path === '/v1/order/preview')).toBeLessThan(calls.findIndex((c) => c.path === '/v1/orders'))
  })

  it('sends nothing when the preview reads the order another way', async () => {
    const { engine, calls } = await engineWith(() => 'ORDER_SIDE_BUY')
    await expect(engine.buy({ side: 'down', dollars: 15 })).rejects.toThrow(/Not sent/)
    engine.close()
    expect(calls.some((c) => c.path === '/v1/orders')).toBe(false)
  })

  it('sends nothing while real-money orders are off', async () => {
    const { engine, calls } = await engineWith(asMeant, false)
    await expect(engine.buy({ side: 'up', dollars: 15 })).rejects.toThrow(/off/)
    engine.close()
    expect(calls.some((c) => c.path === '/v1/orders' || c.path === '/v1/order/preview')).toBe(false)
  })
})
