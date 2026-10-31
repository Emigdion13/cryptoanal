/**
 * Replays: a past round played again blind, minute by minute. The trader sees what was known at
 * each minute (no date, no result, nothing later) and buys, sells or waits with a reason; the
 * round's result and its whole path show only once it is over. Every decision goes to the journal
 * as a replay, and replays.json keeps the score.
 */
import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isOutcome, TAKER_FEE, type TradeOutcome } from '../../src/trade/kalshiTrade'
import { Moment } from './moment'
import { fillBuy, fillSell } from './paper'
import type { Past, Scene } from './past'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const money = (value: number) => Math.round(value * 10_000) / 10_000

interface Holding {
  side: TradeOutcome
  contracts: number
  cost: number
  received: number
  fees: number
}

interface Session {
  id: string
  scene: Scene
  minute: number
  holding: Holding | null
  /** Dollars out and in over the whole round (a sale and a new buy both count). */
  spent: number
  received: number
  fees: number
  decisions: { minute: number; action: string; side?: TradeOutcome; contracts?: number; cents?: number; reason: string }[]
}

interface Score {
  rounds: number
  traded: number
  won: number
  pnl: number
  fees: number
  played: string[]
}

export class ReplayError extends Error {}

export class Replays {
  private sessions = new Map<string, Session>()

  constructor(
    private readonly past: Past,
    private readonly dir: string,
    private readonly journal: (entry: Record<string, unknown>) => Promise<void>,
  ) {}

  private async score(): Promise<Score> {
    try {
      return JSON.parse(await readFile(join(this.dir, 'replays.json'), 'utf8')) as Score
    } catch {
      return { rounds: 0, traded: 0, won: 0, pnl: 0, fees: 0, played: [] }
    }
  }

  private async saveScore(score: Score) {
    const file = join(this.dir, 'replays.json')
    await writeFile(`${file}.tmp`, `${JSON.stringify(score, null, 1)}\n`)
    await rename(`${file}.tmp`, file)
  }

  /** A round not played before, picked at random from the prepared days. */
  async start(product: string, days: readonly string[]) {
    const ready = this.past.ready(product, days)
    if (!ready.length) throw new ReplayError('No prepared rounds for that yet: prepare the past first (lab_prepare), it takes a few minutes.')
    const played = new Set((await this.score()).played)
    // A random day, then a round of it not played before (a few days tried before replaying one).
    let pool: Scene[] = []
    for (let tries = 0; tries < 8 && !pool.length; tries++) {
      const scenes = (await this.past.dayScenes(product, ready[Math.floor(Math.random() * ready.length)])).filter(
        (s) => s.round.result && s.round.strike !== null && s.closes.size > 60,
      )
      pool = scenes.filter((s) => !played.has(s.round.ticker))
      if (!pool.length && tries === 7) pool = scenes
    }
    if (!pool.length) throw new ReplayError('No playable round found in those days.')
    const scene = pool[Math.floor(Math.random() * pool.length)]
    const session: Session = { id: randomUUID().slice(0, 8), scene, minute: 1, holding: null, spent: 0, received: 0, fees: 0, decisions: [] }
    this.sessions.set(session.id, session)
    const open = new Date(scene.round.open * 1000)
    const m = new Moment(scene, 1)
    const path = Array.from({ length: 13 }, (_, k) => m.price(60 - 5 * k)).concat(m.price(0))
    return {
      id: session.id,
      round: {
        product,
        // No date: only what matters for how markets move then.
        when: `${WEEKDAYS[open.getUTCDay()]}, opened ${open.toISOString().slice(11, 16)} UTC`,
        strike: scene.round.strike,
        roundsBefore: scene.before.slice(0, 8),
        pricePath: { note: 'Coinbase closes every 5 minutes for the last hour, oldest first, then now', closes: path },
      },
      screen: this.screen(session),
    }
  }

  private screen(s: Session) {
    const m = new Moment(s.scene, s.minute)
    const recent = Array.from({ length: 10 }, (_, k) => m.price(9 - k))
    const holding = s.holding
    const bid = holding ? (holding.side === 'up' ? m.kalshi.upBid : m.kalshi.upAsk === null ? null : 1000 - m.kalshi.upAsk) : null
    return {
      ...m.view(),
      last10Closes: recent,
      holding: holding
        ? {
            side: holding.side,
            contracts: holding.contracts,
            cost: holding.cost,
            avgPaidCents: Math.round(((holding.cost - holding.fees) / holding.contracts) * 1000) / 10,
            bidCents: bid === null ? null : bid / 10,
            worthNow: bid === null ? null : money((holding.contracts * bid) / 1000),
          }
        : null,
      roundSoFar: { spent: s.spent, received: s.received },
      next: s.minute < 14 ? 'buy, sell or wait' : 'last minute: buy, sell or wait for the result',
    }
  }

  private session(id: unknown): Session {
    const s = typeof id === 'string' ? this.sessions.get(id) : undefined
    if (!s) throw new ReplayError('No such replay running (they last as long as this tool server).')
    return s
  }

  async step(raw: Record<string, unknown>) {
    const s = this.session(raw.id)
    const action = String(raw.action ?? 'wait')
    const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, 2000) : ''
    const m = new Moment(s.scene, s.minute)
    let message = ''
    if (action === 'buy') {
      const side = raw.outcome ?? raw.side
      if (!isOutcome(side)) throw new ReplayError('Buy up or down.')
      if (reason.length < 3) throw new ReplayError('Give the reason: it is how the journal teaches.')
      if (s.holding && s.holding.side !== side) throw new ReplayError(`You hold ${s.holding.side}: sell it first.`)
      const dollars = Number(raw.dollars)
      if (!(dollars >= 1 && dollars <= 100)) throw new ReplayError('Buy $1 to $100 (past fills know only the best price).')
      const ask = side === 'up' ? m.kalshi.upAsk : m.kalshi.upBid === null ? null : 1000 - m.kalshi.upBid
      if (ask === null || ask >= 1000) throw new ReplayError(`Nobody sold ${side} that minute.`)
      const fill = fillBuy([{ mills: ask, size: 1e9 }], dollars, ask, TAKER_FEE)
      if (!fill.count) throw new ReplayError('That buys no contract.')
      const cost = money(fill.value + fill.fee)
      s.holding ??= { side, contracts: 0, cost: 0, received: 0, fees: 0 }
      s.holding.contracts += fill.count
      s.holding.cost = money(s.holding.cost + cost)
      s.holding.fees = money(s.holding.fees + fill.fee)
      s.spent = money(s.spent + cost)
      s.fees = money(s.fees + fill.fee)
      s.decisions.push({ minute: s.minute, action, side, contracts: fill.count, cents: ask / 10, reason })
      message = `Bought ${fill.count} ${side} at ${ask / 10}¢ ($${cost.toFixed(2)} with $${fill.fee.toFixed(2)} fee).`
      await this.journal({ kind: 'replay-buy', replay: s.id, product: s.scene.round.product, outcome: side, contracts: fill.count, cents: ask / 10, cost, reason, context: m.view() })
    } else if (action === 'sell') {
      if (!s.holding) throw new ReplayError('Nothing held.')
      if (reason.length < 3) throw new ReplayError('Give the reason: it is how the journal teaches.')
      const bid = s.holding.side === 'up' ? m.kalshi.upBid : m.kalshi.upAsk === null ? null : 1000 - m.kalshi.upAsk
      if (bid === null) throw new ReplayError(`Nobody bought ${s.holding.side} that minute.`)
      const fill = fillSell([{ mills: bid, size: 1e9 }], s.holding.contracts, bid, TAKER_FEE)
      const proceeds = money(fill.value - fill.fee)
      s.received = money(s.received + proceeds)
      s.fees = money(s.fees + fill.fee)
      s.decisions.push({ minute: s.minute, action, side: s.holding.side, contracts: fill.count, cents: bid / 10, reason })
      message = `Sold ${fill.count} ${s.holding.side} at ${bid / 10}¢ ($${proceeds.toFixed(2)} after $${fill.fee.toFixed(2)} fee).`
      await this.journal({ kind: 'replay-sell', replay: s.id, product: s.scene.round.product, outcome: s.holding.side, contracts: fill.count, cents: bid / 10, proceeds, reason, context: m.view() })
      s.holding = null
    } else if (action === 'wait') {
      if (reason) s.decisions.push({ minute: s.minute, action, reason })
    } else throw new ReplayError('The action is buy, sell or wait.')

    const wait = action === 'wait' ? Math.max(1, Math.min(14, Math.round(Number(raw.minutes) || 1))) : 1
    s.minute += wait
    if (s.minute <= 14) return { message, screen: this.screen(s) }
    return { message, ...(await this.finish(s)) }
  }

  private async finish(s: Session) {
    this.sessions.delete(s.id)
    const { round } = s.scene
    const held = s.holding
    const payout = held && held.side === round.result ? held.contracts : 0
    const received = money(s.received + payout)
    const pnl = money(received - s.spent)
    const traded = s.decisions.some((d) => d.action === 'buy')
    const score = await this.score()
    score.rounds += 1
    score.played = [...score.played.slice(-5000), round.ticker]
    if (traded) {
      score.traded += 1
      if (pnl > 0) score.won += 1
      score.pnl = money(score.pnl + pnl)
      score.fees = money(score.fees + s.fees)
    }
    await this.saveScore(score)
    await this.journal({ kind: 'replay-round', replay: s.id, product: round.product, ticker: round.ticker, result: round.result, strike: round.strike, settle: round.settle, decisions: s.decisions, spent: s.spent, received, fees: s.fees, pnl })
    return {
      over: true,
      result: round.result,
      settledAt: round.settle,
      strike: round.strike,
      ticker: round.ticker,
      date: new Date(round.close * 1000).toISOString(),
      yourRound: traded ? { spent: s.spent, received, fees: s.fees, pnl, heldToEnd: held ? `${held.contracts} ${held.side}` : null } : 'no trade',
      path: round.minutes.map((m, k) => {
        const moment = new Moment(s.scene, k + 1 <= 14 ? k + 1 : 14)
        return { minute: k + 1, price: k + 1 <= 14 ? moment.price() : null, upBid: m.upBid === null ? null : m.upBid / 10, upAsk: m.upAsk === null ? null : m.upAsk / 10 }
      }),
      score: { rounds: score.rounds, traded: score.traded, won: score.won, pnl: score.pnl, fees: score.fees },
      next: 'Write what this round taught (lab_note), then start another.',
    }
  }
}
