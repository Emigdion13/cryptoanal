import { useCallback, useRef, useState, type ReactNode } from 'react'
import type { ChartType } from '../chart/ChartEngine'
import { INTERVAL_MENU, parseInterval, type IntervalGroup } from '../data/intervals'
import type { Product } from '../data/types'
import { useDismiss } from './common'
import { LayoutMenu } from './LayoutMenu'
import { STATUS_LINE_DEFAULTS, type StatusLine, type SyncOptions } from './settings'
import {
  CameraIcon,
  CHART_TYPE_ICONS,
  CheckIcon,
  ChevronDown,
  CloseIcon,
  ChevronRight,
  FloatIcon,
  FullscreenIcon,
  GearIcon,
  FxIcon,
  PlusIcon,
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
  statusLine: StatusLine
  onStatusLine: (statusLine: StatusLine) => void
  /** ⚙ → Phone access: the iPhone page's passcode and switch. */
  onPhoneAccess: () => void
  onIndicators: () => void
  /** The active chart's oscillators, for the Floating menu. */
  floating: { id: string; title: string; open: boolean }[]
  onFloat: (id: string) => void
  onFloatAll: (open: boolean) => void
  /** The active chart's floating chart windows: "BTCUSD · 1h". */
  windows: { id: string; title: string }[]
  onNewWindow: () => void
  onCloseWindow: (id: string) => void
  layout: string
  sync: SyncOptions
  onLayout: (id: string) => void
  onSync: (sync: SyncOptions) => void
  /** The layout name menu and Save button. */
  saveControls: ReactNode
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
      <FloatingMenu
        items={props.floating}
        onToggle={props.onFloat}
        onAll={props.onFloatAll}
        windows={props.windows}
        onNewWindow={props.onNewWindow}
        onCloseWindow={props.onCloseWindow}
      />
      <div className="sep" />
      <div className="header-spacer" />
      <LayoutMenu layout={props.layout} sync={props.sync} onLayout={props.onLayout} onSync={props.onSync} />
      <div className="sep" />
      {props.saveControls}
      <div className="sep" />
      <StatusLineMenu value={props.statusLine} onChange={props.onStatusLine} onPhoneAccess={props.onPhoneAccess} />
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

/**
 * V2's Floating selector: one menu for every floating window of the active chart, with a count of
 * the open ones. It stays open across clicks, so several windows can be flipped in one visit. Under
 * them, the chart windows: other timeframes of the chart, with indicators of their own.
 */
function FloatingMenu(props: {
  items: { id: string; title: string; open: boolean }[]
  onToggle: (id: string) => void
  onAll: (open: boolean) => void
  windows: { id: string; title: string }[]
  onNewWindow: () => void
  onCloseWindow: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)
  const count = props.items.filter((i) => i.open).length + props.windows.length
  const openCards = props.items.filter((i) => i.open).length

  return (
    <div className="dropdown" ref={ref}>
      <button
        className={`tb-btn with-text${open ? ' open' : ''}`}
        onClick={() => setOpen(!open)}
        title="Floating indicator windows"
      >
        <FloatIcon size={22} />
        <span>Floating</span>
        {count > 0 && <span className="tb-count">{count}</span>}
      </button>
      {open && (
        <div className="menu floating-menu">
          <div className="menu-heading">FLOATING WINDOWS</div>
          {props.items.length === 0 && (
            <div className="menu-note wrap">Add an oscillator — RSI, MACD, Stochastic, TMO… — to open it in a window.</div>
          )}
          {props.items.map((item, k) => (
            <div key={item.id} className="menu-item with-icon" onClick={() => props.onToggle(item.id)}>
              <span className="menu-check">{item.open && <CheckIcon />}</span>
              <span className="menu-label">{item.title}</span>
              {k < 9 && <span className="menu-shortcut">Alt+{k + 1}</span>}
            </div>
          ))}
          {props.items.length > 1 && (
            <div className="menu-item with-icon" onClick={() => props.onAll(openCards === 0)}>
              <span className="menu-check" />
              <span className="menu-label">{openCards === 0 ? 'Open all' : 'Close all'}</span>
              <span className="menu-shortcut">Alt+0</span>
            </div>
          )}
          <div className="menu-heading">CHART WINDOWS</div>
          {props.windows.map((w) => (
            <div key={w.id} className="menu-item with-icon">
              <span className="menu-check">
                <CheckIcon />
              </span>
              <span className="menu-label">{w.title}</span>
              <button className="menu-remove" title="Close window" onClick={() => props.onCloseWindow(w.id)}>
                <CloseIcon size={18} />
              </button>
            </div>
          ))}
          <div className="menu-item with-icon" onClick={props.onNewWindow}>
            <span className="menu-check">
              <PlusIcon size={18} />
            </span>
            <span className="menu-label">New chart window</span>
            <span className="menu-shortcut">Alt+W</span>
          </div>
        </div>
      )}
    </div>
  )
}

const STATUS_ROWS: { key: keyof StatusLine; label: string }[] = [
  { key: 'logo', label: 'Logo' },
  { key: 'title', label: 'Title' },
  { key: 'ohlc', label: 'Chart values' },
  { key: 'change', label: 'Bar change values' },
  { key: 'indicatorTitles', label: 'Indicator titles' },
  { key: 'indicatorArgs', label: 'Indicator arguments' },
  { key: 'indicatorValues', label: 'Indicator values' },
]

/**
 * TradingView's chart settings, Status line tab: which parts of the legends show — the symbol's
 * logo and name, its OHLC and change, the indicators' titles, arguments and values. For every
 * chart of the layout.
 */
function StatusLineMenu({
  value,
  onChange,
  onPhoneAccess,
}: {
  value: StatusLine
  onChange: (v: StatusLine) => void
  onPhoneAccess: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)
  const changed = STATUS_ROWS.some(({ key }) => value[key] !== STATUS_LINE_DEFAULTS[key])

  return (
    <div className="dropdown" ref={ref}>
      <button className={`tb-btn icon${open ? ' open' : ''}`} onClick={() => setOpen(!open)} title="Settings">
        <GearIcon size={24} />
      </button>
      {open && (
        <div className="menu status-menu">
          <div className="menu-section static">STATUS LINE</div>
          {STATUS_ROWS.map(({ key, label }) => (
            <label key={key} className="menu-item switch-item">
              <span className="menu-label">{label}</span>
              <input
                type="checkbox"
                className="switch"
                checked={value[key]}
                onChange={(e) => onChange({ ...value, [key]: e.target.checked })}
              />
            </label>
          ))}
          {changed && (
            <div className="menu-item" onClick={() => onChange(STATUS_LINE_DEFAULTS)}>
              <span className="menu-label">Reset to defaults</span>
            </div>
          )}
          <div className="menu-section static">PHONE</div>
          <div
            className="menu-item"
            onClick={() => {
              setOpen(false)
              onPhoneAccess()
            }}
          >
            <span className="menu-label">Phone access…</span>
          </div>
        </div>
      )}
    </div>
  )
}
