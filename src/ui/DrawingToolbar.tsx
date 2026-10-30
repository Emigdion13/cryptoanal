import { useEffect, useRef, useState } from 'react'
import { TOOL_BY_ID } from '../drawings/tools'
import type { LineDash, UserDrawing } from '../drawings/types'
import { useDismiss } from './common'
import { DRAWING_ICONS } from './icons'

/** TradingView's drawing colors. */
const COLORS = [
  '#ffffff', '#b2b5be', '#787b86', '#434651', '#000000',
  '#f23645', '#ff9800', '#ffeb3b', '#4caf50', '#089981',
  '#00bcd4', '#2962ff', '#673ab7', '#9c27b0', '#e91e63',
]
const WIDTHS = [1, 2, 3, 4]
/** The Text tool's width is its font size. */
const FONT_SIZES = [10, 12, 14, 16, 20, 24, 28, 36]
const DASHES: { dash: LineDash; name: string }[] = [
  { dash: 'solid', name: 'Solid' },
  { dash: 'dashed', name: 'Dashed' },
  { dash: 'dotted', name: 'Dotted' },
]

interface Props {
  drawing: UserDrawing
  /** The drawing was just placed: a tool with text starts with its text box focused. */
  fresh: boolean
  onChange: (patch: Partial<UserDrawing>) => void
  onRemove: () => void
}

/** The floating bar over the charts for the selected drawing: its color, line, text, lock and delete. */
export function DrawingToolbar({ drawing: d, fresh, onChange, onRemove }: Props) {
  const tool = TOOL_BY_ID.get(d.tool)
  const [menu, setMenu] = useState<'color' | 'width' | 'dash' | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  useDismiss(ref, menu !== null, () => setMenu(null))

  useEffect(() => {
    if (fresh && tool?.text) textRef.current?.select()
  }, [fresh, tool, d.id])

  if (!tool) return null
  const fontSize = d.tool === 'text'
  const hasFill = tool.defaults?.fill !== undefined
  const locked = !!d.locked
  const opt = (key: string) => !!d.opts?.[key]
  const setOpt = (key: string) => onChange({ opts: { ...d.opts, [key]: !opt(key) } })

  return (
    <div className="drawing-toolbar" ref={ref} onPointerDown={(e) => e.stopPropagation()}>
      <span className="drawing-name">{tool.name}</span>
      <div className="dt-anchor">
        <button className="dt-btn" title="Color" disabled={locked} onClick={() => setMenu(menu === 'color' ? null : 'color')}>
          <span className="dt-swatch" style={{ background: d.color }} />
        </button>
        {menu === 'color' && (
          <div className="dt-menu dt-colors">
            {COLORS.map((c) => (
              <button
                key={c}
                className={`dt-color${c === d.color ? ' on' : ''}`}
                style={{ background: c }}
                title={c}
                onClick={() => {
                  onChange({ color: c })
                  setMenu(null)
                }}
              />
            ))}
          </div>
        )}
      </div>
      <div className="dt-anchor">
        <button className="dt-btn" title={fontSize ? 'Font size' : 'Line width'} disabled={locked} onClick={() => setMenu(menu === 'width' ? null : 'width')}>
          {fontSize ? <span className="dt-text">{d.width}px</span> : <span className="dt-width" style={{ height: d.width }} />}
        </button>
        {menu === 'width' && (
          <div className="dt-menu">
            {(fontSize ? FONT_SIZES : WIDTHS).map((w) => (
              <div
                key={w}
                className={`menu-item${w === d.width ? ' selected' : ''}`}
                onClick={() => {
                  onChange({ width: w })
                  setMenu(null)
                }}
              >
                {fontSize ? `${w}px` : <span className="dt-width wide" style={{ height: w }} />}
              </div>
            ))}
          </div>
        )}
      </div>
      {!fontSize && (
        <div className="dt-anchor">
          <button className="dt-btn" title="Line style" disabled={locked} onClick={() => setMenu(menu === 'dash' ? null : 'dash')}>
            <span className={`dt-dash ${d.dash}`} />
          </button>
          {menu === 'dash' && (
            <div className="dt-menu">
              {DASHES.map(({ dash, name }) => (
                <div
                  key={dash}
                  className={`menu-item${dash === d.dash ? ' selected' : ''}`}
                  onClick={() => {
                    onChange({ dash })
                    setMenu(null)
                  }}
                >
                  <span className={`dt-dash wide ${dash}`} />
                  <span className="menu-label">{name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {hasFill && (
        <button className={`dt-btn${d.fill ? ' on' : ''}`} title="Background" disabled={locked} onClick={() => onChange({ fill: !d.fill })}>
          <DRAWING_ICONS.fill />
        </button>
      )}
      {tool.extendable && (
        <>
          <button className={`dt-btn${opt('extendLeft') ? ' on' : ''}`} title="Extend left" disabled={locked} onClick={() => setOpt('extendLeft')}>
            <DRAWING_ICONS.extendLeft />
          </button>
          <button className={`dt-btn${opt('extendRight') ? ' on' : ''}`} title="Extend right" disabled={locked} onClick={() => setOpt('extendRight')}>
            <DRAWING_ICONS.extendRight />
          </button>
        </>
      )}
      {tool.text && (
        <textarea
          ref={textRef}
          className="dt-input"
          rows={1}
          value={d.text ?? ''}
          placeholder="Text"
          disabled={locked}
          onChange={(e) => onChange({ text: e.target.value })}
          onKeyDown={(e) => {
            // Enter is done; Shift+Enter starts a new line.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              e.currentTarget.blur()
            }
            if (e.key === 'Escape') e.currentTarget.blur()
          }}
        />
      )}
      <span className="dt-sep" />
      <button className={`dt-btn${locked ? ' on' : ''}`} title={locked ? 'Unlock' : 'Lock'} onClick={() => onChange({ locked: !locked })}>
        {locked ? <DRAWING_ICONS.lock /> : <DRAWING_ICONS.unlock />}
      </button>
      <button className="dt-btn" title="Remove" disabled={locked} onClick={onRemove}>
        <DRAWING_ICONS.trash />
      </button>
    </div>
  )
}
