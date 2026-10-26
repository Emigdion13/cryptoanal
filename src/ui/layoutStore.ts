import { parseInterval } from '../data/intervals'
import type { SplitSizes } from './LayoutGrid'
import type { ChartState, Settings, SyncOptions } from './settings'

/** What a saved chart layout holds, as on TradingView: the charts, their arrangement and sync. */
export interface LayoutContent {
  layout: string
  splits: Record<string, SplitSizes>
  charts: ChartState[]
  active: number
  sync: SyncOptions
}

export interface SavedLayout {
  id: string
  name: string
  updatedAt: number
  content: LayoutContent
}

export function contentOf(s: Settings): LayoutContent {
  return { layout: s.layout, splits: s.splits, charts: s.charts, active: s.active, sync: s.sync }
}

let counter = 0
export function makeLayout(name: string, content: LayoutContent): SavedLayout {
  const id = `${Date.now().toString(36)}${(counter++).toString(36)}`
  return { id, name, updatedAt: Date.now(), content: structuredClone(content) }
}

/** "BTCUSD, ETHUSD · 1D, 1h" for the Load layout list. */
export function summarize(layout: SavedLayout, visible: number): string {
  const charts = layout.content.charts.slice(0, visible)
  const symbols = [...new Set(charts.map((c) => c.symbol.replace('-', '')))]
  const intervals = [...new Set(charts.map((c) => parseInterval(c.interval)?.label ?? c.interval))]
  return `${symbols.join(', ')} · ${intervals.join(', ')}`
}
