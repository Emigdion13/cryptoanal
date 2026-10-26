import {
  AreaSeries,
  BarSeries,
  BaselineSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  LineType,
  PriceScaleMode,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type MouseEventParams,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import { nextBucket, type IntervalDef } from '../data/intervals'
import type { Candle } from '../data/types'
import { formatCountdown, formatCrosshairTime, formatPrice, formatVolume } from '../format'
import { theme } from '../theme'
import { heikinAshi, nextHeikinAshi } from './heikinAshi'

export type ChartType =
  | 'bars'
  | 'candles'
  | 'hollow'
  | 'heikinAshi'
  | 'line'
  | 'lineMarkers'
  | 'step'
  | 'area'
  | 'baseline'
  | 'columns'

export type PriceMode = 'normal' | 'percent' | 'log'
export type CursorMode = 'cross' | 'dot' | 'arrow'

export interface LegendState {
  bar: Candle
  /** Close of the bar before, for the change figures. */
  prevClose: number | null
  /** The newest bar (no hover). */
  live: boolean
}

interface Events {
  legend: LegendState | null
  needMore: void
  autoScale: boolean
  /** True while the newest bar is on screen. */
  realtime: boolean
}

const RIGHT_OFFSET = 8
const DEFAULT_SPACING = 6
// The volume label is opaque; these match the 50% volume bars over black.
const VOLUME_LABEL = { up: '#13534d', down: '#782a28' }

const asTime = (t: number) => t as UTCTimestamp

/**
 * TradingView's own chart engine (lightweight-charts), tuned to look and move like
 * tradingview.com: its colors and margins, its wheel/drag/fling behavior, the last-price label
 * with the bar countdown, and the volume overlay.
 */
export class ChartEngine {
  readonly chart: IChartApi
  private main: ISeriesApi<SeriesType> | null = null
  private volume: ISeriesApi<'Histogram'>
  private type: ChartType = 'candles'
  private bars: Candle[] = []
  private ha: Candle[] = []
  private def: IntervalDef | null = null
  private precision = 2
  private priceMode: PriceMode = 'normal'
  private hoverIndex: number | null = null
  private crosshairY: number | null = null
  private listeners = new Map<keyof Events, Set<(v: never) => void>>()
  private lastAuto = true
  private lastRealtime = true
  private priceLabel: HTMLDivElement
  private volumeLabel: HTMLDivElement
  private labelKey = ''
  private volumeKey = ''
  private raf = 0
  private cleanup: (() => void)[] = []

  constructor(private host: HTMLElement) {
    this.chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: theme.panel },
        textColor: theme.textDim,
        fontSize: 12,
        fontFamily: theme.font,
        attributionLogo: true,
      },
      grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
      rightPriceScale: {
        borderVisible: false,
        minimumWidth: 64,
        // TradingView's margins: the candles use nearly the whole pane.
        scaleMargins: { top: 0.1, bottom: 0.08 },
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: RIGHT_OFFSET,
        barSpacing: DEFAULT_SPACING,
        minBarSpacing: 0.3,
        // TradingView holds the newest bar in place on wheel zoom (Ctrl+wheel zooms at the mouse).
        rightBarStaysOnScroll: true,
        shiftVisibleRangeOnNewBar: true,
      },
      // A flung drag keeps gliding and slows down.
      kineticScroll: { mouse: true, touch: true },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: theme.crosshair,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: theme.crosshairLabel,
        },
        horzLine: {
          color: theme.crosshair,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: theme.crosshairLabel,
        },
      },
      handleScroll: { vertTouchDrag: false },
      localization: {
        locale: 'en-US',
        timeFormatter: (t: Time) => formatCrosshairTime(t as number, this.def?.intraday ?? true),
      },
    })

    // Volume first, so the price series draws on top of it.
    this.volume = this.chart.addSeries(HistogramSeries, {
      priceScaleId: 'volume',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    })
    this.chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.75, bottom: 0 } })
    this.createMain()

    this.priceLabel = this.makeLabel()
    this.volumeLabel = this.makeLabel()

    this.chart.subscribeCrosshairMove(this.onCrosshair)
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(this.onRange)
    this.bindPointer()
    const loop = () => {
      this.paintLabels()
      this.watchScale()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  destroy() {
    cancelAnimationFrame(this.raf)
    for (const fn of this.cleanup) fn()
    this.chart.remove()
    this.priceLabel.remove()
    this.volumeLabel.remove()
  }

  on<K extends keyof Events>(event: K, fn: (value: Events[K]) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, (set = new Set()))
    set.add(fn as (v: never) => void)
    return () => set!.delete(fn as (v: never) => void)
  }

  private emit<K extends keyof Events>(event: K, value: Events[K]) {
    for (const fn of this.listeners.get(event) ?? []) (fn as (v: Events[K]) => void)(value)
  }

  // ── data ────────────────────────────────────────────────────────────────

  setInterval(def: IntervalDef) {
    this.def = def
    this.chart.applyOptions({ timeScale: { timeVisible: def.intraday } })
  }

  setPrecision(precision: number) {
    if (precision === this.precision) return
    this.precision = precision
    this.main?.applyOptions({ priceFormat: this.priceFormat() })
  }

  /**
   * Replaces the bars. `keep` holds the view where it is (history was added on the left or a gap
   * filled on the right); otherwise the chart jumps to the newest bar on auto-fit.
   */
  setBars(bars: Candle[], keep: boolean) {
    const before = this.bars
    const range = this.chart.timeScale().getVisibleLogicalRange()
    const atRealtime = this.isAtRealtime()
    this.bars = bars
    this.ha = this.type === 'heikinAshi' ? heikinAshi(bars) : []
    this.applyData()

    if (!keep || !before.length || !range) {
      this.chart.priceScale('right').applyOptions({ autoScale: true })
      this.chart.timeScale().scrollToPosition(RIGHT_OFFSET, false)
    } else {
      const shift = Math.max(0, bars.findIndex((b) => b.time === before[0].time))
      if (atRealtime && shift === 0) this.chart.timeScale().scrollToPosition(RIGHT_OFFSET, false)
      else this.chart.timeScale().setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift })
    }
    this.hoverIndex = null
    this.emitLegend()
  }

  /** The live bar changed, or a new one opened. */
  updateLast(bar: Candle) {
    const n = this.bars.length
    if (!n || bar.time < this.bars[n - 1].time) return
    if (bar.time === this.bars[n - 1].time) this.bars[n - 1] = bar
    else this.bars.push(bar)
    const i = this.bars.length - 1
    if (this.type === 'heikinAshi') {
      this.ha.length = i
      this.ha.push(nextHeikinAshi(bar, this.ha[i - 1]))
    }
    this.main?.update(this.point(i))
    this.volume.update(this.volumePoint(i))
    if (this.hoverIndex === null) this.emitLegend()
  }

  getBars(): readonly Candle[] {
    return this.bars
  }

  // ── appearance ──────────────────────────────────────────────────────────

  setChartType(type: ChartType) {
    if (type === this.type) return
    this.type = type
    if (this.main) this.chart.removeSeries(this.main)
    this.createMain()
    this.ha = type === 'heikinAshi' ? heikinAshi(this.bars) : []
    this.applyData()
  }

  setPriceMode(mode: PriceMode) {
    this.priceMode = mode
    this.chart.priceScale('right').applyOptions({
      mode:
        mode === 'log'
          ? PriceScaleMode.Logarithmic
          : mode === 'percent'
            ? PriceScaleMode.Percentage
            : PriceScaleMode.Normal,
    })
    // The custom label shows prices; in percent mode the engine's own label shows percents.
    this.main?.applyOptions({ lastValueVisible: mode === 'percent' })
  }

  setAutoScale(on: boolean) {
    this.chart.priceScale('right').applyOptions({ autoScale: on })
    this.watchScale()
  }

  setCursor(mode: CursorMode) {
    const lines = mode === 'cross'
    this.chart.applyOptions({
      crosshair: { vertLine: { visible: lines }, horzLine: { visible: lines } },
    })
    this.host.dataset.cursor = mode
  }

  // ── navigation ──────────────────────────────────────────────────────────

  scrollToRealtime() {
    this.chart.timeScale().scrollToRealTime()
  }

  /** Alt+R: newest bar, default zoom, prices on auto. */
  reset() {
    this.chart.applyOptions({ timeScale: { barSpacing: DEFAULT_SPACING } })
    this.chart.timeScale().scrollToPosition(RIGHT_OFFSET, false)
    this.setAutoScale(true)
  }

  /** Arrow keys: move by `bars` (negative = back in time). */
  scrollBy(bars: number) {
    const ts = this.chart.timeScale()
    ts.scrollToPosition(ts.scrollPosition() + bars, false)
  }

  zoomBy(factor: number) {
    const spacing = this.chart.timeScale().options().barSpacing
    this.chart.applyOptions({ timeScale: { barSpacing: Math.max(0.3, Math.min(60, spacing * factor)) } })
  }

  /** Shows the bars from `from` (seconds) to the newest one. */
  showFrom(from: number) {
    if (!this.bars.length) return
    let i = this.bars.findIndex((b) => b.time >= from)
    if (i < 0) i = this.bars.length - 1
    const last = this.bars.length - 1
    this.chart.timeScale().setVisibleLogicalRange({ from: i - 0.5, to: last + 2 })
    this.setAutoScale(true)
  }

  /** A PNG of the chart with the price label and title drawn in. */
  screenshot(title: string): HTMLCanvasElement {
    const canvas = this.chart.takeScreenshot(true, false)
    const ctx = canvas.getContext('2d')!
    const ratio = canvas.width / this.host.clientWidth
    ctx.save()
    ctx.scale(ratio, ratio)
    ctx.font = `14px ${theme.font}`
    ctx.fillStyle = theme.text
    ctx.textBaseline = 'top'
    ctx.fillText(title, 10, 10)
    for (const el of [this.priceLabel, this.volumeLabel]) {
      if (el.style.display === 'none') continue
      const x = parseFloat(el.style.left),
        y = parseFloat(el.style.top)
      ctx.fillStyle = el.style.backgroundColor
      ctx.fillRect(x, y, el.offsetWidth, el.offsetHeight)
      ctx.fillStyle = '#ffffff'
      ctx.font = `12px ${theme.font}`
      el.innerText.split('\n').forEach((line, k) => ctx.fillText(line, x + 7, y + 3 + k * 15))
    }
    ctx.restore()
    return canvas
  }

  // ── internals ───────────────────────────────────────────────────────────

  private priceFormat() {
    return {
      type: 'custom' as const,
      formatter: (p: number) => formatPrice(p, this.precision),
      minMove: 10 ** -this.precision,
    }
  }

  private createMain() {
    const common = {
      priceFormat: this.priceFormat(),
      lastValueVisible: this.priceMode === 'percent',
      priceLineVisible: true,
      priceLineStyle: LineStyle.Dotted,
      priceLineWidth: 1 as const,
    }
    const { up, down } = theme
    const lineOptions = { ...common, color: theme.line, lineWidth: 2 as const }
    switch (this.type) {
      case 'bars':
        this.main = this.chart.addSeries(BarSeries, { ...common, upColor: up, downColor: down, thinBars: true })
        break
      case 'hollow':
        this.main = this.chart.addSeries(CandlestickSeries, {
          ...common,
          upColor: 'rgba(0, 0, 0, 0)',
          downColor: down,
          borderVisible: true,
          borderUpColor: up,
          borderDownColor: down,
          wickUpColor: up,
          wickDownColor: down,
        })
        break
      case 'line':
        this.main = this.chart.addSeries(LineSeries, lineOptions)
        break
      case 'lineMarkers':
        this.main = this.chart.addSeries(LineSeries, { ...lineOptions, pointMarkersVisible: true, pointMarkersRadius: 3 })
        break
      case 'step':
        this.main = this.chart.addSeries(LineSeries, { ...lineOptions, lineType: LineType.WithSteps })
        break
      case 'area':
        this.main = this.chart.addSeries(AreaSeries, {
          ...common,
          lineColor: theme.line,
          lineWidth: 2,
          topColor: 'rgba(41, 98, 255, 0.28)',
          bottomColor: 'rgba(41, 98, 255, 0.05)',
        })
        break
      case 'baseline':
        this.main = this.chart.addSeries(BaselineSeries, {
          ...common,
          topLineColor: up,
          topFillColor1: 'rgba(8, 153, 129, 0.28)',
          topFillColor2: 'rgba(8, 153, 129, 0.05)',
          bottomLineColor: down,
          bottomFillColor1: 'rgba(242, 54, 69, 0.05)',
          bottomFillColor2: 'rgba(242, 54, 69, 0.28)',
          lineWidth: 2,
        })
        break
      case 'columns':
        this.main = this.chart.addSeries(HistogramSeries, { ...common, base: 0 })
        break
      default:
        // Candles and Heikin Ashi.
        this.main = this.chart.addSeries(CandlestickSeries, {
          ...common,
          upColor: up,
          downColor: down,
          borderVisible: false,
          wickUpColor: up,
          wickDownColor: down,
        })
    }
    this.labelKey = ''
  }

  private source(): Candle[] {
    return this.type === 'heikinAshi' ? this.ha : this.bars
  }

  private point(i: number) {
    const b = this.source()[i]
    const time = asTime(b.time)
    switch (this.type) {
      case 'line':
      case 'lineMarkers':
      case 'step':
      case 'area':
      case 'baseline':
        return { time, value: b.close }
      case 'columns': {
        const prev = this.bars[i - 1]?.close ?? b.open
        return { time, value: b.close, color: b.close >= prev ? theme.up : theme.down }
      }
      default:
        return { time, open: b.open, high: b.high, low: b.low, close: b.close }
    }
  }

  private volumePoint(i: number) {
    const b = this.bars[i]
    return {
      time: asTime(b.time),
      value: b.volume,
      color: b.close >= b.open ? theme.volumeUp : theme.volumeDown,
    }
  }

  private applyData() {
    if (!this.main) return
    const n = this.bars.length
    this.main.setData(Array.from({ length: n }, (_, i) => this.point(i)))
    this.volume.setData(Array.from({ length: n }, (_, i) => this.volumePoint(i)))
    if (this.type === 'baseline' && n) {
      // TradingView's baseline sits at the middle of the recent range.
      const recent = this.bars.slice(-200)
      const hi = Math.max(...recent.map((b) => b.high)),
        lo = Math.min(...recent.map((b) => b.low))
      this.main.applyOptions({ baseValue: { type: 'price', price: (hi + lo) / 2 } })
    }
  }

  private isAtRealtime(): boolean {
    const range = this.chart.timeScale().getVisibleLogicalRange()
    return !range || range.to >= this.bars.length - 1
  }

  private emitLegend() {
    const i = this.hoverIndex ?? this.bars.length - 1
    const bar = this.bars[i]
    this.emit('legend', bar ? { bar, prevClose: this.bars[i - 1]?.close ?? null, live: this.hoverIndex === null } : null)
  }

  private onCrosshair = (param: MouseEventParams<Time>) => {
    this.crosshairY = param.point ? param.point.y : null
    const logical = param.logical
    const i =
      param.point && logical !== undefined && logical !== null && logical >= 0 && logical < this.bars.length
        ? Math.round(logical)
        : null
    if (i === this.hoverIndex) return
    this.hoverIndex = i
    this.emitLegend()
  }

  private onRange = (range: LogicalRange | null) => {
    if (!range) return
    if (range.from < 50 && this.bars.length) this.emit('needMore', undefined)
  }

  /** Polled every frame: range events can arrive between a setData and the scroll after it. */
  private watchScale() {
    const auto = this.chart.priceScale('right').options().autoScale
    if (auto !== this.lastAuto) {
      this.lastAuto = auto
      this.emit('autoScale', auto)
    }
    const realtime = this.isAtRealtime()
    if (realtime !== this.lastRealtime) {
      this.lastRealtime = realtime
      this.emit('realtime', realtime)
    }
  }

  private makeLabel(): HTMLDivElement {
    const el = document.createElement('div')
    el.className = 'axis-label'
    el.style.display = 'none'
    this.host.appendChild(el)
    return el
  }

  private barEnd(time: number): number {
    return this.def ? nextBucket(this.def, time) : time
  }

  /** The last-price label with the countdown, and the volume label, on the price axis. */
  private paintLabels() {
    const n = this.bars.length
    const main = this.main
    const paneHeight = this.chart.panes()[0]?.getHeight() ?? 0
    if (!n || !main || this.priceMode === 'percent' || !paneHeight) {
      this.priceLabel.style.display = this.volumeLabel.style.display = 'none'
      this.labelKey = this.volumeKey = ''
      return
    }
    const left = this.chart.timeScale().width()
    const width = this.chart.priceScale('right').width()
    const shown = this.source()[n - 1]
    const bar = this.bars[n - 1]

    const y = main.priceToCoordinate(shown.close)
    const countdown = formatCountdown(this.barEnd(bar.time) - Date.now() / 1000)
    const lineType = this.type === 'line' || this.type === 'lineMarkers' || this.type === 'step' || this.type === 'area'
    const rising =
      this.type === 'columns' || this.type === 'baseline'
        ? shown.close >= (this.bars[n - 2]?.close ?? shown.open)
        : shown.close >= shown.open
    const color = lineType ? theme.line : rising ? theme.up : theme.down
    const height = 34
    const top = y === null ? null : Math.min(Math.max(y - height / 2, 0), paneHeight - height)
    const hidden = top === null || (this.crosshairY !== null && Math.abs(this.crosshairY - (y ?? 0)) < height / 2 + 9)
    const key = hidden ? 'hidden' : `${left}|${width}|${top}|${color}|${shown.close}|${countdown}`
    if (key !== this.labelKey) {
      this.labelKey = key
      const el = this.priceLabel
      if (hidden) el.style.display = 'none'
      else {
        el.style.display = 'block'
        el.style.left = `${left}px`
        el.style.top = `${top}px`
        el.style.width = `${width}px`
        el.style.backgroundColor = color
        el.textContent = `${formatPrice(shown.close, this.precision)}\n${countdown}`
      }
    }

    const vy = this.volume.priceToCoordinate(bar.volume)
    const vHeight = 19
    const vTop = vy === null ? null : Math.min(Math.max(vy - vHeight / 2, 0), paneHeight - vHeight)
    const vHidden =
      vTop === null ||
      (top !== null && !hidden && vTop < top + height && vTop + vHeight > top) ||
      (this.crosshairY !== null && Math.abs(this.crosshairY - (vy ?? 0)) < vHeight / 2 + 9)
    const vColor = bar.close >= bar.open ? VOLUME_LABEL.up : VOLUME_LABEL.down
    const vKey = vHidden ? 'hidden' : `${left}|${width}|${vTop}|${vColor}|${bar.volume}`
    if (vKey !== this.volumeKey) {
      this.volumeKey = vKey
      const el = this.volumeLabel
      if (vHidden) el.style.display = 'none'
      else {
        el.style.display = 'block'
        el.style.left = `${left}px`
        el.style.top = `${vTop}px`
        el.style.width = `${width}px`
        el.style.backgroundColor = vColor
        el.textContent = formatVolume(bar.volume)
      }
    }
  }

  /**
   * TradingView-style pointer handling on top of the engine's own:
   * - A vertical drag on an auto-fit scale takes it off auto and moves prices like a map
   *   (the engine alone only scrolls a manual scale).
   * - The wheel over the price axis stretches prices; Ctrl+wheel zooms time around the mouse.
   */
  private bindPointer() {
    const host = this.host
    const chart = this.chart
    const hit = (event: MouseEvent): 'plot' | 'axis' | null => {
      const rect = host.getBoundingClientRect()
      const x = event.clientX - rect.left,
        y = event.clientY - rect.top
      const width = chart.timeScale().width(),
        height = chart.panes()[0]?.getHeight() ?? 0
      if (y < 0 || y > height || x < 0) return null
      return x <= width ? 'plot' : 'axis'
    }

    let drag: { id: number; y: number; range: { from: number; to: number } | null } | null = null
    const onDown = (event: PointerEvent) => {
      drag = null
      if (event.button !== 0 || hit(event) !== 'plot' || this.priceMode === 'percent') return
      if (!chart.priceScale('right').options().autoScale) return
      drag = { id: event.pointerId, y: event.clientY, range: null }
    }
    const onMove = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId || !(event.buttons & 1)) return
      const scale = chart.priceScale('right')
      const height = chart.panes()[0]?.getHeight() ?? 0
      if (height <= 0) return
      if (!drag.range) {
        // A sideways drag wobbles a little: keep auto-fit until the move is clearly vertical.
        if (Math.abs(event.clientY - drag.y) < 6) return
        const range = scale.getVisibleRange()
        if (!range) return
        drag = { ...drag, y: event.clientY, range }
        scale.applyOptions({ autoScale: false })
      }
      const { from, to } = drag.range!
      const shift = (event.clientY - drag.y) / height
      if (this.priceMode === 'log' && from > 0 && to > 0) {
        const span = Math.log(to) - Math.log(from)
        scale.setVisibleRange({
          from: Math.exp(Math.log(from) + shift * span),
          to: Math.exp(Math.log(to) + shift * span),
        })
      } else scale.setVisibleRange({ from: from + shift * (to - from), to: to + shift * (to - from) })
    }
    const onUp = () => (drag = null)

    let anchorTimer: ReturnType<typeof setTimeout> | undefined
    const onWheel = (event: WheelEvent) => {
      if (hit(event) === 'axis' && event.deltaY) {
        event.preventDefault()
        event.stopPropagation()
        const step = Math.min(1, Math.abs(event.deltaY) / 100)
        this.zoomPrice(event.deltaY > 0 ? 1 + 0.1 * step : 1 / (1 + 0.1 * step))
        return
      }
      if (event.ctrlKey) {
        chart.timeScale().applyOptions({ rightBarStaysOnScroll: false })
        // The engine handles this same event after us; restore the anchor once it has.
        clearTimeout(anchorTimer)
        anchorTimer = setTimeout(() => chart.timeScale().applyOptions({ rightBarStaysOnScroll: true }))
      }
    }

    host.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    host.addEventListener('wheel', onWheel, { capture: true, passive: false })
    this.cleanup.push(() => {
      host.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      host.removeEventListener('wheel', onWheel, { capture: true })
      clearTimeout(anchorTimer)
    })
  }

  private zoomPrice(factor: number) {
    const scale = this.chart.priceScale('right')
    const range = scale.getVisibleRange()
    if (!range) return
    scale.applyOptions({ autoScale: false })
    if (this.priceMode === 'log' && range.from > 0 && range.to > 0) {
      const lo = Math.log(range.from),
        hi = Math.log(range.to)
      const mid = (lo + hi) / 2,
        half = ((hi - lo) / 2) * factor
      scale.setVisibleRange({ from: Math.exp(mid - half), to: Math.exp(mid + half) })
    } else {
      const mid = (range.from + range.to) / 2,
        half = ((range.to - range.from) / 2) * factor
      scale.setVisibleRange({ from: mid - half, to: mid + half })
    }
  }
}
