/**
 * Studying the past: backtests and replays over the archive, for the MCP tools and the command line.
 * Works without the dev server: it reads Kalshi and Coinbase itself.
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { KALSHI_SERIES } from '../kalshi'
import { workspaceFile } from '../workspace'
import { dayOf, dayStart, daysBetween } from './archive'
import { compileRule, playRound, summarize, type BacktestTrade, type RuleSpec } from './backtest'
import { Past, yesterday } from './past'
import { Replays } from './replay'

const DAY = 86_400
/** BTC first: each coin behaves its own way, so it is studied alone. */
export const DEFAULT_PRODUCTS = ['BTC-USD']

export const labDir = () => join(dirname(workspaceFile()), 'lab')

/** The days asked for: from / to (YYYY-MM-DD), or the last `days` before today (default 30). */
export function dayRange(raw: { from?: unknown; to?: unknown; days?: unknown }): string[] {
  const iso = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)
  const to = iso(raw.to) && iso(raw.to)! <= yesterday() ? iso(raw.to)! : yesterday()
  const count = Math.max(1, Math.min(365, Math.round(Number(raw.days) || 30)))
  const from = iso(raw.from) ?? dayOf(dayStart(to) - (count - 1) * DAY)
  if (from > to) throw new Error('"from" comes after "to".')
  return daysBetween(from, to)
}

function productsOf(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : DEFAULT_PRODUCTS
  const products = list.filter((p): p is string => typeof p === 'string' && !!KALSHI_SERIES[p])
  if (!products.length) throw new Error(`Coins with 15-minute rounds: ${Object.keys(KALSHI_SERIES).join(', ')}.`)
  return products
}

export class Study {
  readonly past: Past
  readonly replays: Replays

  constructor(
    private readonly dir = labDir(),
    log: (line: string) => void = (line) => console.error(line),
  ) {
    this.past = new Past(join(dir, 'archive'), log)
    this.replays = new Replays(this.past, dir, (entry) => this.journal(entry))
  }

  async journal(entry: Record<string, unknown>): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await appendFile(join(this.dir, 'journal.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
  }

  /** How far the past is prepared, and the preparing now. */
  pastStatus(raw: Record<string, unknown>) {
    const days = dayRange(raw)
    const products = productsOf(raw.products ?? raw.product)
    return {
      range: { from: days[0], to: days[days.length - 1], days: days.length },
      ready: Object.fromEntries(products.map((p) => [p, this.past.ready(p, days).length])),
      preparing: this.past.status,
    }
  }

  prepare(raw: Record<string, unknown>) {
    this.past.reload()
    const days = dayRange(raw)
    const products = productsOf(raw.products ?? raw.product)
    this.past.prepare(products, days)
    return this.pastStatus(raw)
  }

  async backtest(raw: Record<string, unknown>) {
    const rule = (raw.rule ?? raw) as RuleSpec
    if (!rule || typeof rule !== 'object') throw new Error('Send the rule.')
    const days = dayRange(raw)
    const products = productsOf(raw.products ?? raw.product)
    const missing = products.reduce((n, p) => n + days.length - this.past.ready(p, days).length, 0)
    if (missing) this.past.prepare(products, days)
    // Day by day: a year of rounds with every minute's indicators does not fit in memory at once.
    const compiled = compileRule(rule)
    const trades: BacktestTrade[] = []
    let rounds = 0
    for (const product of products)
      for (const day of this.past.ready(product, days))
        for (const scene of await this.past.dayScenes(product, day)) {
          if (scene.round.result) rounds += 1
          const trade = playRound(compiled, scene)
          if (trade) trades.push(trade)
        }
    if (!rounds) return { ok: false, message: `None of those days is prepared yet; preparing them now (${missing} coin-days). Ask again shortly.`, preparing: this.past.status }
    trades.sort((a, b) => a.close.localeCompare(b.close))
    const summary = summarize(trades, rounds)
    const at = new Date().toISOString()
    const slug = String(rule.name ?? 'rule').replace(/[^A-Za-z0-9-]+/g, '-').slice(0, 40)
    const file = join(this.dir, 'backtests', `${at.replace(/[:.]/g, '-')}-${slug}.json`)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify({ at, rule, days: { from: days[0], to: days[days.length - 1] }, products, summary, trades }, null, 1)}\n`)
    const { worst, best, byPrice, byMinute, byMonth, byProduct, byExit, halves, ...headline } = summary
    await this.journal({ kind: 'backtest', rule, days: { from: days[0], to: days[days.length - 1] }, products, ...headline, file })
    const shown = Math.max(0, Math.min(50, Math.round(Number(raw.showTrades) || 0)))
    return {
      ok: true,
      note: missing ? `${missing} coin-days were not prepared yet and are left out (preparing now).` : undefined,
      days: { from: days[0], to: days[days.length - 1] },
      products,
      summary: { ...headline, halves, byMonth, byPrice, byMinute, byProduct, byExit, worst, best },
      trades: shown ? trades.slice(-shown) : undefined,
      file,
    }
  }

  async replayStart(raw: Record<string, unknown>) {
    const [product] = productsOf(raw.product ?? DEFAULT_PRODUCTS[0])
    return this.replays.start(product, dayRange(raw))
  }

  replayStep(raw: Record<string, unknown>) {
    return this.replays.step(raw)
  }
}
