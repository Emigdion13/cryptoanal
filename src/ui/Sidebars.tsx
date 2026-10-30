import { useCallback, useRef, useState, type ReactNode } from 'react'
import type { CursorMode } from '../chart/ChartEngine'
import { TOOLS, type ToolButton } from '../drawings/tools'
import type { DrawingPrefs, MagnetMode } from '../drawings/types'
import { useDismiss } from './common'
import { CURSOR_ICONS, DRAWING_ICONS, WatchlistIcon } from './icons'

const CURSORS: { mode: CursorMode; name: string }[] = [
  { mode: 'cross', name: 'Cross' },
  { mode: 'dot', name: 'Dot' },
  { mode: 'arrow', name: 'Arrow' },
]

/** TradingView's tool buttons, top to bottom. */
const GROUPS: { button: ToolButton; name: string }[] = [
  { button: 'lines', name: 'Trend line tools' },
  { button: 'fib', name: 'Gann and Fibonacci tools' },
  { button: 'patterns', name: 'Patterns' },
  { button: 'forecast', name: 'Forecasting and measurement tools' },
  { button: 'shapes', name: 'Geometric shapes' },
  { button: 'text', name: 'Annotation tools' },
]

/** Each button's tools, under their flyout headings. */
const SECTIONS = new Map(
  GROUPS.map(({ button }) => {
    const sections = new Map<string, typeof TOOLS>()
    for (const t of TOOLS.filter((t) => t.button === button)) sections.set(t.section, [...(sections.get(t.section) ?? []), t])
    return [button, [...sections]] as const
  }),
)

interface Props {
  cursor: CursorMode
  onCursor: (m: CursorMode) => void
  /** The drawing tool the next clicks place, or null for the cursor. */
  tool: string | null
  onTool: (id: string | null) => void
  prefs: DrawingPrefs
  onPrefs: (prefs: DrawingPrefs) => void
  /** The active chart's symbol, for "Remove drawings". */
  ticker: string
  /** How many drawings it has, and all symbols together. */
  count: number
  total: number
  onRemoveAll: (allSymbols: boolean) => void
}

/** The left toolbar: the cursor, the drawing tools, the magnet, and the switches for every drawing. */
export function LeftToolbar(props: Props) {
  const { cursor, tool, prefs, onPrefs } = props
  const [open, setOpen] = useState<string | null>(null)
  /** The tool each button places when clicked: the last one picked from its flyout. */
  const [last, setLast] = useState<Partial<Record<ToolButton, string>>>({})
  const [lastMagnet, setLastMagnet] = useState<Exclude<MagnetMode, 'off'>>(prefs.magnet === 'strong' ? 'strong' : 'weak')
  const ref = useRef<HTMLElement>(null)
  const close = useCallback(() => setOpen(null), [])
  useDismiss(ref, open !== null, close)
  const Current = CURSOR_ICONS[cursor]
  const toggle = (id: string) => setOpen(open === id ? null : id)

  const pick = (button: ToolButton, id: string) => {
    setLast((l) => ({ ...l, [button]: id }))
    props.onTool(id)
    close()
  }

  return (
    <aside className="left-toolbar" ref={ref}>
      <Flyout
        id="cursor"
        open={open}
        onArrow={toggle}
        active={!tool}
        title={CURSORS.find((c) => c.mode === cursor)?.name ?? ''}
        icon={<Current />}
        onClick={() => (tool ? props.onTool(null) : toggle('cursor'))}
      >
        {CURSORS.map(({ mode, name }) => {
          const ModeIcon = CURSOR_ICONS[mode]
          return (
            <div
              key={mode}
              className={`menu-item with-icon${mode === cursor ? ' selected' : ''}`}
              onClick={() => {
                props.onCursor(mode)
                props.onTool(null)
                close()
              }}
            >
              <ModeIcon />
              <span className="menu-label">{name}</span>
            </div>
          )
        })}
      </Flyout>
      <span className="side-sep" />
      {GROUPS.map(({ button, name }) => {
        const sections = SECTIONS.get(button)!
        const current = last[button] ?? sections[0][1][0].id
        const GroupIcon = DRAWING_ICONS[button]
        const inGroup = TOOLS.some((t) => t.id === tool && t.button === button)
        return (
          <Flyout
            key={button}
            id={button}
            open={open}
            onArrow={toggle}
            active={inGroup}
            title={`${name}: ${TOOLS.find((t) => t.id === current)?.name}`}
            icon={<GroupIcon />}
            onClick={() => props.onTool(inGroup ? null : current)}
            wide
          >
            {sections.map(([section, tools]) => (
              <div key={section}>
                <div className="menu-heading">{section}</div>
                {tools.map((t) => (
                  <div key={t.id} className={`menu-item${t.id === tool ? ' selected' : ''}`} onClick={() => pick(button, t.id)}>
                    <span className="menu-label">{t.name}</span>
                  </div>
                ))}
              </div>
            ))}
          </Flyout>
        )
      })}
      <span className="side-sep" />
      <Flyout
        id="magnet"
        open={open}
        onArrow={toggle}
        active={prefs.magnet !== 'off'}
        title={prefs.magnet === 'off' ? 'Magnet' : prefs.magnet === 'weak' ? 'Weak magnet' : 'Strong magnet'}
        icon={<DRAWING_ICONS.magnet />}
        onClick={() => onPrefs({ ...prefs, magnet: prefs.magnet === 'off' ? lastMagnet : 'off' })}
      >
        {(['weak', 'strong'] as const).map((m) => (
          <div
            key={m}
            className={`menu-item${prefs.magnet === m ? ' selected' : ''}`}
            onClick={() => {
              setLastMagnet(m)
              onPrefs({ ...prefs, magnet: m })
              close()
            }}
          >
            <span className="menu-label">{m === 'weak' ? 'Weak magnet' : 'Strong magnet'}</span>
          </div>
        ))}
      </Flyout>
      <button
        className={`side-btn${prefs.stay ? ' active' : ''}`}
        title="Stay in drawing mode"
        onClick={() => onPrefs({ ...prefs, stay: !prefs.stay })}
      >
        <DRAWING_ICONS.stay />
      </button>
      <button
        className={`side-btn${prefs.locked ? ' active' : ''}`}
        title={prefs.locked ? 'Unlock all drawings' : 'Lock all drawings'}
        onClick={() => onPrefs({ ...prefs, locked: !prefs.locked })}
      >
        {prefs.locked ? <DRAWING_ICONS.lock /> : <DRAWING_ICONS.unlock />}
      </button>
      <button
        className={`side-btn${prefs.hidden ? ' active' : ''}`}
        title={prefs.hidden ? 'Show all drawings' : 'Hide all drawings'}
        onClick={() => onPrefs({ ...prefs, hidden: !prefs.hidden })}
      >
        {prefs.hidden ? <DRAWING_ICONS.eyeOff /> : <DRAWING_ICONS.eye />}
      </button>
      <Flyout id="remove" open={open} onArrow={toggle} title="Remove drawings" icon={<DRAWING_ICONS.trash />} onClick={() => toggle('remove')}>
        <div
          className={`menu-item${props.count ? '' : ' disabled'}`}
          onClick={() => {
            if (!props.count) return
            props.onRemoveAll(false)
            close()
          }}
        >
          <span className="menu-label">
            Remove {props.count} drawing{props.count === 1 ? '' : 's'} on {props.ticker}
          </span>
        </div>
        <div
          className={`menu-item${props.total ? '' : ' disabled'}`}
          onClick={() => {
            if (!props.total) return
            props.onRemoveAll(true)
            close()
          }}
        >
          <span className="menu-label">Remove all drawings on every symbol ({props.total})</span>
        </div>
        <div className="menu-heading">Undo with ⌘Z</div>
      </Flyout>
    </aside>
  )
}

/** A toolbar button with a flyout menu, opened by its corner arrow (or by the button, if it says so). */
function Flyout(props: {
  id: string
  open: string | null
  onArrow: (id: string) => void
  onClick: () => void
  active?: boolean
  title: string
  icon: ReactNode
  wide?: boolean
  children: ReactNode
}) {
  return (
    <div className="flyout-anchor">
      <button className={`side-btn${props.active ? ' active' : ''}`} onClick={props.onClick} title={props.title}>
        {props.icon}
        <span
          className="side-arrow hit"
          onClick={(e) => {
            e.stopPropagation()
            props.onArrow(props.id)
          }}
        />
      </button>
      {props.open === props.id && <div className={`menu flyout${props.wide ? ' tools-flyout' : ''}`}>{props.children}</div>}
    </div>
  )
}

/** The right widget bar. */
export function RightToolbar({ watchlistOpen, onWatchlist }: { watchlistOpen: boolean; onWatchlist: () => void }) {
  return (
    <aside className="right-toolbar">
      <button className={`side-btn${watchlistOpen ? ' active' : ''}`} onClick={onWatchlist} title="Watchlist">
        <WatchlistIcon />
      </button>
    </aside>
  )
}
