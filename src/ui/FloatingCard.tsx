import { useCallback, useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { ChartEngine, LegendState } from '../chart/ChartEngine'
import { formatPrice, formatVolume } from '../format'
import type { FloatingState, IndicatorDef, IndicatorInstance } from '../indicators/types'
import {
  buildModel,
  clampBars,
  FLOAT_MAX_BARS,
  FLOAT_MIN_BARS,
  FLOAT_PLOT,
  floatStep,
  isClear,
  verdictAt,
  type FloatLine,
  type FloatModel,
} from './floatingModel'
import { GearIcon, RealtimeIcon } from './icons'

/** The card's width, and where it docks: right of the legend, clear of the price axis. */
export const CARD_WIDTH = 288
const DOCK_RIGHT = 72
/** Below the price legend (its height changes with the overlays), with this much room. */
const DOCK_BELOW_LEGEND = 8
const DOCK_GAP = 8
const DOCK_ROW = 218
/** How close to the chart's edge a card may sit. */
const EDGE = 4

interface Props {
  inst: IndicatorInstance
  def: IndicatorDef
  engine: ChartEngine
  legend: LegendState | null
  title: string
  /** "BTCUSD · 5m". */
  context: string
  intervalSeconds: number | null
  /** Its place among the open cards, for the docked spot before it is dragged. */
  dockIndex: number
  onChange: (patch: Partial<FloatingState>) => void
  onSettings: () => void
}

/**
 * A floating window onto one oscillator, as V2's: a zoomed mini chart of the last bars of the
 * values its pane would plot, the numbers for the bar the crosshair is on, and the call the
 * indicator is read for. It replaces the pane while it is open — one or the other, never both — and
 * docking it puts the pane back. Drag it by the header, minimize it to one line, ± the bars it
 * holds, drag the plot (or ‹ ›) to walk back through history and ⏭ back to the live bar. Where it
 * sits, its size and its minimized state are saved with the layout.
 */
export function FloatingCard({ inst, def, engine, legend, title, context, intervalSeconds, dockIndex, onChange, onSettings }: Props) {
  const state = inst.floating ?? { open: true }
  const bars = clampBars(state.bars)
  const minimized = !!state.minimized
  const snap = engine.indicatorSnapshot(inst.id)
  const ready = !!snap && snap.bars.length > 0
  const boxRef = useRef<HTMLElement>(null)
  const { position, measured, dragging, startDrag } = useCardPosition(boxRef, ready, state, dockIndex, onChange)
  // Scrolled back this many bars from the newest (not saved: a reload opens live, as in V2).
  const [behind, setBehind] = useState(0)
  const [hoverBar, setHoverBar] = useState<number | null>(null)
  const [panning, setPanning] = useState(false)
  const clipId = `float-clip-${useId().replace(/:/g, '')}`

  if (!snap || !ready) return null
  const newest = snap.bars.length - 1
  const maxBehind = Math.max(0, newest - bars + 1)
  const back = Math.min(behind, maxBehind)
  const input = { def, out: snap.out, bars: snap.bars, styles: inst.styles, end: newest - back, count: bars }
  const model = buildModel(input)
  const end = model.start + model.count - 1

  // The bar read: the one hovered in the card, else the chart's crosshair bar, else the newest in view.
  const chartBar = legend && !legend.live ? legend.index : null
  const readIndex = hoverBar !== null ? model.start + hoverBar : (chartBar ?? end)
  const cursor = readIndex >= model.start && readIndex <= end && (hoverBar !== null || chartBar !== null) ? readIndex - model.start : null
  const verdict = verdictAt({ ...input, i: readIndex }, model)
  const values = engine.indicatorValues(inst.id, readIndex)
  const readouts = def.plots
    .filter((p) => p.kind !== 'value' && p.kind !== 'dots')
    .map((p) => {
      const v = values.find((x) => x.key === p.key)
      return v && { key: p.key, label: p.title, text: v.text, color: v.color }
    })
    .filter((r): r is NonNullable<typeof r> => !!r)
    .slice(0, 4)
  const accent = model.lines[0]?.color ?? model.histograms[0]?.colors.at(-1) ?? '#2962ff'
  const tag = hoverBar !== null || chartBar !== null ? 'bar' : back > 0 ? 'history' : 'live'
  const span = intervalSeconds ? spanLabel(intervalSeconds * model.count) : ''
  const endTime = snap.bars[end]?.time

  const pan = (delta: number) => setBehind((b) => Math.max(0, Math.min(maxBehind, Math.min(b, maxBehind) - delta)))
  const zoom = (delta: number) => onChange({ bars: clampBars(bars + delta) })

  const plotX = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return Math.floor(((e.clientX - rect.left) / rect.width) * model.count)
  }
  const startPan = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || !model.count) return
    e.preventDefault()
    const step = e.currentTarget.getBoundingClientRect().width / model.count
    const startX = e.clientX
    let applied = 0
    setPanning(true)
    const move = (ev: PointerEvent) => {
      // Pulling right brings older bars in, as a chart pans.
      const total = Math.round((ev.clientX - startX) / step)
      if (total !== applied) pan(applied - total)
      applied = total
    }
    const stop = () => {
      setPanning(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  const scaleText = (v: number) => (def.format === 'volume' ? formatVolume(v) : scaleLabel(v))
  const primary = model.lines[0] ?? null
  const primaryValue = cursor !== null && primary ? primary.values[cursor] : null
  const plotH = FLOAT_PLOT.height - FLOAT_PLOT.padTop - FLOAT_PLOT.padBottom
  const y = (v: number) => FLOAT_PLOT.padTop + ((model.domain.max - v) / (model.domain.max - model.domain.min || 1)) * plotH
  const markY = primaryValue === null ? null : Math.min(FLOAT_PLOT.height - 7, Math.max(7, y(primaryValue)))

  return (
    <section
      ref={boxRef}
      className={`float-card is-${verdict.tone}${minimized ? ' is-minimized' : ''}${dragging ? ' is-dragging' : ''}`}
      style={{ left: position.x, top: position.y, visibility: measured ? undefined : 'hidden' }}
      aria-label={`${title} window`}
      data-float={inst.id}
    >
      <header className="float-head" onPointerDown={startDrag} onDoubleClick={() => onChange({ minimized: !minimized })}>
        <span className="float-dot" style={{ background: accent, boxShadow: `0 0 6px ${accent}` }} />
        <span className="float-title" title={title}>
          {title}
        </span>
        <span className={`float-tag is-${tag}`} title={tag === 'history' ? `Scrolled back ${back} bars` : undefined}>
          {tag.toUpperCase()}
        </span>
        <span className="float-space" />
        <button title="Settings" onClick={onSettings}>
          <GearIcon size={15} />
        </button>
        {state.x !== undefined && (
          <button title="Back to its corner" onClick={() => onChange({ x: undefined, y: undefined })}>
            <DockIcon />
          </button>
        )}
        <button
          title={minimized ? 'Expand' : 'Minimize'}
          onClick={() => {
            if (!minimized) setBehind(0)
            onChange({ minimized: !minimized })
          }}
        >
          <MinIcon plus={minimized} />
        </button>
        <button title="Dock back into its pane" onClick={() => onChange({ open: false })}>
          <PaneIcon />
        </button>
      </header>

      {minimized ? (
        <div className="float-min-row">
          <b style={{ color: readouts[0]?.color }}>{readouts[0]?.text ?? '—'}</b>
          <span className={`float-verdict tone-${verdict.tone}`}>{verdict.text}</span>
        </div>
      ) : (
        <>
          <p className="float-sub">
            {context} · {model.count} bars{span && ` / ${span}`}
            {back > 0 && endTime ? ` · to ${timeLabel(endTime, intervalSeconds)}` : ''}
          </p>
          <div className="float-plot">
            <svg
              className={`float-svg${panning ? ' is-panning' : ''}`}
              viewBox={`0 0 ${FLOAT_PLOT.width} ${FLOAT_PLOT.height}`}
              onPointerDown={startPan}
              onPointerMove={(e) => !panning && setHoverBar(Math.min(model.count - 1, Math.max(0, plotX(e))))}
              onPointerLeave={() => setHoverBar(null)}
              onWheel={(e) => zoom(e.deltaY > 0 ? floatStep(bars) : -floatStep(bars))}
            >
              <defs>
                <clipPath id={clipId}>
                  <rect width={FLOAT_PLOT.width} height={FLOAT_PLOT.height} />
                </clipPath>
              </defs>
              <Plot model={model} y={y} cursor={cursor} clipId={clipId} />
            </svg>
            <div className="float-axis">
              <span>{scaleText(model.domain.max)}</span>
              {markY !== null && primaryValue !== null && (
                <span className="float-axis-mark" style={{ top: markY }}>
                  {engine.formatValue(def, primaryValue)}
                </span>
              )}
              <span>{scaleText(model.domain.min)}</span>
            </div>
          </div>
          <div className="float-readouts">
            {readouts.map((r) => (
              <span key={r.key} className="float-readout">
                <small>{r.label}</small>
                <b style={{ color: r.color }}>{r.text}</b>
              </span>
            ))}
          </div>
          <div className="float-foot">
            <span className={`float-verdict tone-${verdict.tone}`}>{verdict.text}</span>
            <span className="float-steps">
              <button title="Older bars — or drag the plot to the right" disabled={back >= maxBehind} onClick={() => pan(-Math.max(1, Math.floor(bars / 2)))}>
                ‹
              </button>
              <button title="Newer bars — or drag the plot to the left" disabled={back === 0} onClick={() => pan(Math.max(1, Math.floor(bars / 2)))}>
                ›
              </button>
              {back > 0 && (
                <button className="is-live" title="Back to the live bar" onClick={() => setBehind(0)}>
                  <RealtimeIcon size={12} />
                </button>
              )}
            </span>
            <span className="float-steps">
              <button title="Fewer bars" disabled={bars <= FLOAT_MIN_BARS} onClick={() => zoom(-floatStep(bars))}>
                −
              </button>
              <span>{bars}</span>
              <button title="More bars" disabled={bars >= FLOAT_MAX_BARS} onClick={() => zoom(floatStep(bars))}>
                +
              </button>
            </span>
          </div>
        </>
      )}
    </section>
  )
}

/** Levels, fills, histograms, lines, the indicator's own drawings and the cursor (the phone's cards draw it wider). */
export function Plot({
  model,
  y,
  cursor,
  clipId,
  size = FLOAT_PLOT,
}: {
  model: FloatModel
  y: (v: number) => number
  cursor: number | null
  clipId: string
  size?: { width: number; height: number }
}) {
  const slot = size.width / Math.max(1, model.count)
  const x = (k: number) => k * slot + slot / 2
  const barWidth = Math.min(11, Math.max(1.5, slot * 0.66))
  const base = y(Math.min(model.domain.max, Math.max(model.domain.min, 0)))
  const markSize = Math.min(4.5, Math.max(2.5, slot * 0.4))

  return (
    <g clipPath={`url(#${clipId})`}>
      {model.levels.map((l) => (
        <line
          key={l.value}
          x1={0}
          x2={size.width}
          y1={y(l.value)}
          y2={y(l.value)}
          stroke={l.color}
          strokeDasharray={l.dashed ? '3 3' : undefined}
          opacity={0.7}
        />
      ))}
      {model.centered && <line x1={0} x2={size.width} y1={y(0)} y2={y(0)} stroke="#787b86" opacity={0.35} />}
      {model.fills.map((f, n) =>
        f.from.map((a0, k) => {
          const a1 = f.from[k + 1]
          const b0 = f.to[k]
          const b1 = f.to[k + 1]
          if (a0 === null || a1 == null || b0 === null || b1 == null) return null
          const color = f.colors?.[k + 1] ?? (f.colorBelow && a1 < b1 ? f.colorBelow : f.color)
          return (
            <polygon
              key={`${n}-${k}`}
              points={`${x(k)},${y(a0)} ${x(k + 1)},${y(a1)} ${x(k + 1)},${y(b1)} ${x(k)},${y(b0)}`}
              fill={color}
            />
          )
        }),
      )}
      {model.boxes.map((b, k) => (
        <rect
          key={`box-${k}`}
          x={x(b.x1)}
          y={y(b.top)}
          width={Math.max(1, x(b.x2) - x(b.x1))}
          height={Math.max(1, y(b.bottom) - y(b.top))}
          fill={b.fill}
        />
      ))}
      {model.histograms.map((h) =>
        h.values.map((v, k) =>
          v === null ? null : (
            <rect
              key={`${h.key}-${k}`}
              x={x(k) - barWidth / 2}
              y={Math.min(y(v), base)}
              width={barWidth}
              height={Math.max(1, Math.abs(y(v) - base))}
              fill={h.colors[k]}
              opacity={cursor === null || cursor === k ? 1 : 0.85}
            />
          ),
        ),
      )}
      {model.lines.map((l) => (
        <PlotLine key={l.key} line={l} x={x} y={y} />
      ))}
      {model.segments.map((s, k) => (
        <line
          key={`seg-${k}`}
          x1={x(s.x1)}
          y1={y(s.y1)}
          x2={x(s.x2)}
          y2={y(s.y2)}
          stroke={s.color}
          strokeWidth={s.width}
          strokeDasharray={s.dash?.join(' ')}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {model.texts.map((t, k) => (
        <text key={`t-${k}`} x={x(t.x)} y={y(t.y) + t.dy * 0.7} fill={t.color} fontSize={7} textAnchor="middle" dominantBaseline="middle">
          {t.text}
        </text>
      ))}
      {model.marks.map((m, k) => {
        const cx = x(m.x)
        const cy = y(m.y)
        const tip = m.up ? cy - markSize : cy + markSize
        const back = m.up ? cy + markSize * 0.7 : cy - markSize * 0.7
        return <polygon key={`m-${k}`} points={`${cx},${tip} ${cx - markSize},${back} ${cx + markSize},${back}`} fill={m.color} />
      })}
      {cursor !== null && (
        <g className="float-cursor">
          <line x1={x(cursor)} x2={x(cursor)} y1={2} y2={size.height - 2} />
          {model.lines
            .filter((l) => l.kind !== 'dots' && l.values[cursor] !== null)
            .map((l) => (
              <circle key={l.key} cx={x(cursor)} cy={y(l.values[cursor]!)} r={2.4} fill={l.colors?.[cursor] ?? l.color} />
            ))}
        </g>
      )}
    </g>
  )
}

/** A line, step line or dots, split into runs where its per-bar colour changes or it has no value. */
function PlotLine({ line, x, y }: { line: FloatLine; x: (k: number) => number; y: (v: number) => number }) {
  if (line.kind === 'dots')
    return (
      <g>
        {line.values.map((v, k) =>
          v === null || isClear(line.colors?.[k]) ? null : (
            <circle key={k} cx={x(k)} cy={y(v)} r={1 + line.width / 2} fill={line.colors?.[k] ?? line.color} />
          ),
        )}
      </g>
    )
  const runs: { color: string; points: string[] }[] = []
  let run: { color: string; points: string[] } | null = null
  let before: string | null = null
  line.values.forEach((v, k) => {
    if (v === null) {
      run = before = null
      return
    }
    const point = `${x(k)},${y(v)}`
    const prev = line.values[k - 1]
    // The segment into this bar, in this bar's colour (a clear one is a gap); a step goes across, then up or down.
    const segment = before === null ? [point] : line.kind === 'step' ? [before, `${x(k)},${y(prev!)}`, point] : [before, point]
    const color = line.colors?.[k] ?? line.color
    if (!run || run.color !== color) runs.push((run = { color, points: segment }))
    else run.points.push(...segment.slice(1))
    before = point
  })
  return (
    <g>
      {runs
        .filter((r) => !isClear(r.color) && r.points.length)
        .map((r, k) => (
          <polyline
            key={k}
            points={r.points.join(' ')}
            fill="none"
            stroke={r.color}
            strokeWidth={line.width}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
    </g>
  )
}

/**
 * Where the card sits: the spot it was dragged to (from the chart's top-left), or docked along the
 * top right until then, always kept inside the chart. When the chart shrinks (another chart in the
 * layout, a side panel) the card is squeezed in, and goes back to its spot once there is room.
 */
function useCardPosition(
  boxRef: React.RefObject<HTMLElement | null>,
  ready: boolean,
  state: FloatingState,
  dockIndex: number,
  onChange: (patch: Partial<FloatingState>) => void,
) {
  const [size, setSize] = useState({ chartW: 0, chartH: 0, w: CARD_WIDTH, h: 0, legend: 0 })
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const box = boxRef.current
    const chart = box?.parentElement
    if (!box || !chart) return
    const legend = chart.querySelector<HTMLElement>('.legend')
    const measure = () =>
      setSize({
        chartW: chart.clientWidth,
        chartH: chart.clientHeight,
        w: box.offsetWidth,
        h: box.offsetHeight,
        legend: legend ? legend.offsetTop + legend.offsetHeight : 0,
      })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(chart)
    observer.observe(box)
    if (legend) observer.observe(legend)
    return () => observer.disconnect()
  }, [boxRef, ready])

  const clamp = useCallback(
    (p: { x: number; y: number }) => ({
      x: Math.round(Math.min(Math.max(EDGE, p.x), Math.max(EDGE, size.chartW - size.w - EDGE))),
      y: Math.round(Math.min(Math.max(EDGE, p.y), Math.max(EDGE, size.chartH - size.h - EDGE))),
    }),
    [size],
  )

  const docked = () => {
    const cols = Math.max(1, Math.floor((size.chartW - DOCK_RIGHT) / (CARD_WIDTH + DOCK_GAP)))
    const col = dockIndex % cols
    const row = Math.floor(dockIndex / cols)
    return { x: size.chartW - DOCK_RIGHT - (col + 1) * CARD_WIDTH - col * DOCK_GAP, y: size.legend + DOCK_BELOW_LEGEND + row * DOCK_ROW }
  }
  const wanted = drag ?? (state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : docked())
  const position = clamp(wanted)

  const startDrag = (e: ReactPointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    const from = { x: e.clientX, y: e.clientY }
    const origin = position
    let last = origin
    const move = (ev: PointerEvent) => {
      last = clamp({ x: origin.x + ev.clientX - from.x, y: origin.y + ev.clientY - from.y })
      setDrag(last)
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      setDrag(null)
      if (last !== origin) onChange({ x: last.x, y: last.y })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  return { position, measured: size.chartW > 0, dragging: drag !== null, startDrag }
}

/** Axis labels are scale, not measurement: a window of MACD needs no four decimals. */
function scaleLabel(value: number): string {
  if (value === 0) return '0'
  const abs = Math.abs(value)
  return formatPrice(value, abs >= 100 ? 0 : abs >= 1 ? 1 : abs >= 0.01 ? 3 : 5)
}

/** 30 bars of 5m: "2.5h". */
function spanLabel(seconds: number): string {
  const trim = (v: number) => String(Math.round(v * 10) / 10)
  const minutes = seconds / 60
  if (minutes < 60) return `${trim(minutes)} min`
  const hours = minutes / 60
  if (hours < 24) return `${trim(hours)}h`
  const days = hours / 24
  return days < 7 ? `${trim(days)}d` : `${trim(days / 7)}w`
}

function timeLabel(time: number, intervalSeconds: number | null): string {
  const d = new Date(time * 1000)
  const date = `${d.getUTCDate()} ${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}`
  if (intervalSeconds !== null && intervalSeconds >= 86400) return date
  return `${date} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

const DockIcon = () => (
  <svg width={14} height={14} viewBox="0 0 14 14" fill="none" stroke="currentColor">
    <path d="M3 7a4 4 0 1 0 1.2-2.9M3 2.5v2.2h2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** A chart with a pane under it, the pane filled: back into the pane. */
const PaneIcon = () => (
  <svg width={14} height={14} viewBox="0 0 14 14" fill="none" stroke="currentColor">
    <rect x="1.5" y="1.5" width="11" height="11" rx="1" />
    <path d="M1.5 8.5h11" />
    <rect x="3" y="10" width="8" height="1.5" fill="currentColor" stroke="none" />
  </svg>
)

const MinIcon = ({ plus }: { plus: boolean }) => (
  <svg width={14} height={14} viewBox="0 0 14 14" fill="none" stroke="currentColor">
    <path d={plus ? 'M3 7h8M7 3v8' : 'M3 7h8'} strokeLinecap="round" />
  </svg>
)
