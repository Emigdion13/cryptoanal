import { useRef, useState } from 'react'
import { SOURCES } from '../indicators/math'
import { defaultInputs, defaultStyles, INDICATOR_BY_TYPE } from '../indicators/catalog'
import type { IndicatorInstance, InputDef, InputValue, PlotStyle } from '../indicators/types'
import { CloseIcon } from './icons'

interface Props {
  inst: IndicatorInstance
  /** Applied as you edit, like TradingView; Cancel puts the original back. */
  onChange: (inst: IndicatorInstance) => void
  onClose: () => void
}

/** "#rrggbb" for the color picker, from hex or rgba(). */
function toHex(color: string): string {
  if (color.startsWith('#')) return color.slice(0, 7)
  const m = /rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/.exec(color)
  if (!m) return '#000000'
  return '#' + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')
}

/** A picked "#rrggbb" with the old color's transparency kept. */
function withAlpha(hex: string, old: string): string {
  const a = /rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(old)?.[1]
  if (!a) return hex
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

function InputField({ def, value, onChange }: { def: InputDef; value: InputValue; onChange: (v: InputValue) => void }) {
  if (def.type === 'bool')
    return <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
  if (def.type === 'source' || def.type === 'select')
    return (
      <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
        {(def.type === 'source' ? SOURCES : def.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  return (
    <input
      type="number"
      value={String(value)}
      min={def.min}
      max={def.max}
      step={def.step ?? (def.type === 'int' ? 1 : 0.1)}
      onChange={(e) => {
        const v = e.target.value === '' ? NaN : Number(e.target.value)
        if (!Number.isFinite(v)) return
        const clamped = Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, v))
        onChange(def.type === 'int' ? Math.round(clamped) : clamped)
      }}
    />
  )
}

/** TradingView's indicator settings: Inputs and Style tabs, Defaults, Cancel, Ok. */
export function IndicatorSettings({ inst, onChange, onClose }: Props) {
  const def = INDICATOR_BY_TYPE.get(inst.type)!
  const original = useRef(inst)
  const [tab, setTab] = useState<'inputs' | 'style'>(def.inputs.length ? 'inputs' : 'style')
  const [draft, setDraft] = useState(inst)

  const apply = (next: IndicatorInstance) => {
    setDraft(next)
    onChange(next)
  }
  const setInput = (key: string, v: InputValue) => apply({ ...draft, inputs: { ...draft.inputs, [key]: v } })
  const setStyle = (key: string, patch: Partial<PlotStyle>) =>
    apply({ ...draft, styles: { ...draft.styles, [key]: { ...draft.styles[key], ...patch } } })
  const cancel = () => {
    onChange(original.current)
    onClose()
  }

  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && cancel()}>
      <div
        className="dialog settings-dialog"
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancel()
          if (e.key === 'Enter') onClose()
        }}
      >
        <div className="dialog-head">
          <span className="dialog-title">{def.name}</span>
          <button className="dialog-close" onClick={cancel} title="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="tabs">
          {def.inputs.length > 0 && (
            <button className={`tab${tab === 'inputs' ? ' active' : ''}`} onClick={() => setTab('inputs')}>
              Inputs
            </button>
          )}
          <button className={`tab${tab === 'style' ? ' active' : ''}`} onClick={() => setTab('style')}>
            Style
          </button>
        </div>
        <div className="settings-body">
          {tab === 'inputs' &&
            def.inputs.map((i) => (
              <label key={i.key} className="field">
                <span>{i.label}</span>
                <InputField def={i} value={draft.inputs[i.key] ?? i.default} onChange={(v) => setInput(i.key, v)} />
              </label>
            ))}
          {tab === 'style' &&
            def.plots.map((p) => {
              const st = draft.styles[p.key]
              return (
                <div key={p.key} className="field style-field">
                  <label className="style-name">
                    <input type="checkbox" checked={st.visible} onChange={(e) => setStyle(p.key, { visible: e.target.checked })} />
                    <span>{p.title}</span>
                  </label>
                  <span className="style-controls">
                    <input
                      type="color"
                      value={toHex(st.color)}
                      title={p.color2 ? 'Growing' : 'Color'}
                      onChange={(e) => setStyle(p.key, { color: withAlpha(e.target.value, st.color) })}
                    />
                    {p.color2 && (
                      <input
                        type="color"
                        value={toHex(st.color2 ?? p.color2)}
                        title="Falling"
                        onChange={(e) => setStyle(p.key, { color2: withAlpha(e.target.value, st.color2 ?? p.color2!) })}
                      />
                    )}
                    {p.kind !== 'histogram' && (
                      <select value={st.width} onChange={(e) => setStyle(p.key, { width: Number(e.target.value) })} title="Thickness">
                        {[1, 2, 3, 4].map((w) => (
                          <option key={w} value={w}>
                            {w}px
                          </option>
                        ))}
                      </select>
                    )}
                  </span>
                </div>
              )
            })}
        </div>
        <div className="dialog-foot">
          <button className="btn ghost" onClick={() => apply({ ...draft, inputs: defaultInputs(def), styles: defaultStyles(def) })}>
            Defaults
          </button>
          <span className="header-spacer" />
          <button className="btn ghost" onClick={cancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={onClose}>
            Ok
          </button>
        </div>
      </div>
    </div>
  )
}
