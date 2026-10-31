/**
 * A moment of a past round, as a trader saw it then: `minute` minutes in (1 to 14), every price
 * and call as of that minute's end and nothing after. Backtest rules read it through names and
 * functions (`upAsk`, `has("SAR", "ABOVE")`); a replay shows it whole.
 */
import type { ArchiveMinute } from './archive'
import type { Scene } from './past'
import type { Scope, Value } from './rules'

export const VARS = [
  'minute',
  'secondsLeft',
  'price',
  'strike',
  'fromStrike',
  'fromStrikePct',
  'upBid',
  'upAsk',
  'downBid',
  'downAsk',
  'spread',
  'favorite',
  'favAsk',
  'dogAsk',
  'volume',
  'hour',
  'weekday',
  'lastResult',
] as const

export const FNS = ['call', 'has', 'value', 'ago', 'move', 'movePct', 'sigma', 'zscore', 'fairUp', 'abs', 'min', 'max', 'resultsAgo'] as const

/** What each name and function means, for the trader. */
export const RULE_HELP = `Values at the end of the minute (prices in cents, 52 = 52¢):
  minute (1-14 into the round), secondsLeft, price (Coinbase), strike, fromStrike (price - strike, $),
  fromStrikePct (%), upBid, upAsk, downBid, downAsk, spread (upAsk - upBid), favorite ('up'/'down', the
  dearer side), favAsk, dogAsk (asks of the favorite and the underdog), volume (contracts traded on
  Kalshi in the minute), hour (UTC 0-23), weekday (0 Sunday - 6), lastResult ('up'/'down', the round before).
Functions:
  call("RSI") the indicator's call; has("SAR", "ABOVE") its call contains the text; value("RSI", "RSI")
  a plot's value; each takes minutes back as a last argument: has("TMO", "UP", 1).
  ago("upAsk", 3) any value 3 minutes earlier in the round (price works back before it too).
  move(5) / movePct(5): the coin's change over 5 minutes ($ / %). sigma(30): the standard deviation of
  1-minute moves over 30 minutes ($). zscore(30): fromStrike in sigmas of the time left.
  fairUp(30): Up's chance from that z-score, in cents: compare with upAsk.
  resultsAgo(n): the result n rounds back (1 = lastResult). abs, min, max.
Indicator names match exactly, else by their start, else anywhere: "RSI", "Stoch", "TMO", "SAR", "CM".
In exit rules also: bid (your side's bid), paid (your average price), gain (bid - paid).`

const cents = (mills: number | null) => (mills === null ? null : mills / 10)

/** The standard normal distribution function (Abramowitz-Stegun 26.2.17, error < 1e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2)
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return z >= 0 ? 1 - p : p
}

/** The indicator a rule names: exactly, else by its start, else anywhere in the name. */
function findName(names: readonly string[], wanted: string): string | null {
  const w = wanted.toLowerCase()
  const lower = names.map((n) => n.toLowerCase())
  const k = [lower.indexOf(w), lower.findIndex((n) => n.startsWith(w)), lower.findIndex((n) => n.includes(w))].find((x) => x >= 0)
  return k === undefined ? null : names[k]
}

export class Moment {
  readonly t: number
  readonly kalshi: ArchiveMinute

  constructor(
    readonly scene: Scene,
    /** Minutes into the round, 1 to 14. */
    readonly minute: number,
  ) {
    this.t = scene.round.open + 60 * minute
    this.kalshi = scene.round.minutes[minute - 1]
  }

  /** The coin's close `back` minutes before this moment (0: now). */
  price(back = 0): number | null {
    return this.scene.closes.get(this.t - 60 * (back + 1)) ?? null
  }

  get(name: string): Value {
    const { round } = this.scene
    const m = this.kalshi
    const price = this.price()
    switch (name) {
      case 'minute':
        return this.minute
      case 'secondsLeft':
        return round.close - this.t
      case 'price':
        return price
      case 'strike':
        return round.strike
      case 'fromStrike':
        return price === null || round.strike === null ? null : Math.round((price - round.strike) * 100) / 100
      case 'fromStrikePct':
        return price === null || !round.strike ? null : ((price - round.strike) / round.strike) * 100
      case 'upBid':
        return cents(m.upBid)
      case 'upAsk':
        return cents(m.upAsk)
      case 'downBid':
        return m.upAsk === null ? null : 100 - m.upAsk / 10
      case 'downAsk':
        return m.upBid === null ? null : 100 - m.upBid / 10
      case 'spread':
        return m.upAsk === null || m.upBid === null ? null : (m.upAsk - m.upBid) / 10
      case 'favorite':
        return this.favorite()
      case 'favAsk':
        return this.get(this.favorite() === 'up' ? 'upAsk' : 'downAsk')
      case 'dogAsk':
        return this.get(this.favorite() === 'up' ? 'downAsk' : 'upAsk')
      case 'volume':
        return Math.round(m.volume)
      case 'hour':
        return new Date(this.t * 1000).getUTCHours()
      case 'weekday':
        return new Date(this.t * 1000).getUTCDay()
      case 'lastResult':
        return this.scene.before[0] ?? null
    }
    return null
  }

  /** The dearer side, by the middle of Up's bid and ask. */
  favorite(): 'up' | 'down' {
    const { upBid, upAsk } = this.kalshi
    const mid = upBid !== null && upAsk !== null ? (upBid + upAsk) / 2 : (upBid ?? upAsk ?? 500)
    return mid >= 500 ? 'up' : 'down'
  }

  /** The indicator readings of the bar that just closed, or `back` bars before it. */
  read(back = 0) {
    return this.scene.reads.get(this.t - 60 * (back + 1)) ?? null
  }

  call(name: string, back = 0): string | null {
    const read = this.read(back)
    if (!read) return null
    const found = findName(Object.keys(read.calls), name)
    return found ? read.calls[found] : null
  }

  value(name: string, plot: string, back = 0): number | null {
    const read = this.read(back)
    if (!read) return null
    const found = findName(Object.keys(read.values), name)
    if (!found) return null
    const plots = read.values[found]
    const key = findName(Object.keys(plots), plot)
    return key ? plots[key] : null
  }

  sigma(n: number): number | null {
    const moves: number[] = []
    for (let k = 0; k < n; k++) {
      const a = this.price(k)
      const b = this.price(k + 1)
      if (a !== null && b !== null) moves.push(a - b)
    }
    if (moves.length < Math.max(5, n / 2)) return null
    const mean = moves.reduce((s, x) => s + x, 0) / moves.length
    return Math.sqrt(moves.reduce((s, x) => s + (x - mean) ** 2, 0) / (moves.length - 1))
  }

  zscore(n: number): number | null {
    const from = this.get('fromStrike') as number | null
    const sigma = this.sigma(n)
    const left = (this.scene.round.close - this.t) / 60
    if (from === null || !sigma || left <= 0) return null
    return from / (sigma * Math.sqrt(left))
  }

  /** The rule language's view of this moment; `extra` adds names (an exit rule's bid, paid, gain). */
  scope(extra: Record<string, Value> = {}): Scope {
    const n = (v: Value, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : fallback)
    const s = (v: Value) => (v === null ? '' : String(v))
    return {
      vars: (name) => (name in extra ? extra[name] : this.get(name)),
      fns: {
        call: (name, back) => this.call(s(name), n(back, 0)),
        has: (name, text, back) => {
          const c = this.call(s(name), n(back, 0))
          return c !== null && c.toLowerCase().includes(s(text).toLowerCase())
        },
        value: (name, plot, back) => this.value(s(name), s(plot), n(back, 0)),
        ago: (name, back) => {
          const k = n(back, 0)
          if (s(name) === 'price') return this.price(k)
          if (this.minute - k < 1) return null
          return new Moment(this.scene, this.minute - k).get(s(name))
        },
        move: (back) => {
          const a = this.price()
          const b = this.price(n(back, 1))
          return a === null || b === null ? null : a - b
        },
        movePct: (back) => {
          const a = this.price()
          const b = this.price(n(back, 1))
          return a === null || !b ? null : ((a - b) / b) * 100
        },
        sigma: (back) => this.sigma(n(back, 30)),
        zscore: (back) => this.zscore(n(back, 30)),
        fairUp: (back) => {
          const z = this.zscore(n(back, 30))
          return z === null ? null : Math.round(normalCdf(z) * 1000) / 10
        },
        resultsAgo: (back) => this.scene.before[n(back, 1) - 1] ?? null,
        abs: (v) => (typeof v === 'number' ? Math.abs(v) : null),
        min: (...vs) => {
          const xs = vs.filter((v): v is number => typeof v === 'number')
          return xs.length ? Math.min(...xs) : null
        },
        max: (...vs) => {
          const xs = vs.filter((v): v is number => typeof v === 'number')
          return xs.length ? Math.max(...xs) : null
        },
      },
    }
  }

  /** Everything a trader sees at this moment (a replay's screen). */
  view() {
    const value = (name: string) => this.get(name)
    const read = this.read()
    const z = this.zscore(30)
    const fns = this.scope().fns
    const dollars = (v: Value | null) => (typeof v === 'number' ? Math.round(v * 100) / 100 : null)
    return {
      minute: this.minute,
      secondsLeft: value('secondsLeft'),
      price: value('price'),
      strike: value('strike'),
      fromStrike: value('fromStrike'),
      upBid: value('upBid'),
      upAsk: value('upAsk'),
      downBid: value('downBid'),
      downAsk: value('downAsk'),
      kalshiVolume: value('volume'),
      move1: dollars(fns.move(1)),
      move5: dollars(fns.move(5)),
      sigma30: dollars(this.sigma(30)),
      zscore30: z === null ? null : Math.round(z * 100) / 100,
      calls: read?.calls ?? {},
    }
  }
}
