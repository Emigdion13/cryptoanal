import { useCallback, useState } from 'react'
import type { ChartType, CursorMode, PriceMode } from '../chart/ChartEngine'
import { createInstance } from '../indicators/catalog'
import type { IndicatorInstance } from '../indicators/types'
import type { SplitSizes } from './LayoutGrid'

/** One chart of the layout. */
export interface ChartState {
  symbol: string
  interval: string
  chartType: ChartType
  priceMode: PriceMode
  indicators: IndicatorInstance[]
}

/** TradingView's "Sync in layout" options. */
export interface SyncOptions {
  symbol: boolean
  interval: boolean
  crosshair: boolean
  time: boolean
}

export interface Settings {
  layout: string
  /** Divider positions per layout, from dragging the borders between charts. */
  splits: Record<string, SplitSizes>
  /** Every chart ever opened in a layout; the layout shows the first few. */
  charts: ChartState[]
  active: number
  sync: SyncOptions
  /** Intervals pinned to the toolbar with the star in the interval menu. */
  favorites: string[]
  cursor: CursorMode
  watchlist: string[]
  watchlistOpen: boolean
}

const KEY = 'cryptoanal.settings.v2'
const OLD_KEY = 'cryptoanal.settings.v1'

export function newChart(from?: Partial<ChartState>): ChartState {
  return {
    symbol: 'BTC-USD',
    interval: '1D',
    chartType: 'candles',
    priceMode: 'normal',
    ...from,
    indicators: from?.indicators ?? [createInstance('volume')],
  }
}

function defaults(): Settings {
  return {
    layout: '1',
    splits: {},
    charts: [newChart()],
    active: 0,
    sync: { symbol: false, interval: false, crosshair: true, time: false },
    favorites: ['1', '5', '15', '60', '240', '1D'],
    cursor: 'cross',
    watchlist: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'DOGE-USD', 'ADA-USD', 'AVAX-USD', 'LINK-USD', 'LTC-USD', 'BCH-USD'],
    watchlistOpen: typeof window !== 'undefined' && window.innerWidth >= 1100,
  }
}

function load(): Settings {
  const base = defaults()
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Settings>
      return { ...base, ...saved, sync: { ...base.sync, ...saved.sync }, charts: saved.charts?.length ? saved.charts : base.charts }
    }
    // The single-chart settings of the first version.
    const old = localStorage.getItem(OLD_KEY)
    if (old) {
      const v1 = JSON.parse(old) as Partial<Omit<Settings, 'charts'> & ChartState>
      const { symbol, interval, chartType, priceMode, favorites, cursor, watchlist, watchlistOpen } = v1
      return {
        ...base,
        charts: [newChart({ symbol, interval, chartType, priceMode })],
        ...(favorites && { favorites }),
        ...(cursor && { cursor }),
        ...(watchlist && { watchlist }),
        ...(watchlistOpen !== undefined && { watchlistOpen }),
      }
    }
  } catch {
    // Private windows and blocked storage just start from the defaults.
  }
  return base
}

/** The chart's settings, remembered in this browser. */
export function useSettings(): [Settings, (patch: Partial<Settings> | ((s: Settings) => Partial<Settings>)) => void] {
  const [settings, setSettings] = useState(load)
  const update = useCallback((patch: Partial<Settings> | ((s: Settings) => Partial<Settings>)) => {
    setSettings((prev) => {
      const next = { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        // Not remembered; the chart still works.
      }
      return next
    })
  }, [])
  return [settings, update]
}
