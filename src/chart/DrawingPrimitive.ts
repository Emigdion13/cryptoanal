import type {
  IChartApi,
  IPanePrimitive,
  ISeriesPrimitive,
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
 * plotshape), placed on the price scale of a reference series. Two of these per indicator: the
 * 'back' layer (boxes) attached to the pane, behind the candles, and the 'front' layer (lines,
 * labels, arrows) attached to the reference series — a pane primitive's 'top' still draws under
 * the candles, a series primitive's does not.
 */
export class DrawingPrimitive implements IPanePrimitive<Time>, ISeriesPrimitive<Time> {
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

  constructor(
    series: ISeriesApi<SeriesType>,
    private layer: 'back' | 'front',
  ) {
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
    return this.layer === 'back'
      ? [{ zOrder: () => 'bottom', renderer: () => this.back }]
      : [{ zOrder: () => 'top', renderer: () => this.front }]
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
            if (!d.extendRight && !this.visible(Math.min(d.x1, x2i), Math.max(d.x1, x2i))) continue
            const x1 = this.x(d.x1),
              y1 = this.y(d.y1),
              y2 = this.y(d.y2)
            const x2 = d.extendRight ? (this.chart?.timeScale().width() ?? null) : this.x(d.x2)
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
            const size = d.size ?? 10
            let tx = x + (d.dx ?? 0)
            const ty = y + (d.dy ?? 0)
            ctx.font = `${d.weight ?? 600} ${size}px ${theme.font}`
            ctx.textAlign = d.align ?? 'center'
            ctx.textBaseline = 'middle'
            if (d.bg) {
              const w = ctx.measureText(d.text).width + 12,
                h = size + 8
              let left = d.align === 'left' ? tx - 6 : d.align === 'right' ? tx - w + 6 : tx - w / 2
              // A badge stays whole inside the pane: slid left off the price axis when needed.
              const shift = Math.min(0, (this.chart?.timeScale().width() ?? Infinity) - 4 - (left + w))
              left += shift
              tx += shift
              ctx.fillStyle = d.bg
              ctx.beginPath()
              ctx.roundRect(left, ty - h / 2, w, h, 3)
              ctx.fill()
            }
            ctx.fillStyle = d.color
            ctx.fillText(d.text, tx, ty)
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
