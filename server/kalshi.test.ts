import { describe, expect, it } from 'vitest'
import { createKalshiApi, parseCurrent, parseHistory } from './kalshi'

const market = (open: string, close: string, strike: number, extra: Record<string, unknown> = {}) => ({
  ticker: `KXBTC15M-${open}`,
  open_time: open,
  close_time: close,
  floor_strike: strike,
  custom_strike: { round_digits: '2' },
  strike_type: 'greater_or_equal',
  ...extra,
})

const OPEN = {
  markets: [market('2026-10-27T18:15:00Z', '2026-10-27T18:30:00Z', 80517.644, { yes_bid_dollars: '0.61', yes_ask_dollars: '0.63' })],
}
const SETTLED = {
  markets: [
    market('2026-10-27T18:00:00Z', '2026-10-27T18:15:00Z', 80438.27, { expiration_value: 80517.64, result: 'yes' }),
    market('2026-10-27T17:45:00Z', '2026-10-27T18:00:00Z', 80595.78, { expiration_value: 80438.27, result: 'no' }),
    { ticker: 'broken', open_time: 'nope' },
  ],
}
const at = (iso: string) => Date.parse(iso) / 1000

describe('Kalshi pages', () => {
  it('finds the window running now, with its strike and Yes quotes', () => {
    const current = parseCurrent(OPEN, 2, at('2026-10-27T18:20:00Z'))
    expect(current).toMatchObject({ start: at('2026-10-27T18:15:00Z'), strike: 80517.64, yesBid: 0.61, yesAsk: 0.63, tieGoesUp: true })
    expect(parseCurrent(OPEN, 2, at('2026-10-27T18:30:00Z'))).toBeNull()
  })

  it('reads settled windows oldest first and skips broken rows', () => {
    const history = parseHistory(SETTLED, 2)
    expect(history.map((w) => [w.strike, w.settle, w.result])).toEqual([
      [80595.78, 80438.27, 'no'],
      [80438.27, 80517.64, 'yes'],
    ])
  })
})

describe('Kalshi proxy', () => {
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  it('falls back to the second host and caches', async () => {
    const calls: string[] = []
    const fetcher = (async (url: string) => {
      calls.push(url)
      if (url.startsWith('https://external-api')) return reply({}, 503)
      return reply(url.includes('status=open') ? OPEN : SETTLED)
    }) as unknown as typeof fetch
    const api = createKalshiApi(fetcher, () => Date.parse('2026-10-27T18:20:00Z'))
    const first = await api.strikeFor('BTC-USD')
    expect(first.current?.strike).toBe(80517.64)
    expect(first.history).toHaveLength(2)
    expect(calls.filter((u) => u.startsWith('https://api.elections'))).toHaveLength(2)
    await api.strikeFor('BTC-USD')
    expect(calls).toHaveLength(4)
  })

  it('refuses coins Kalshi has no 15-minute market on', async () => {
    const api = createKalshiApi((async () => reply(OPEN)) as unknown as typeof fetch)
    await expect(api.strikeFor('ADA-USD')).rejects.toThrow('no 15-minute market')
  })
})
