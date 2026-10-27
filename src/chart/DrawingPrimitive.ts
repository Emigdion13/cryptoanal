import type {
  IChartApi,
  IPanePrimitive,
  IPrimitivePaneRenderer,
  IPanePrimitivePaneView,
  ISeriesApi,
  Logical,
  PaneAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts'
import type { CanvasRenderingTarget2D } from 'fancy-canvas'
import type { Drawing } from '../indicators/types'
import { theme } from '../theme'

/**
 * An indicator's lines, boxes, labels and arrows (Pine's line.new / box.new / label.new /
 * plotshape), drawn on one pane. Prices are placed on the scale of a reference series of that
 * pane, but the drawings belong to the pane: hiding one of the indicator's lines keeps them.
 * Boxes go behind the candles; everything else on top of them.
 */
export class DrawingPrimitive implements IPanePrimitive<Time> {
  private chart: IChartApi | null = null
  private series: ISeriesApi<SeriesType> | null = null
  private requestUpdate: (() => void) | null = null
  private drawings: Drawing[] = []
  private last = 0

  /** `last` is the newest bar's index, for drawings that run to 'end'. */
  set(drawings: Drawing[], last: number) {
    this.drawings = drawings
    this.last = last
    this.requestUpdate?.()
  }

  constructor(series: ISeriesApi<SeriesType>) {
    this.series = series
  }

  attached(param: PaneAttachedParameter<Time>) {
    this.chart = param.chart as IChartApi
    this.requestUpdate = param.requestUpdate
  }

  detached() {
    this.chart = this.requestUpdate = null
  }

  paneViews(): readonly IPanePrimitivePaneView[] {
    return [
      { zOrder: () => 'bottom', renderer: () => this.back },
      { zOrder: () => 'top', renderer: () => this.front },
    ]
  }

  private x(index: number | 'end'): number | null {
    return this.chart?.timeScale().logicalToCoordinate((index === 'end' ? this.last : index) as Logical) ?? null
  }

  private y(price: number): number | null {
    return Number.isFinite(price) ? (this.series?.priceToCoordinate(price) ?? null) : null
  }

  /** Skips shapes wholly outside the visible bars (with a margin for their labels). */
  private visible(from: number, to: number): boolean {
    const range = this.chart?.timeScale().getVisibleLogicalRange()
    return !range || (to >= range.from - 2 && from <= range.to + 2)
  }

  private back: IPrimitivePaneRenderer = {
    draw: () => {},
    drawBackground: (target: CanvasRenderingTarget2D) => {
      target.useMediaCoordinateSpace(({ context: ctx }) => {
        for (const d of this.drawings) {
          if (d.type !== 'box') continue
          const x2i = d.x2 === 'end' ? this.last : d.x2
          if (!this.visible(Math.min(d.x1, x2i), Math.max(d.x1, x2i))) continue
          const x1 = this.x(d.x1),
            x2 = this.x(d.x2),
            y1 = this.y(d.top),
            y2 = this.y(d.bottom)
          if (x1 === null || x2 === null || y1 === null || y2 === null) continue
          const left = Math.min(x1, x2),
            top = Math.min(y1, y2)
          const width = Math.max(2, Math.abs(x2 - x1)),
            height = Math.max(1, Math.abs(y2 - y1))
          ctx.fillStyle = d.fill
          ctx.fillRect(left, top, width, height)
          if (d.border) {
            ctx.strokeStyle = d.border
            ctx.lineWidth = 1
            ctx.strokeRect(Math.round(left) + 0.5, Math.round(top) + 0.5, Math.round(width), Math.round(height))
          }
          if (d.text) {
            const size = d.textSize ?? 8
            ctx.font = `600 ${size}px ${theme.font}`
            ctx.fillStyle = d.textColor ?? d.border ?? d.fill
            ctx.textBaseline = 'middle'
            if (d.textAlign === 'center') {
              ctx.textAlign = 'center'
              ctx.fillText(d.text, left + width / 2, top + Math.min(height / 2, size + 2))
            } else {
              ctx.textAlign = 'left'
              ctx.fillText(d.text, left + 4, top + Math.min(height / 2, size / 2 + 4))
            }
          }
        }
      })
    },
  }

  private front: IPrimitivePaneRenderer = {
    draw: (target: CanvasRenderingTarget2D) => {
      target.useMediaCoordinateSpace(({ context: ctx }) => {
        for (const d of this.drawings) {
          if (d.type === 'line') {
            const x2i = d.x2 === 'end' ? this.last : d.x2
            if (!this.visible(Math.min(d.x1, x2i), Math.max(d.x1, x2i))) continue
            const x1 = this.x(d.x1),
              x2 = this.x(d.x2),
              y1 = this.y(d.y1),
              y2 = this.y(d.y2)
            if (x1 === null || x2 === null || y1 === null || y2 === null) continue
            ctx.strokeStyle = d.color
            ctx.lineWidth = d.width ?? 1
            ctx.setLineDash(d.dash ?? [])
            ctx.beginPath()
            ctx.moveTo(x1, y1)
            ctx.lineTo(x2, y2)
            ctx.stroke()
            ctx.setLineDash([])
          } else if (d.type === 'text') {
            const xi = d.x === 'end' ? this.last : d.x
            if (!this.visible(xi, xi)) continue
            const x = this.x(d.x),
              y = this.y(d.y)
            if (x === null || y === null) continue
            ctx.font = `${d.weight ?? 600} ${d.size ?? 10}px ${theme.font}`
            ctx.fillStyle = d.color
            ctx.textAlign = d.align ?? 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText(d.text, x, y + (d.dy ?? 0))
          } else if (d.type === 'triangle') {
            if (!this.visible(d.x, d.x)) continue
            const x = this.x(d.x),
              y = this.y(d.y)
            if (x === null || y === null) continue
            const s = d.size
            ctx.fillStyle = d.color
            ctx.beginPath()
            if (d.dir === 'up') {
              ctx.moveTo(x, y - s)
              ctx.lineTo(x + s, y + s * 0.7)
              ctx.lineTo(x - s, y + s * 0.7)
            } else {
              ctx.moveTo(x, y + s)
              ctx.lineTo(x + s, y - s * 0.7)
              ctx.lineTo(x - s, y - s * 0.7)
            }
            ctx.closePath()
            ctx.fill()
          }
        }
      })
    },
  }
}
