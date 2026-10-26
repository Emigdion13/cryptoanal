import { useCallback, useState } from 'react'
import type { ChartType, CursorMode, PriceMode } from '../chart/ChartEngine'

export interface Settings {
  symbol: string
  interval: string
  chartType: ChartType
  /** Intervals pinned to the toolbar with the star in the interval menu. */
  favorites: string[]
  priceMode: PriceMode
  cursor: CursorMode
  watchlist: string[]
  watchlistOpen: boolean
}

const KEY = 'cryptoanal.settings.v1'

const DEFAULTS: Settings = {
  symbol: 'BTC-USD',
  interval: '1D',
  chartType: 'candles',
  favorites: ['1', '5', '15', '60', '240', '1D'],
  priceMode: 'normal',
  cursor: 'cross',
  watchlist: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'DOGE-USD', 'ADA-USD', 'AVAX-USD', 'LINK-USD', 'LTC-USD', 'BCH-USD'],
  watchlistOpen: typeof window !== 'undefined' && window.innerWidth >= 1100,
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    // Private windows and blocked storage just start from the defaults.
  }
  return DEFAULTS
}

/** The chart's settings, remembered in this browser. */
export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState(load)
  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
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
