import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  PrimitiveHoveredItem,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts'
import type { CanvasRenderingTarget2D } from 'fancy-canvas'
import type { Candle } from '../data/types'
import type { ForcedEvent } from '../data/forcedFlow'

/** Colours of btcAnalyzerV2's markers: red under a long squeeze, green over a short squeeze. */
const LONGS_COLOR = '#ed6773'
const SHORTS_COLOR = '#2bb99b'
/** Half the triangle's width, px. */
const SIZE = 5
/** Gap between the bar's low (or high) and the triangle's tip, px. */
const GAP = 6
/** Prefix of the hover ids, so the engine can tell a marker from a drawing. */
export const FORCED_MARKER_ID = 'forced-flow:'

/** One marker: the event and the bar it began in. */
export interface PlacedMarker {
  event: ForcedEvent
  index: number
}

/**
 * Which bar each forced-flow event sits on: the bar holding its start, never a neighbour. One
 * marker per bar and side (on a long timeframe several five-minute squeezes share a bar); later
 * events win, so a live event replaces the replayed one on the same bar. As btcAnalyzerV2's chart.
 */
export function placeForcedMarkers(events: readonly ForcedEvent[], bars: readonly Candle[], seconds: number): PlacedMarker[] {
  if (!events.length || !bars.length) return []
  const perBar = new Map<string, PlacedMarker>()
  for (const event of events) {
    let lo = 0,
      hi = bars.length - 1,
      index = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (bars[mid].time <= event.start) {
        index = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    if (index < 0 || event.start >= bars[index].time + seconds) continue
    const key = `${bars[index].time}:${event.state}`
    perBar.delete(key)
    perBar.set(key, { event, index })
  }
  return [...perBar.values()]
}

/** The marker's hover text: "Long squeeze · price −1.24% · OI −0.80% in 5m · $2.1M force-closed". */
export function forcedMarkerTitle(event: ForcedEvent): string {
  const longs = event.state === 'longs-liquidating'
  const pct = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(2)}%`
  const usd = (v: number) =>
    v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}K` : `$${Math.round(v)}`
  return [
    longs ? 'Long squeeze' : 'Short squeeze',
    `price ${pct(event.priceChange)}${event.oiChange !== null ? ` · OI ${pct(event.oiChange)}` : ''} in 5m`,
    event.liquidatedUsd > 0 ? `${usd(event.liquidatedUsd)} force-closed` : '',
    event.history ? 'from Kraken history' : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * Forced flow on the price pane (from btcAnalyzerV2): a small hollow LIQ triangle on the bar where
 * each long or short squeeze began, below the low for longs flushed, above the high for shorts
 * squeezed. Squeezes replayed from Kraken's history are dashed and faded. They explain the wick;
 * they are not a signal.
 */
export class ForcedFlowMarkers implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null
  private series: ISeriesApi<SeriesType> | null = null
  private requestUpdate: (() => void) | null = null
  private events: ForcedEvent[] = []
  /** Where the markers were last drawn, for hover. */
  private drawn: { id: string; x: number; y0: number; y1: number }[] = []

  constructor(
    private source: {
      bars: () => readonly Candle[]
      barSeconds: () => number
    },
  ) {}

  setEvents(events: ForcedEvent[]) {
    if (!events.length && !this.events.length) return
    this.events = events
    this.requestUpdate?.()
  }

  /** The event under a hover id from the chart's crosshair, if it is one of these markers. */
  eventFor(id: unknown): ForcedEvent | undefined {
    if (typeof id !== 'string' || !id.startsWith(FORCED_MARKER_ID)) return undefined
    const eventId = id.slice(FORCED_MARKER_ID.length)
    return this.events.find((e) => e.id === eventId)
  }

  attached(param: SeriesAttachedParameter<Time>) {
    this.chart = param.chart as IChartApi
    this.series = param.series
    this.requestUpdate = param.requestUpdate
  }

  detached() {
    this.chart = this.series = this.requestUpdate = null
    this.drawn = []
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [{ zOrder: () => 'top', renderer: () => this.renderer }]
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    for (const m of this.drawn)
      if (Math.abs(x - m.x) <= SIZE + 2 && y >= m.y0 - 2 && y <= m.y1 + 2)
        return { externalId: FORCED_MARKER_ID + m.id, zOrder: 'top', cursorStyle: 'default' }
    return null
  }

  private renderer: IPrimitivePaneRenderer = {
    draw: (target: CanvasRenderingTarget2D) => {
      const chart = this.chart,
        series = this.series
      this.drawn = []
      if (!chart || !series || !this.events.length) return
      const bars = this.source.bars()
      const placed = placeForcedMarkers(this.events, bars, this.source.barSeconds())
      if (!placed.length) return
      const ts = chart.timeScale()
      target.useMediaCoordinateSpace(({ context: ctx }) => {
        ctx.save()
        ctx.font = "8px 'JetBrains Mono', ui-monospace, monospace"
        ctx.textAlign = 'center'
        for (const { event, index } of placed) {
          const longs = event.state === 'longs-liquidating'
          const bar = bars[index]
          const x = ts.logicalToCoordinate(index as Logical)
          const y = series.priceToCoordinate(longs ? bar.low : bar.high)
          if (x === null || y === null) continue
          const color = longs ? LONGS_COLOR : SHORTS_COLOR
          const tipY = longs ? y + GAP : y - GAP
          const baseY = longs ? tipY + SIZE * 1.6 : tipY - SIZE * 1.6
          const textY = longs ? baseY + 9 : baseY - 3
          ctx.globalAlpha = event.history ? 0.5 : 1
          ctx.strokeStyle = color
          ctx.fillStyle = color
          ctx.lineWidth = 1.2
          ctx.setLineDash(event.history ? [2, 1.5] : [])
          ctx.beginPath()
          ctx.moveTo(x, tipY)
          ctx.lineTo(x - SIZE, baseY)
          ctx.lineTo(x + SIZE, baseY)
          ctx.closePath()
          ctx.stroke()
          ctx.fillText('LIQ', x, textY)
          this.drawn.push({ id: event.id, x, y0: Math.min(tipY, textY - 8), y1: Math.max(tipY, textY) })
        }
        ctx.restore()
      })
    },
  }
}
