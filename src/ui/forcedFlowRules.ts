/**
 * The Forced flow window's labels and rules (from btcAnalyzerV2), kept out of the component so they
 * test without a browser.
 */
import { LIQUIDATION_BURST_USD, type ForcedFlow, type ForcedState } from '../data/forcedFlow'

/**
 * The transparency bar's value as a whole percent, 0 (solid) to 100 (gone), in steps of 5. The
 * whole box fades, text included. Anything stored that isn't a number reads as solid.
 */
export function forcedBoxTransparency(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.round(Math.min(100, Math.max(0, value)) / 5) * 5
}

/**
 * Liquidations in the last minute from here wake a faded box before the state turns: a quarter of
 * the $100K a minute that names a cascade.
 */
export const WAKE_LIQUIDATION_USD = LIQUIDATION_BURST_USD / 4

/** Why a faded box has come back to solid. */
export type ForcedBoxWake = 'liquidating' | 'liquidations-building' | 'price-moving'

export const FORCED_BOX_WAKE_LABEL: Record<ForcedBoxWake, string> = {
  liquidating: 'Liquidations',
  'liquidations-building': 'Liquidations building',
  'price-moving': 'Price moving',
}

/**
 * Whether the box should show itself whatever its transparency: liquidations happening (a long or
 * short squeeze), liquidations building up in the last minute, or price being pushed (a big 5m
 * move, with or without new positions). Calm and warming up leave it faded.
 */
export function forcedBoxWake(flow: ForcedFlow | null): ForcedBoxWake | null {
  if (!flow) return null
  if (flow.state === 'longs-liquidating' || flow.state === 'shorts-liquidating') return 'liquidating'
  if (flow.liquidations.longUsd + flow.liquidations.shortUsd >= WAKE_LIQUIDATION_USD) return 'liquidations-building'
  if (flow.state === 'big-move' || flow.state === 'new-longs' || flow.state === 'new-shorts') return 'price-moving'
  return null
}

export type ForcedTone = 'down' | 'up' | 'notice' | 'quiet'

/** The box's headline per state. */
export const FORCED_STATE_LABEL: Record<ForcedState, string> = {
  'longs-liquidating': 'Longs being liquidated',
  'shorts-liquidating': 'Shorts being squeezed',
  'new-shorts': 'New shorts opening',
  'new-longs': 'New longs opening',
  'big-move': 'Big move, leverage steady',
  calm: 'No forced flow',
  'warming-up': 'Collecting open interest',
}

/** The box's pill per state. */
export const FORCED_STATE_PILL: Record<ForcedState, string> = {
  'longs-liquidating': 'Forced selling',
  'shorts-liquidating': 'Forced buying',
  'new-shorts': 'New positions',
  'new-longs': 'New positions',
  'big-move': 'Big move',
  calm: 'Calm',
  'warming-up': 'Warming up',
}

/** The box's colour per state: down (longs flushed), up (shorts squeezed), notice or quiet. */
export const forcedTone = (state: ForcedState): ForcedTone =>
  state === 'longs-liquidating'
    ? 'down'
    : state === 'shorts-liquidating'
      ? 'up'
      : state === 'new-shorts' || state === 'new-longs' || state === 'big-move'
        ? 'notice'
        : 'quiet'

/** A signed USD notional as a trader scans it: "+$1.2M", "-$20.0M", "+$100K". */
export function formatNotional(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  const abs = Math.abs(value)
  if (abs < 1000) return `${sign}$${Math.round(abs)}`
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ]
  for (const [scale, suffix] of units) {
    if (abs >= scale) {
      const scaled = abs / scale
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2
      return `${sign}$${scaled.toFixed(digits)}${suffix}`
    }
  }
  return `${sign}$${Math.round(abs)}`
}

/** "$91,234.50"; small coins get more digits. */
export function usd(value: number | null | undefined, precision?: number): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  const digits = precision ?? (abs < 0.0001 ? 8 : abs < 0.01 ? 6 : abs < 1 ? 5 : abs < 10 ? 4 : 2)
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

/**
 * The perpetuals a chart's market is read against: BTC-USD, or BTC/USD on Chainlink, is "BTC-USD".
 * A market not quoted in dollars has none.
 */
export function forcedFlowProduct(product: { base: string; quote: string }): string | null {
  if (!['USD', 'USDC', 'USDT'].includes(product.quote.toUpperCase())) return null
  const base = product.base.toUpperCase()
  return /^[A-Z0-9]{1,12}$/.test(base) ? `${base}-USD` : null
}

/** A new live long or short squeeze since the last reading: the ones the bell chimes for. */
export function newSqueezes(flow: ForcedFlow | null, seen: Set<string>): string[] {
  if (!flow) return []
  return flow.events.filter((e) => !e.history && !seen.has(e.id)).map((e) => e.id)
}
