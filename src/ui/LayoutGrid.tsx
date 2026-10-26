import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { LayoutDef } from './layouts'

/** Relative sizes of a layout's columns and rows (grid `fr` units). */
export interface SplitSizes {
  cols: number[]
  rows: number[]
}

const GAP = 4
/** No chart gets narrower or shorter than this while dragging. */
const MIN_PX = 120

export function equalSizes(layout: LayoutDef): SplitSizes {
  return { cols: new Array(layout.cols).fill(1), rows: new Array(layout.rows).fill(1) }
}

/** Saved sizes when they fit the layout, else even ones. */
export function sizesFor(layout: LayoutDef, saved: SplitSizes | undefined): SplitSizes {
  return saved && saved.cols.length === layout.cols && saved.rows.length === layout.rows ? saved : equalSizes(layout)
}

/** CSS offset of where track `k` starts, along an axis of tracks with relative sizes `fr`. */
function trackStart(fr: number[], k: number): string {
  const total = fr.reduce((a, b) => a + b, 0)
  const before = fr.slice(0, k).reduce((a, b) => a + b, 0)
  return `calc((100% - ${(fr.length - 1) * GAP}px) * ${before / total} + ${k * GAP}px)`
}

/** CSS offset of where track `k - 1` ends (the far edge when k is the track count). */
function trackEnd(fr: number[], k: number): string {
  return k >= fr.length ? '100%' : `calc(${trackStart(fr, k)} - ${GAP}px)`
}

interface Splitter {
  axis: 'col' | 'row'
  /** The boundary sits before this track (1 … count − 1). */
  track: number
  /** The stretch of the other axis it spans, as track indexes [from, to). */
  from: number
  to: number
}

/**
 * Where the dividers go: one per stretch of a boundary that has charts on both sides. In
 * "1 large left, 2 right" the horizontal divider only runs along the right column.
 */
function splitters(layout: LayoutDef): Splitter[] {
  const out: Splitter[] = []
  const add = (axis: 'col' | 'row', track: number, spans: [number, number][]) => {
    spans.sort((a, b) => a[0] - b[0])
    for (const [from, to] of spans) {
      const last = out[out.length - 1]
      if (last && last.axis === axis && last.track === track && last.to === from) last.to = to
      else out.push({ axis, track, from, to })
    }
  }
  for (let k = 1; k < layout.cols; k++)
    add('col', k, layout.cells.filter((c) => c[3] - 1 === k).map((c) => [c[0] - 1, c[2] - 1]))
  for (let k = 1; k < layout.rows; k++)
    add('row', k, layout.cells.filter((c) => c[2] - 1 === k).map((c) => [c[1] - 1, c[3] - 1]))
  return out
}

interface Props {
  layout: LayoutDef
  sizes: SplitSizes
  /** Called once a drag ends (and on double-click, which evens the split out). */
  onSizes: (sizes: SplitSizes) => void
  children: ReactNode
}

/** The chart grid with TradingView's draggable dividers between charts. */
export function LayoutGrid({ layout, sizes, onSizes, children }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  // While dragging, sizes live here so only this grid re-renders; they're saved on release.
  const [live, setLive] = useState<SplitSizes | null>(null)
  const [dragging, setDragging] = useState<Splitter | null>(null)
  useEffect(() => setLive(null), [layout.id])
  const current = live ?? sizes

  const startDrag = (s: Splitter, event: React.PointerEvent) => {
    if (event.button !== 0 || !ref.current) return
    event.preventDefault()
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture(event.pointerId)
    const rect = ref.current.getBoundingClientRect()
    const key = s.axis === 'col' ? 'cols' : 'rows'
    const fr = [...current[key]]
    const total = fr.reduce((a, b) => a + b, 0)
    const length = (s.axis === 'col' ? rect.width : rect.height) - (fr.length - 1) * GAP
    const perPx = total / length
    const a = fr[s.track - 1],
      b = fr[s.track]
    const min = Math.min(MIN_PX * perPx, (a + b) / 2)
    const start = s.axis === 'col' ? event.clientX : event.clientY
    let latest = current
    setDragging(s)

    const move = (e: PointerEvent) => {
      const delta = ((s.axis === 'col' ? e.clientX : e.clientY) - start) * perPx
      const nextA = Math.min(a + b - min, Math.max(min, a + delta))
      const next = [...fr]
      next[s.track - 1] = nextA
      next[s.track] = a + b - nextA
      latest = { ...current, [key]: next }
      setLive(latest)
    }
    const end = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      setDragging(null)
      onSizes(latest)
      setLive(null)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  const even = (s: Splitter) => {
    const key = s.axis === 'col' ? 'cols' : 'rows'
    const fr = [...sizes[key]]
    const half = (fr[s.track - 1] + fr[s.track]) / 2
    fr[s.track - 1] = fr[s.track] = half
    onSizes({ ...sizes, [key]: fr })
  }

  return (
    <div
      ref={ref}
      className={`layout-grid${dragging ? ` resizing-${dragging.axis}` : ''}`}
      style={{
        gridTemplateColumns: current.cols.map((f) => `minmax(0, ${f}fr)`).join(' '),
        gridTemplateRows: current.rows.map((f) => `minmax(0, ${f}fr)`).join(' '),
      }}
    >
      {children}
      {splitters(layout).map((s) => {
        const along = s.axis === 'col' ? current.cols : current.rows
        const across = s.axis === 'col' ? current.rows : current.cols
        const at = trackStart(along, s.track)
        const from = trackStart(across, s.from)
        const to = trackEnd(across, s.to)
        const style =
          s.axis === 'col'
            ? { left: `calc(${at} - ${GAP}px)`, top: from, height: `calc(${to} - ${from})` }
            : { top: `calc(${at} - ${GAP}px)`, left: from, width: `calc(${to} - ${from})` }
        const active = dragging?.axis === s.axis && dragging.track === s.track
        return (
          <div
            key={`${s.axis}${s.track}-${s.from}`}
            className={`splitter ${s.axis}${active ? ' active' : ''}`}
            style={style}
            title="Drag to resize · double-click to even out"
            onPointerDown={(e) => startDrag(s, e)}
            onDoubleClick={() => even(s)}
          />
        )
      })}
    </div>
  )
}
