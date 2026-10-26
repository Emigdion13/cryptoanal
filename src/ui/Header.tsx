import { useCallback, useRef, useState } from 'react'
import type { ChartType } from '../chart/ChartEngine'
import { INTERVAL_MENU, parseInterval, type IntervalGroup } from '../data/intervals'
import type { Product } from '../data/types'
import { useDismiss } from './common'
import { LayoutMenu } from './LayoutMenu'
import type { SyncOptions } from './settings'
import {
  CameraIcon,
  CHART_TYPE_ICONS,
  ChevronDown,
  ChevronRight,
  FullscreenIcon,
  FxIcon,
  SearchIcon,
  StarIcon,
} from './icons'

export const CHART_TYPES: { type: ChartType; name: string }[] = [
  { type: 'bars', name: 'Bars' },
  { type: 'candles', name: 'Candles' },
  { type: 'hollow', name: 'Hollow candles' },
  { type: 'heikinAshi', name: 'Heikin Ashi' },
  { type: 'line', name: 'Line' },
  { type: 'lineMarkers', name: 'Line with markers' },
  { type: 'step', name: 'Step line' },
  { type: 'area', name: 'Area' },
  { type: 'baseline', name: 'Baseline' },
  { type: 'columns', name: 'Columns' },
]

const GROUP_NAMES: Record<IntervalGroup, string> = { minutes: 'Minutes', hours: 'Hours', days: 'Days' }

interface Props {
  product: Product
  interval: string
  favorites: string[]
  chartType: ChartType
  onSymbolSearch: () => void
  onInterval: (id: string) => void
  onFavorites: (ids: string[]) => void
  onChartType: (type: ChartType) => void
  onFullscreen: () => void
  onScreenshot: () => void
  onIndicators: () => void
  layout: string
  sync: SyncOptions
  onLayout: (id: string) => void
  onSync: (sync: SyncOptions) => void
}

export function Header(props: Props) {
  const { product, interval, favorites, chartType } = props
  const current = parseInterval(interval)
  // Favorites in menu order; the current interval shows too when it isn't one.
  const pinned = INTERVAL_MENU.filter((d) => favorites.includes(d.id) || d.id === interval)

  return (
    <header className="header">
      <div className="header-corner">
        <span className="app-mark">CA</span>
      </div>
      <button className="symbol-pill" onClick={props.onSymbolSearch} title="Symbol Search">
        <SearchIcon size={22} />
        <span>{product.ticker}</span>
      </button>
      <div className="sep" />
      <div className="intervals">
        {pinned.map((d) => (
          <button
            key={d.id}
            className={`tb-btn interval-btn${d.id === interval ? ' active' : ''}`}
            onClick={() => props.onInterval(d.id)}
            title={d.name}
          >
            {d.label}
          </button>
        ))}
        <IntervalMenu
          current={current?.id ?? interval}
          favorites={favorites}
          onPick={props.onInterval}
          onFavorites={props.onFavorites}
        />
      </div>
      <div className="sep" />
      <ChartTypeMenu value={chartType} onPick={props.onChartType} />
      <div className="sep" />
      <button className="tb-btn with-text" onClick={props.onIndicators} title="Indicators">
        <FxIcon />
        <span>Indicators</span>
      </button>
      <div className="sep" />
      <div className="header-spacer" />
      <LayoutMenu layout={props.layout} sync={props.sync} onLayout={props.onLayout} onSync={props.onSync} />
      <button className="tb-btn icon" onClick={props.onFullscreen} title="Fullscreen mode">
        <FullscreenIcon />
      </button>
      <button className="tb-btn icon" onClick={props.onScreenshot} title="Take a snapshot">
        <CameraIcon />
      </button>
    </header>
  )
}

function IntervalMenu(props: {
  current: string
  favorites: string[]
  onPick: (id: string) => void
  onFavorites: (ids: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)
  const groups: IntervalGroup[] = ['minutes', 'hours', 'days']

  return (
    <div className="dropdown" ref={ref}>
      <button className={`tb-btn caret${open ? ' open' : ''}`} onClick={() => setOpen(!open)} title="Change interval">
        <ChevronDown />
      </button>
      {open && (
        <div className="menu interval-menu">
          {groups.map((g) => (
            <div key={g}>
              <button
                className="menu-section"
                onClick={() => setCollapsed({ ...collapsed, [g]: !collapsed[g] })}
              >
                {GROUP_NAMES[g].toUpperCase()}
                <span className={`section-chevron${collapsed[g] ? '' : ' down'}`}>
                  <ChevronRight />
                </span>
              </button>
              {!collapsed[g] &&
                INTERVAL_MENU.filter((d) => d.group === g).map((d) => {
                  const fav = props.favorites.includes(d.id)
                  return (
                    <div
                      key={d.id}
                      className={`menu-item${d.id === props.current ? ' selected' : ''}`}
                      onClick={() => {
                        props.onPick(d.id)
                        close()
                      }}
                    >
                      <span className="menu-label">{d.name}</span>
                      <button
                        className={`star${fav ? ' on' : ''}`}
                        title={fav ? 'Remove from favorites' : 'Add to favorites'}
                        onClick={(e) => {
                          e.stopPropagation()
                          props.onFavorites(
                            fav ? props.favorites.filter((f) => f !== d.id) : [...props.favorites, d.id],
                          )
                        }}
                      >
                        <StarIcon filled={fav} />
                      </button>
                    </div>
                  )
                })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ChartTypeMenu({ value, onPick }: { value: ChartType; onPick: (t: ChartType) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)
  const Current = CHART_TYPE_ICONS[value]

  return (
    <div className="dropdown" ref={ref}>
      <button className={`tb-btn icon${open ? ' open' : ''}`} onClick={() => setOpen(!open)} title="Chart type">
        <Current />
      </button>
      {open && (
        <div className="menu">
          {CHART_TYPES.map(({ type, name }) => {
            const TypeIcon = CHART_TYPE_ICONS[type]
            return (
              <div
                key={type}
                className={`menu-item with-icon${type === value ? ' selected' : ''}`}
                onClick={() => {
                  onPick(type)
                  close()
                }}
              >
                <TypeIcon />
                <span className="menu-label">{name}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
