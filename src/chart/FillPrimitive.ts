import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts'
import type { CanvasRenderingTarget2D } from 'fancy-canvas'

/** One shaded area: between two value arrays (one per bar) or between two fixed levels. */
export interface Fill {
  from: number[] | number
  to: number[] | number
  color: string
  colorBelow?: string
}

/**
 * Shades indicator areas under the lines, like Pine's fill(): the Bollinger cloud, the RSI
 * 30–70 band. Drawn behind the series it is attached to.
 */
export class FillPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null
  private series: ISeriesApi<SeriesType> | null = null
  private requestUpdate: (() => void) | null = null
  private fills: Fill[] = []

  setFills(fills: Fill[]) {
    this.fills = fills
    this.requestUpdate?.()
  }

  attached(param: SeriesAttachedParameter<Time>) {
    this.chart = param.chart as IChartApi
    this.series = param.series
    this.requestUpdate = param.requestUpdate
  }

  detached() {
    this.chart = this.series = this.requestUpdate = null
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [{ zOrder: () => 'bottom', renderer: () => this.renderer }]
  }

  private renderer: IPrimitivePaneRenderer = {
    draw: () => {},
    drawBackground: (target: CanvasRenderingTarget2D) => {
      const chart = this.chart,
        series = this.series
      if (!chart || !series || !this.fills.length) return
      target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
        const ts = chart.timeScale()
        const range = ts.getVisibleLogicalRange()
        for (const fill of this.fills) {
          if (typeof fill.from === 'number' && typeof fill.to === 'number') {
            const a = series.priceToCoordinate(fill.from),
              b = series.priceToCoordinate(fill.to)
            if (a === null || b === null) continue
            ctx.fillStyle = fill.color
            ctx.fillRect(0, Math.min(a, b), mediaSize.width, Math.abs(b - a))
            continue
          }
          if (!range) continue
          const at = (v: number[] | number, i: number) => (typeof v === 'number' ? v : v[i])
          const first = Math.max(0, Math.floor(range.from) - 1)
          const last = Math.ceil(range.to) + 1
          // One polygon per unbroken run of the same color, so no seams show between bars.
          let run: { x: number; yf: number; yt: number }[] = []
          let runColor = ''
          const flush = () => {
            if (run.length > 1) {
              ctx.fillStyle = runColor
              ctx.beginPath()
              run.forEach((p, k) => (k ? ctx.lineTo(p.x, p.yf) : ctx.moveTo(p.x, p.yf)))
              for (let k = run.length - 1; k >= 0; k--) ctx.lineTo(run[k].x, run[k].yt)
              ctx.closePath()
              ctx.fill()
            }
            run = []
          }
          for (let i = first; i <= last; i++) {
            const f = at(fill.from, i),
              t = at(fill.to, i)
            const x = ts.logicalToCoordinate(i as Logical)
            const yf = Number.isFinite(f) ? series.priceToCoordinate(f) : null
            const yt = Number.isFinite(t) ? series.priceToCoordinate(t) : null
            if (x === null || yf === null || yt === null) {
              flush()
              continue
            }
            const color = fill.colorBelow && f < t ? fill.colorBelow : fill.color
            const point = { x, yf, yt }
            if (run.length && color !== runColor) {
              run.push(point)
              flush()
            }
            runColor = color
            run.push(point)
          }
          flush()
        }
      })
    },
  }
}
