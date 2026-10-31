/**
 * The trading lab: paper trading on Kalshi's REAL 15-minute markets, for an AI (Claude now, a
 * local model later) to practice, keep a journal and learn from it. Nothing here sends an order.
 *
 * - The recorder follows each coin's running round on the LIVE exchange (the trade engine's book):
 *   every SAMPLE_MS the coin's price and the Up/Down prices; every minute the desktop's indicator
 *   calls; at the end, the result. One line per round in rounds/<coin>/<day>.jsonl.
 * - The paper account fills orders against that book, level by level, with Kalshi's fees, and
 *   settles at Kalshi's result. Every order carries the trader's reason, written to journal.jsonl
 *   with what the market looked like then, and every round's result follows it.
 * - PLAYBOOK.md is what was learned, in words: rules, setups, mistakes to avoid.
 *
 * All of it lives in ~/.cryptoanal/lab, plain files any model can read.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { isOutcome, TAKER_FEE, type TradeMarket, type TradeOutcome } from '../../src/trade/kalshiTrade'
import { KALSHI_SERIES } from '../kalshi'
import { guardLocal, readJson } from '../phone'
import type { TradeEngine } from '../trade/engine'
import { KalshiRest, TradeError } from '../trade/kalshi'
import { workspaceFile } from '../workspace'
import { computeFeatures, desktopIndicators, type Features } from './features'
import { asksFor, bidsFor, fillBuy, fillSell, type Fill } from './paper'

/** How often a round's prices are written down, ms. */
const SAMPLE_MS = 15_000
/** A minute's indicator calls are read this long after it closes, ms (Coinbase needs a moment). */
const FEATURE_DELAY_MS = 3_000
/** A finished round's result is asked for this often, and given up on after this long. */
const RESULT_RETRY_MS = 15_000
const RESULT_GIVE_UP_MS = 45 * 60_000
/** Asked of the live book before buying: never more than this over the best ask, mills. */
const PAPER_SLIPPAGE_MILLS = 20

interface LabConfig {
  /** Coins whose rounds are recorded and paper-traded. */
  products: string[]
  /** The desktop chart whose indicators are read. */
  interval: string
  startingCash: number
}

const DEFAULT_CONFIG: LabConfig = { products: ['BTC-USD'], interval: '1', startingCash: 1000 }

interface Sample {
  /** Unix seconds. */
  t: number
  price: number | null
  upBid: number | null
  upAsk: number | null
  downBid: number | null
  downAsk: number | null
}

interface RoundRecord {
  ticker: string
  product: string
  open: number | null
  close: number
  strike: number | null
  /** The recorder started after the round did. */
  partial: boolean
  samples: Sample[]
  minutes: { bar: number; close: number; calls: Record<string, string>; values: Record<string, Record<string, number | null>> }[]
  result?: 'up' | 'down' | null
}

/** A paper holding: one round, one side. */
interface PaperRound {
  product: string
  ticker: string
  outcome: TradeOutcome
  closesAt: number
  openedAt: string
  /** Held now, and in total bought and sold. */
  contracts: number
  bought: number
  sold: number
  /** Dollars out (buys and their fees) and in (sales after fees, settlement). */
  spent: number
  received: number
  fees: number
  target: { mills: number; reason: string } | null
}

interface PaperAccount {
  version: 1
  startingCash: number
  cash: number
  startedAt: string
  rounds: Record<string, PaperRound>
}

const money = (value: number) => Math.round(value * 10_000) / 10_000
const cents = (mills: number | null | undefined) => (mills === null || mills === undefined ? null : mills / 10)
const word = (outcome: TradeOutcome) => (outcome === 'up' ? 'Up' : 'Down')
const day = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10)

const PLAYBOOK = `# Trading playbook

What the lab has taught about Kalshi's 15-minute crypto rounds. Rules here come from the journal
(journal.jsonl) and the recorded rounds (rounds/), with the numbers that back them.

## How the market works
- Up pays $1 if the coin closes the round at or above the strike, Down pays $1 otherwise.
- Taker fee: 7% × C × P × (1 − P), so it is largest near 50¢.

## Rules

## Setups that worked

## Mistakes to avoid

## Open questions
`

const README = `# CryptoAnal trading lab

Paper trading on Kalshi's 15-minute crypto markets: real prices and fees, no money. Live, and on the past.

- config.json: coins recorded and traded live, the chart interval read, the paper starting cash.
- rounds/<COIN>/<YYYY-MM-DD>.jsonl: live recordings, one line per round: strike, result ("up"/"down"),
  samples every 15 s (t, price, upBid, upAsk, downBid, downAsk in tenths of a cent: 520 = 52¢),
  and each minute's indicator calls and values.
- archive/<COIN>/<YYYY-MM-DD>.json: Kalshi's past rounds (strike, result, settle value, Up's best
  bid/ask each minute, in tenths of a cent) and Coinbase 1-minute candles; .reads-*.json.gz beside
  them: every minute's indicator calls and values as known then. peek-*.json: the indicators that
  would look ahead in history, which are therefore computed minute by minute.
- backtests/: every backtest run: the rule, its numbers and every trade.
- replays.json: the score of blind replays of past rounds.
- journal.jsonl: every paper order with the reason given and the market at that moment (kind buy /
  sell / target / target-fill / settle / round / note / reset; replay-buy / replay-sell / replay-round;
  backtest); "round" lines carry each live round's P&L after fees.
- paper.json: the live paper account now.
- PLAYBOOK.md: what was learned, in words.

Tools: server/lab/mcp.ts serves it all as MCP tools (npx tsx server/lab/mcp.ts in the cryptoanal
folder). The live ones need the dev server (GET /api/lab/status|journal|rounds|playbook,
POST /api/lab/buy|sell|target|target/cancel|note|playbook|reset, this computer only).
`

export class Lab {
  private config: LabConfig
  private account: PaperAccount
  private recording = new Map<string, RoundRecord>()
  private features = new Map<string, Features>()
  private featureBar = new Map<string, number>()
  private prices = new Map<string, { price: number; at: number }>()
  private lastSample = new Map<string, number>()
  private lastWatch = new Map<string, number>()
  /** Rounds over, waiting for Kalshi's result: ticker → when they closed (ms) and their record. */
  private awaiting = new Map<string, { since: number; record: RoundRecord | null; nextAt: number }>()
  private timer: ReturnType<typeof setInterval> | null = null
  private offEngine: (() => void) | null = null
  private targetCheck = false
  private saving: Promise<void> = Promise.resolve()
  private readonly kalshi = new KalshiRest('live', null)

  constructor(
    private readonly engine: TradeEngine,
    private readonly dir: string,
    private readonly log: (line: string) => void = (line) => console.log(line),
  ) {
    mkdirSync(join(dir, 'rounds'), { recursive: true })
    this.config = this.readConfig()
    this.account = this.readAccount()
    if (!existsSync(join(dir, 'PLAYBOOK.md'))) writeFileSync(join(dir, 'PLAYBOOK.md'), PLAYBOOK)
    writeFileSync(join(dir, 'README.md'), README)
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), 1_000)
    // Targets are checked on every change of the live book, as real targets are.
    this.offEngine = this.engine.subscribe((env) => {
      if (env !== 'live' || this.targetCheck) return
      this.targetCheck = true
      queueMicrotask(() => {
        this.targetCheck = false
        this.checkTargets()
      })
    })
    // Rounds that ended while the lab was not running settle now.
    const now = Date.now() / 1000
    for (const r of Object.values(this.account.rounds)) if (r.closesAt <= now) this.await(r.ticker, null)
    this.log(`[lab] recording ${this.config.products.join(', ')} on Kalshi's live book; paper cash $${this.account.cash.toFixed(2)}`)
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.offEngine?.()
    this.offEngine = null
  }

  // ── Files ───────────────────────────────────────────────────────────────────────────────────

  private readConfig(): LabConfig {
    const file = join(this.dir, 'config.json')
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<LabConfig>
      const products = Array.isArray(raw.products) ? raw.products.filter((p) => typeof p === 'string' && KALSHI_SERIES[p]) : DEFAULT_CONFIG.products
      return {
        products: products.length ? products : DEFAULT_CONFIG.products,
        interval: typeof raw.interval === 'string' ? raw.interval : DEFAULT_CONFIG.interval,
        startingCash: typeof raw.startingCash === 'number' && raw.startingCash > 0 ? raw.startingCash : DEFAULT_CONFIG.startingCash,
      }
    } catch {
      writeFileSync(file, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`)
      return { ...DEFAULT_CONFIG }
    }
  }

  private readAccount(): PaperAccount {
    try {
      const raw = JSON.parse(readFileSync(join(this.dir, 'paper.json'), 'utf8')) as PaperAccount
      if (raw.version === 1 && typeof raw.cash === 'number' && raw.rounds) return raw
    } catch {
      // A new account below.
    }
    return this.newAccount(this.config.startingCash)
  }

  private newAccount(cash: number): PaperAccount {
    return { version: 1, startingCash: cash, cash, startedAt: new Date().toISOString(), rounds: {} }
  }

  private save(): Promise<void> {
    const text = `${JSON.stringify(this.account, null, 2)}\n`
    const file = join(this.dir, 'paper.json')
    this.saving = this.saving.then(async () => {
      await writeFile(`${file}.tmp`, text)
      await rename(`${file}.tmp`, file)
    })
    return this.saving.catch((error: unknown) => this.log(`[lab] paper.json not saved: ${String(error)}`))
  }

  private journal(entry: Record<string, unknown>): Promise<void> {
    return appendFile(join(this.dir, 'journal.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`).catch((error: unknown) =>
      this.log(`[lab] journal not written: ${String(error)}`),
    )
  }

  // ── The recorder ────────────────────────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    const now = Date.now()
    for (const product of this.config.products) {
      if (now - (this.lastWatch.get(product) ?? 0) > 20_000) {
        this.lastWatch.set(product, now)
        void this.engine.watch('live', product).catch(() => undefined)
      }
      if (now - (this.lastSample.get(product) ?? 0) >= SAMPLE_MS) {
        this.lastSample.set(product, now)
        void this.sample(product)
      }
      const bar = Math.floor((now - FEATURE_DELAY_MS) / 60_000) * 60
      if (this.featureBar.get(product) !== bar) {
        this.featureBar.set(product, bar)
        void this.readFeatures(product)
      }
    }
    for (const [ticker, wait] of this.awaiting) if (now >= wait.nextAt) void this.resolve(ticker)
  }

  private async coinPrice(product: string): Promise<number | null> {
    try {
      const response = await fetch(`https://api.exchange.coinbase.com/products/${product}/ticker`, { signal: AbortSignal.timeout(5_000) })
      const price = Number(((await response.json()) as { price?: string }).price)
      if (!Number.isFinite(price)) return null
      this.prices.set(product, { price, at: Date.now() })
      return price
    } catch {
      return null
    }
  }

  private async sample(product: string): Promise<void> {
    const price = await this.coinPrice(product)
    const depth = this.engine.depth('live', product)
    if (!depth) return
    const { market } = depth
    let record = this.recording.get(product)
    if (record && record.ticker !== market.ticker) {
      this.await(record.ticker, record)
      record = undefined
    }
    if (!record) {
      const nowSec = Math.floor(Date.now() / 1000)
      record = {
        ticker: market.ticker,
        product,
        open: market.open,
        close: market.close,
        strike: market.strike,
        partial: market.open === null || nowSec - market.open > SAMPLE_MS / 1000 + 5,
        samples: [],
        minutes: [],
      }
      this.recording.set(product, record)
    }
    record.samples.push({ t: Math.floor(Date.now() / 1000), price, upBid: market.upBid, upAsk: market.upAsk, downBid: market.downBid, downAsk: market.downAsk })
  }

  private async readFeatures(product: string): Promise<void> {
    try {
      const instances = desktopIndicators(workspaceFile(), this.config.interval)
      const features = await computeFeatures(product, this.config.interval, instances)
      this.features.set(product, features)
      const record = this.recording.get(product)
      if (record && !record.minutes.some((m) => m.bar === features.bar))
        record.minutes.push({
          bar: features.bar,
          close: features.close,
          calls: Object.fromEntries(features.indicators.map((r) => [r.name, r.call])),
          values: Object.fromEntries(features.indicators.map((r) => [r.name, r.values])),
        })
    } catch (error) {
      this.log(`[lab] ${product} indicators not read: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** A round is over: ask Kalshi for its result until it has one. */
  private await(ticker: string, record: RoundRecord | null): void {
    const known = this.awaiting.get(ticker)
    this.awaiting.set(ticker, { since: known?.since ?? Date.now(), record: record ?? known?.record ?? null, nextAt: Date.now() + 5_000 })
  }

  private async resolve(ticker: string): Promise<void> {
    const wait = this.awaiting.get(ticker)
    if (!wait) return
    wait.nextAt = Date.now() + RESULT_RETRY_MS
    let result: 'up' | 'down' | null = null
    try {
      const body = (await this.kalshi.call('GET', `/markets/${encodeURIComponent(ticker)}`, { authed: false })) as { market?: { result?: string } }
      result = body.market?.result === 'yes' ? 'up' : body.market?.result === 'no' ? 'down' : null
    } catch {
      // Asked again later.
    }
    if (result === null && Date.now() - wait.since < RESULT_GIVE_UP_MS) return
    this.awaiting.delete(ticker)
    if (wait.record) {
      wait.record.result = result
      const file = join(this.dir, 'rounds', wait.record.product, `${day(wait.record.close)}.jsonl`)
      await mkdir(join(this.dir, 'rounds', wait.record.product), { recursive: true })
      await appendFile(file, `${JSON.stringify(wait.record)}\n`).catch((error: unknown) => this.log(`[lab] round not recorded: ${String(error)}`))
    }
    if (result) await this.settle(ticker, result)
  }

  // ── The paper account ───────────────────────────────────────────────────────────────────────

  private context(product: string, market: TradeMarket) {
    const price = this.prices.get(product)?.price ?? null
    const features = this.features.get(product)
    return {
      secondsLeft: Math.round(market.close - Date.now() / 1000),
      price,
      strike: market.strike,
      fromStrike: price !== null && market.strike !== null ? Math.round((price - market.strike) * 100) / 100 : null,
      upBid: cents(market.upBid),
      upAsk: cents(market.upAsk),
      downBid: cents(market.downBid),
      downAsk: cents(market.downAsk),
      calls: features ? Object.fromEntries(features.indicators.map((r) => [r.name, r.call])) : {},
    }
  }

  /** The live book of a coin's running round, or why there is none. */
  private live(product: unknown) {
    if (typeof product !== 'string' || !this.config.products.includes(product))
      throw new TradeError(400, `The lab trades ${this.config.products.join(', ')}.`, 'BAD_PRODUCT')
    const depth = this.engine.depth('live', product)
    if (!depth) throw new TradeError(409, `No live ${product} round yet; try again in a moment.`, 'NO_MARKET')
    if (Date.now() - depth.bookAt > 30_000 && depth.market.close * 1000 > Date.now()) void this.engine.watch('live', product)
    if (depth.market.close * 1000 <= Date.now()) throw new TradeError(409, 'This round just closed; the next one opens in a moment.', 'CLOSED')
    return { product, ...depth }
  }

  private reasonOf(raw: unknown): string {
    if (typeof raw !== 'string' || raw.trim().length < 3) throw new TradeError(400, 'Every paper order needs its reason: it is how the journal teaches.', 'NO_REASON')
    return raw.trim().slice(0, 2000)
  }

  async buy(raw: Record<string, unknown>) {
    const { product, market, yes, no } = this.live(raw.product)
    const outcome = raw.outcome ?? raw.side
    if (!isOutcome(outcome)) throw new TradeError(400, 'Buy up or down.', 'BAD_ORDER')
    const dollars = Number(raw.dollars)
    if (!(dollars >= 1 && dollars <= 100_000)) throw new TradeError(400, 'Buy $1 or more.', 'BAD_ORDER')
    const reason = this.reasonOf(raw.reason)
    const held = this.account.rounds[market.ticker]
    if (held && held.outcome !== outcome && held.contracts > 0)
      throw new TradeError(409, `You hold ${word(held.outcome)} in this round: sell it first.`, 'OTHER_SIDE')
    if (dollars > this.account.cash + 1e-9) throw new TradeError(409, `The paper account has $${this.account.cash.toFixed(2)}.`, 'NO_CASH')
    const best = outcome === 'up' ? market.upAsk : market.downAsk
    if (best === null) throw new TradeError(409, `Nobody sells ${word(outcome)} right now.`, 'NO_SELLERS')
    const capRaw = Number(raw.maxCents)
    const cap = Math.min(Number.isFinite(capRaw) && capRaw > 0 ? Math.round(capRaw * 10) : 999, best + PAPER_SLIPPAGE_MILLS, 999)
    const fill = fillBuy(asksFor({ yes, no }, outcome), dollars, cap, TAKER_FEE * market.feeMultiplier)
    const context = this.context(product, market)
    if (!fill.count) {
      await this.journal({ kind: 'buy', product, ticker: market.ticker, outcome, dollars, filled: 0, reason, context })
      return { ok: true, filled: 0, message: `Nothing filled: no ${word(outcome)} sellers at ${cap / 10}¢ or less.` }
    }
    const cost = money(fill.value + fill.fee)
    this.account.cash = money(this.account.cash - cost)
    const round = held ?? (this.account.rounds[market.ticker] = {
      product,
      ticker: market.ticker,
      outcome,
      closesAt: market.close,
      openedAt: new Date().toISOString(),
      contracts: 0,
      bought: 0,
      sold: 0,
      spent: 0,
      received: 0,
      fees: 0,
      target: null,
    })
    round.contracts = money(round.contracts + fill.count)
    round.bought = money(round.bought + fill.count)
    round.spent = money(round.spent + cost)
    round.fees = money(round.fees + fill.fee)
    await this.save()
    await this.journal({ kind: 'buy', product, ticker: market.ticker, outcome, dollars, filled: fill.count, avgCents: fill.avgMills / 10, cost, fee: fill.fee, cash: this.account.cash, reason, context })
    return { ok: true, filled: fill.count, avgCents: fill.avgMills / 10, cost, fee: fill.fee, cash: this.account.cash, message: `Paper: bought ${fill.count} ${word(outcome)} at ${fill.avgMills / 10}¢ avg ($${cost.toFixed(2)} with $${fill.fee.toFixed(2)} fee).` }
  }

  async sell(raw: Record<string, unknown>) {
    const { product, market, yes, no } = this.live(raw.product)
    const reason = this.reasonOf(raw.reason)
    const round = this.account.rounds[market.ticker]
    if (!round || round.contracts <= 0) throw new TradeError(409, `Nothing held in this ${product} round.`, 'NOTHING_HELD')
    const minRaw = Number(raw.minCents)
    const floor = Number.isFinite(minRaw) && minRaw > 0 ? Math.round(minRaw * 10) : 1
    const fill = fillSell(bidsFor({ yes, no }, round.outcome), round.contracts, floor, TAKER_FEE * market.feeMultiplier)
    return this.recordSale(round, fill, 'sell', reason, this.context(product, market))
  }

  private async recordSale(round: PaperRound, fill: Fill, kind: 'sell' | 'target-fill', reason: string, context: ReturnType<Lab['context']>) {
    if (!fill.count) {
      await this.journal({ kind, product: round.product, ticker: round.ticker, outcome: round.outcome, filled: 0, reason, context })
      return { ok: true, filled: 0, message: `Nothing sold: no ${word(round.outcome)} buyers at the floor.` }
    }
    const proceeds = money(fill.value - fill.fee)
    this.account.cash = money(this.account.cash + proceeds)
    round.contracts = money(round.contracts - fill.count)
    round.sold = money(round.sold + fill.count)
    round.received = money(round.received + proceeds)
    round.fees = money(round.fees + fill.fee)
    if (round.contracts <= 1e-9) round.target = null
    await this.journal({ kind, product: round.product, ticker: round.ticker, outcome: round.outcome, filled: fill.count, avgCents: fill.avgMills / 10, proceeds, fee: fill.fee, cash: this.account.cash, reason, context })
    if (round.contracts <= 1e-9) await this.closeRound(round, 'sold')
    await this.save()
    return { ok: true, filled: fill.count, avgCents: fill.avgMills / 10, proceeds, fee: fill.fee, cash: this.account.cash, message: `Paper: sold ${fill.count} ${word(round.outcome)} at ${fill.avgMills / 10}¢ avg ($${proceeds.toFixed(2)} after $${fill.fee.toFixed(2)} fee).` }
  }

  async setTarget(raw: Record<string, unknown>) {
    const { market } = this.live(raw.product)
    const reason = this.reasonOf(raw.reason)
    const round = this.account.rounds[market.ticker]
    if (!round || round.contracts <= 0) throw new TradeError(409, 'A target needs a holding in this round.', 'NOTHING_HELD')
    const mills = Math.round(Number(raw.cents) * 10)
    if (!(mills > 0 && mills < 1000)) throw new TradeError(400, 'A target is a price between 0.1¢ and 99.9¢.', 'BAD_TARGET')
    round.target = { mills, reason }
    await this.save()
    await this.journal({ kind: 'target', product: round.product, ticker: round.ticker, outcome: round.outcome, targetCents: mills / 10, reason, context: this.context(round.product, market) })
    this.checkTargets()
    return { ok: true, message: `Paper target: sell all ${word(round.outcome)} once buyers pay ${mills / 10}¢.` }
  }

  async cancelTarget(raw: Record<string, unknown>) {
    const { market } = this.live(raw.product)
    const round = this.account.rounds[market.ticker]
    if (!round?.target) return { ok: true, message: 'No target to cancel.' }
    round.target = null
    await this.save()
    await this.journal({ kind: 'target-cancel', product: round.product, ticker: round.ticker, reason: typeof raw.reason === 'string' ? raw.reason : '' })
    return { ok: true, message: 'Target canceled.' }
  }

  /** On every change of the live book: a target whose price the buyers pay sells everything. */
  private checkTargets(): void {
    for (const round of Object.values(this.account.rounds)) {
      if (!round.target || round.contracts <= 0) continue
      const depth = this.engine.depth('live', round.product)
      if (!depth || depth.market.ticker !== round.ticker || depth.market.close * 1000 <= Date.now()) continue
      const bid = round.outcome === 'up' ? depth.market.upBid : depth.market.downBid
      if (bid === null || bid < round.target.mills) continue
      const target = round.target
      const fill = fillSell(bidsFor(depth, round.outcome), round.contracts, target.mills, TAKER_FEE * depth.market.feeMultiplier)
      if (fill.count) void this.recordSale(round, fill, 'target-fill', target.reason, this.context(round.product, depth.market))
    }
  }

  private async settle(ticker: string, result: 'up' | 'down'): Promise<void> {
    const round = this.account.rounds[ticker]
    if (!round) return
    const payout = round.outcome === result ? money(round.contracts) : 0
    this.account.cash = money(this.account.cash + payout)
    round.received = money(round.received + payout)
    await this.journal({ kind: 'settle', product: round.product, ticker, outcome: round.outcome, result, held: round.contracts, payout, cash: this.account.cash })
    round.contracts = 0
    await this.closeRound(round, round.outcome === result ? 'won' : 'lost')
    await this.save()
  }

  private async closeRound(round: PaperRound, how: 'sold' | 'won' | 'lost'): Promise<void> {
    delete this.account.rounds[round.ticker]
    const pnl = money(round.received - round.spent)
    this.log(`[lab] paper ${round.ticker} ${word(round.outcome)} ${how}: ${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl).toFixed(2)}`)
    await this.journal({ kind: 'round', product: round.product, ticker: round.ticker, outcome: round.outcome, how, bought: round.bought, sold: round.sold, spent: round.spent, received: round.received, fees: round.fees, pnl, cash: this.account.cash })
  }

  // ── What the trader reads ───────────────────────────────────────────────────────────────────

  status(product?: string | null) {
    const products = product ? [product] : this.config.products
    const levels = (list: { mills: number; size: number }[]) => list.slice(0, 5).map((l) => [l.mills / 10, l.size])
    let marked = 0
    const holdings = Object.values(this.account.rounds).map((r) => {
      const depth = this.engine.depth('live', r.product)
      const bid = depth && depth.market.ticker === r.ticker ? (r.outcome === 'up' ? depth.market.upBid : depth.market.downBid) : null
      if (bid !== null) marked += (r.contracts * bid) / 1000
      return {
        product: r.product,
        ticker: r.ticker,
        side: r.outcome,
        contracts: r.contracts,
        avgPaidCents: r.bought ? Math.round(((r.spent - r.fees) / r.bought) * 1000) / 10 : null,
        spent: r.spent,
        received: r.received,
        bidCents: cents(bid),
        target: r.target ? { cents: r.target.mills / 10, reason: r.target.reason } : null,
        secondsLeft: Math.round(r.closesAt - Date.now() / 1000),
      }
    })
    const equity = money(this.account.cash + marked)
    return {
      now: new Date().toISOString(),
      account: { cash: this.account.cash, equity, startingCash: this.account.startingCash, pnl: money(equity - this.account.startingCash), since: this.account.startedAt, holdings },
      markets: products.map((p) => {
        const depth = this.engine.depth('live', p)
        const features = this.features.get(p)
        if (!depth) return { product: p, message: 'Reading the live round…' }
        const { market } = depth
        const book = { yes: depth.yes, no: depth.no }
        return {
          product: p,
          ticker: market.ticker,
          ...this.context(p, market),
          book: { upAsks: levels(asksFor(book, 'up')), upBids: levels(bidsFor(book, 'up')), downAsks: levels(asksFor(book, 'down')), downBids: levels(bidsFor(book, 'down')) },
          bookAgeSeconds: Math.round((Date.now() - depth.bookAt) / 1000),
          indicators: features ? { interval: features.interval, bar: new Date(features.bar * 1000).toISOString(), close: features.close, read: features.indicators.map(({ name, call, values }) => ({ name, call, values })) } : null,
        }
      }),
    }
  }

  async journalTail(limit: number) {
    try {
      const lines = (await readFile(join(this.dir, 'journal.jsonl'), 'utf8')).trim().split('\n').filter(Boolean)
      return { file: join(this.dir, 'journal.jsonl'), entries: lines.slice(-limit).map((l) => JSON.parse(l) as unknown) }
    } catch {
      return { file: join(this.dir, 'journal.jsonl'), entries: [] }
    }
  }

  /** Recorded rounds, newest first, with each round's path cut to one sample a minute. */
  async rounds(product: string | null, limit: number) {
    const out: unknown[] = []
    for (const p of product ? [product] : this.config.products) {
      const folder = join(this.dir, 'rounds', p)
      const days = (await readdir(folder).catch(() => [] as string[])).filter((f) => f.endsWith('.jsonl')).sort().reverse()
      for (const name of days) {
        const lines = (await readFile(join(folder, name), 'utf8')).trim().split('\n').filter(Boolean).reverse()
        for (const line of lines) {
          const r = JSON.parse(line) as RoundRecord
          const startPrice = r.samples.find((s) => s.price !== null)?.price ?? null
          const endPrice = [...r.samples].reverse().find((s) => s.price !== null)?.price ?? null
          out.push({
            ticker: r.ticker,
            product: r.product,
            close: new Date(r.close * 1000).toISOString(),
            strike: r.strike,
            result: r.result,
            partial: r.partial,
            startPrice,
            endPrice,
            perMinute: r.samples.filter((_, k) => k % 4 === 0).map((s) => ({ t: s.t - (r.open ?? r.close - 900), price: s.price, upBid: cents(s.upBid), upAsk: cents(s.upAsk) })),
            calls: r.minutes.map((m) => ({ minute: Math.round((m.bar - (r.open ?? r.close - 900)) / 60), ...m.calls })),
          })
          if (out.length >= limit * (product ? 1 : this.config.products.length)) break
        }
        if (out.length >= limit * (product ? 1 : this.config.products.length)) break
      }
    }
    return { folder: join(this.dir, 'rounds'), rounds: out }
  }

  async note(raw: Record<string, unknown>) {
    const text = typeof raw.text === 'string' ? raw.text.trim() : ''
    if (text.length < 3) throw new TradeError(400, 'Write the note.', 'BAD_NOTE')
    const kind = ['lesson', 'observation', 'rule', 'mistake', 'question'].includes(String(raw.kind)) ? String(raw.kind) : 'observation'
    await this.journal({ kind: 'note', note: kind, text: text.slice(0, 5000) })
    return { ok: true, message: `Noted (${kind}).` }
  }

  async playbook(raw?: Record<string, unknown>) {
    const file = join(this.dir, 'PLAYBOOK.md')
    if (raw && typeof raw.content === 'string') {
      if (raw.content.trim().length < 20) throw new TradeError(400, 'That would empty the playbook.', 'BAD_PLAYBOOK')
      await writeFile(`${file}.tmp`, raw.content)
      await rename(`${file}.tmp`, file)
    }
    return { file, content: await readFile(file, 'utf8') }
  }

  async reset(raw: Record<string, unknown>) {
    const cash = Number(raw.cash ?? this.config.startingCash)
    if (!(cash >= 10 && cash <= 1_000_000)) throw new TradeError(400, 'Start with $10 to $1,000,000.', 'BAD_RESET')
    const before = this.status()
    this.account = this.newAccount(cash)
    await this.save()
    await this.journal({ kind: 'reset', cash, before: before.account, reason: typeof raw.reason === 'string' ? raw.reason : '' })
    return { ok: true, message: `Paper account reset to $${cash.toFixed(2)}.` }
  }

  // ── HTTP ────────────────────────────────────────────────────────────────────────────────────

  /** `/api/lab/*`, for this computer only. */
  async handle(req: IncomingMessage, res: ServerResponse, route: string): Promise<void> {
    guardLocal(req)
    const url = new URL(req.url ?? '/', 'http://lab.internal')
    const json = (value: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    if (req.method === 'GET') {
      if (route === 'status') return json(this.status(url.searchParams.get('product')))
      if (route === 'journal') return json(await this.journalTail(Math.min(500, Number(url.searchParams.get('limit')) || 30)))
      if (route === 'rounds') return json(await this.rounds(url.searchParams.get('product'), Math.min(200, Number(url.searchParams.get('limit')) || 10)))
      if (route === 'playbook') return json(await this.playbook())
      throw new TradeError(404, 'Not found.', 'NOT_FOUND')
    }
    if (req.method !== 'POST') throw new TradeError(405, 'Use GET or POST.', 'METHOD')
    const body = await readJson(req)
    if (route === 'buy') return json(await this.buy(body))
    if (route === 'sell') return json(await this.sell(body))
    if (route === 'target') return json(await this.setTarget(body))
    if (route === 'target/cancel') return json(await this.cancelTarget(body))
    if (route === 'note') return json(await this.note(body))
    if (route === 'playbook') return json(await this.playbook(body))
    if (route === 'reset') return json(await this.reset(body))
    throw new TradeError(404, 'Not found.', 'NOT_FOUND')
  }
}
