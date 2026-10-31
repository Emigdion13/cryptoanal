/**
 * The past, ready to trade again: archived rounds (archive.ts) with the desktop's indicator calls at
 * every minute (series.ts), kept per coin and day in ~/.cryptoanal/lab/archive. Preparing a month
 * takes a few minutes the first time (downloads, then the indicators that would peek computed
 * minute by minute); after that it reads in a moment.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { Candle } from '../../src/data/types'
import type { IndicatorInstance } from '../../src/indicators/types'
import { workspaceFile } from '../workspace'
import { Archive, dayOf, dayStart, daysBetween, type ArchiveRound } from './archive'
import { desktopIndicators } from './features'
import { indicatorTimeline, peekCheck, type BarRead } from './series'

/** Days of candles read before a day so its indicators are warm (and a 30-minute feed has 150 bars). */
const WARM_DAYS = 4
/** Bumped when what a timeline holds changes. */
const TIMELINE_VERSION = 1

/** One round with what a trader could see around it. */
export interface Scene {
  round: ArchiveRound
  /** Coinbase 1-minute closes by bar open time, from two hours before the round to its close. */
  closes: Map<number, number>
  /** Indicator readings by bar open time (read at the bar's close), over the same span. */
  reads: Map<number, BarRead>
  /** The results of the rounds before this one, newest first (as many as are known, up to 8). */
  before: ('up' | 'down' | null)[]
}

export interface PrepareStatus {
  running: boolean
  product: string | null
  done: number
  total: number
  day: string | null
  error: string | null
  /** Indicators read minute by minute because they would otherwise peek. */
  strict: string[]
}

const DAY = 86_400

export const yesterday = () => dayOf(Math.floor(Date.now() / 1000) - DAY)

export class Past {
  readonly archive: Archive
  private instances: IndicatorInstance[] = []
  private hash = ''
  private strict: Set<string> | null = null
  private job: Promise<void> | null = null
  private state: PrepareStatus = { running: false, product: null, done: 0, total: 0, day: null, error: null, strict: [] }

  constructor(
    private readonly dir: string,
    private readonly log: (line: string) => void = () => undefined,
  ) {
    this.archive = new Archive(dir)
    this.reload()
  }

  /** Reads the desktop's 1-minute indicators again (a changed setup gets timelines of its own). */
  reload(): void {
    this.instances = desktopIndicators(workspaceFile(), '1')
    const setup = JSON.stringify([TIMELINE_VERSION, this.instances.map((i) => [i.type, i.inputs])])
    const hash = createHash('sha1').update(setup).digest('hex').slice(0, 10)
    if (hash !== this.hash) {
      this.hash = hash
      this.strict = null
      try {
        this.strict = new Set((JSON.parse(readFileSync(join(this.dir, `peek-${hash}.json`), 'utf8')) as { strict: string[] }).strict)
      } catch {
        // Checked when the first day is prepared.
      }
    }
  }

  get status(): PrepareStatus {
    return { ...this.state, strict: this.strict ? [...this.strict] : [] }
  }

  private readsFile(product: string, day: string) {
    return join(this.dir, product, `${day}.reads-${this.hash}.json.gz`)
  }

  /** The days of a range already prepared. */
  ready(product: string, days: readonly string[]): string[] {
    return days.filter((d) => existsSync(this.readsFile(product, d)))
  }

  /**
   * Prepares the days still missing, one coin after another, in the background (one job at a
   * time). Answers at once; `status` follows it.
   */
  prepare(products: readonly string[], days: readonly string[]): PrepareStatus {
    if (this.job) return this.status
    const todo = products.flatMap((p) => days.filter((d) => d <= yesterday() && !existsSync(this.readsFile(p, d))).map((d) => [p, d] as const))
    if (!todo.length) return this.status
    this.state = { running: true, product: null, done: 0, total: todo.length, day: null, error: null, strict: [] }
    this.job = (async () => {
      for (const [product, day] of todo) {
        this.state.product = product
        this.state.day = day
        await this.timeline(product, day)
        this.state.done += 1
      }
    })()
      .catch((error: unknown) => {
        this.state.error = error instanceof Error ? error.message : String(error)
        this.log(`[lab] preparing the past failed: ${this.state.error}`)
      })
      .finally(() => {
        this.state.running = false
        this.job = null
      })
    return this.status
  }

  /** Waits for the running preparation, if any. */
  async settled(): Promise<void> {
    await this.job
  }

  private async candles(product: string, day: string): Promise<Candle[]> {
    const days = daysBetween(dayOf(dayStart(day) - WARM_DAYS * DAY), day)
    return (await this.archive.days(product, days)).flatMap((d) => d.candles)
  }

  /** Which indicators peek, found once per indicator setup and kept. */
  private async strictSet(product: string, bars: readonly Candle[]): Promise<Set<string>> {
    if (this.strict) return this.strict
    const file = join(this.dir, `peek-${this.hash}.json`)
    const report = peekCheck(product, bars, this.instances, 24)
    this.strict = new Set(report.filter((r) => r.differs > 0).map((r) => r.name))
    await writeFile(file, `${JSON.stringify({ checked: new Date().toISOString(), product, strict: [...this.strict], report }, null, 2)}\n`)
    this.log(`[lab] indicators read minute by minute (they would peek): ${[...this.strict].join(', ') || 'none'}`)
    return this.strict
  }

  /** A day's readings, every minute: from the cache, else computed and kept. */
  async timeline(product: string, day: string): Promise<Map<number, BarRead>> {
    const file = this.readsFile(product, day)
    try {
      return new Map(JSON.parse(gunzipSync(await readFile(file)).toString('utf8')) as [number, BarRead][])
    } catch {
      // Computed below.
    }
    const bars = await this.candles(product, day)
    const strict = await this.strictSet(product, bars)
    const start = dayStart(day)
    const reads = indicatorTimeline(product, bars, this.instances, start - 7_200, strict)
    if (day <= yesterday()) {
      await writeFile(`${file}.tmp`, gzipSync(JSON.stringify([...reads])))
      await rename(`${file}.tmp`, file)
    }
    return reads
  }

  /** A prepared day's rounds, oldest first, each with what could be seen around it. */
  async dayScenes(product: string, day: string): Promise<Scene[]> {
    const [archived, reads, previous] = await Promise.all([
      this.archive.day(product, day),
      this.timeline(product, day),
      this.archive.day(product, dayOf(dayStart(day) - DAY)),
    ])
    const closes = new Map<number, number>([...previous.candles, ...archived.candles].map((c) => [c.time, c.close]))
    const results = previous.rounds.slice(-8).map((r) => r.result)
    return archived.rounds.map((round) => {
      const near = new Map<number, number>()
      const nearReads = new Map<number, BarRead>()
      for (let t = round.open - 7_200; t < round.close; t += 60) {
        const close = closes.get(t)
        if (close !== undefined) near.set(t, close)
        const read = reads.get(t)
        if (read) nearReads.set(t, read)
      }
      const scene: Scene = { round, closes: near, reads: nearReads, before: results.slice(-8).reverse() }
      results.push(round.result)
      return scene
    })
  }

  /** Every round of the prepared days, oldest first (for a few days: a long range goes day by day). */
  async scenes(product: string, days: readonly string[]): Promise<Scene[]> {
    const out: Scene[] = []
    for (const day of this.ready(product, days)) out.push(...(await this.dayScenes(product, day)))
    return out
  }
}
