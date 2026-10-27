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
import { aggregateSeconds, granularityFor, nextBucket, type IntervalDef } from '../data/intervals'
import type { Candle } from '../data/types'
import { formatCountdown, formatCrosshairTime, formatPrice, formatVolume } from '../format'
import { defaultInputs, INDICATOR_BY_TYPE } from '../indicators/catalog'
import type { ComputeContext, IndicatorDef, IndicatorInstance, Output } from '../indicators/types'
import { DrawingPrimitive } from './DrawingPrimitive'
import { theme } from '../theme'
import { FillPrimitive, type Fill } from './FillPrimitive'
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
  /** Index of `bar`; indicator values are read at the same index. */
  index: number
  /** Close of the bar before, for the change figures. */
  prevClose: number | null
  /** The newest bar (no hover). */
  live: boolean
}

export interface PaneRect {
  top: number
  height: number
}

export interface LegendValue {
  key: string
  text: string
  color: string
}

interface Events {
  legend: LegendState | null
  needMore: void
  autoScale: boolean
  /** True while the newest bar is on screen. */
  realtime: boolean
  /** Where each pane sits in the chart, for the per-pane legends. */
  panes: PaneRect[]
  /** The user moved the crosshair (time null = it left the chart). */
  crosshair: { time: number | null; price: number | null }
  /** The user scrolled or zoomed: the time at the right edge (not when set by alignRightEdge). */
  timeRange: { time: number }
  /** The user dragged a pane separator: relative heights by 'main' / indicator id. */
  paneSizes: Record<string, number>
}

/** A live indicator: its series, last output and what it was computed from. */
interface Runtime {
  inst: IndicatorInstance
  def: IndicatorDef
  series: Map<string, ISeriesApi<SeriesType>>
  out: Output
  fill: FillPrimitive | null
  /** Its boxes (on the pane, behind the candles) and its lines, labels and arrows (on top). */
  drawing: DrawingPrimitive | null
  front: DrawingPrimitive | null
  frontHost: ISeriesApi<SeriesType> | null
  pane: number
  /** Recomputed in full on live updates (reads other timeframes, or draws shapes), so throttled. */
  heavy: boolean
  lastFull: number
  count: number
  inputsKey: string
  stylesKey: string
}

/** The pane heights at a press, and which panes they were. */
interface PaneHeights {
  structure: string
  heights: number[]
}

const RIGHT_OFFSET = 8
const DEFAULT_SPACING = 6
const LEVEL_STYLE = { solid: LineStyle.Solid, dashed: LineStyle.Dashed, dotted: LineStyle.Dotted }

const asTime = (t: number) => t as UTCTimestamp
/** Shown in its floating window rather than in a pane: one or the other, never both. */
const floats = (inst: IndicatorInstance) => !!inst.floating?.open

/** A translucent color as it looks over the black pane, made opaque for an axis label. */
function opaqueOnBlack(color: string): string {
  const m = /rgba\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\s*\)/.exec(color)
  if (!m) return color
  const a = Number(m[4])
  return `rgb(${Math.round(Number(m[1]) * a)}, ${Math.round(Number(m[2]) * a)}, ${Math.round(Number(m[3]) * a)})`
}

/**
 * TradingView's own chart engine (lightweight-charts), tuned to look and move like
 * tradingview.com: its colors and margins, its wheel/drag/fling behavior, the last-price label
 * with the bar countdown, and indicators in the price pane or in panes of their own.
 */
export class ChartEngine {
  readonly chart: IChartApi
  private main: ISeriesApi<SeriesType> | null = null
  private type: ChartType = 'candles'
  private bars: Candle[] = []
  private ha: Candle[] = []
  private def: IntervalDef | null = null
  private precision = 2
  private priceMode: PriceMode = 'normal'
  private cursor: CursorMode = 'cross'
  private hoverIndex: number | null = null
  private crosshairY: number | null = null
  private listeners = new Map<keyof Events, Set<(v: never) => void>>()
  private lastAuto = true
  private lastRealtime = true
  private panesKey = ''
  private priceLabel: HTMLDivElement
  private volumeLabel: HTMLDivElement
  private labelKey = ''
  private volumeKey = ''
  private raf = 0
  private cleanup: (() => void)[] = []

  private instances: IndicatorInstance[] = []
  private runtimes: Runtime[] = []
  private structure = ''
  private indicatorsDirty = false
  /** Saved pane heights, and which pane is which ('main', then indicator ids). */
  private paneSizes: Record<string, number> = {}
  /** Coinbase candles of other granularities, for indicators that read other timeframes. */
  private feeds = new Map<number, { candles: Candle[] }>()
  private product = ''
  private feedCache = new Map<string, { key: string; bars: Candle[] }>()
  private paneIds: string[] = ['main']

  /** Set while this chart is being moved by another one, so it doesn't echo back. */
  private syncing = false
  private applyingRangeUntil = 0
  private horzHidden = false

  constructor(private host: HTMLElement) {
    this.chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: theme.panel },
        textColor: theme.textDim,
        fontSize: 12,
        fontFamily: theme.font,
        attributionLogo: true,
        panes: { separatorColor: '#2b2b2b', separatorHoverColor: 'rgba(41, 98, 255, 0.35)', enableResize: true },
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
    // Swapping the price series must never leave pane 0 empty, or the panes below would shift up.
    this.chart.panes()[0].setPreserveEmptyPane(true)
    this.createMain()

    this.priceLabel = this.makeLabel()
    this.volumeLabel = this.makeLabel()

    this.chart.subscribeCrosshairMove(this.onCrosshair)
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(this.onRange)
    this.bindPointer()
    const loop = () => {
      // Scheduled first: one frame that throws must not stop the chart for good.
      this.raf = requestAnimationFrame(loop)
      if (this.indicatorsDirty) this.syncIndicators()
      this.paintLabels()
      this.watchScale()
      this.watchPanes()
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
    for (const rt of this.runtimes)
      // A script with its own precision (TUX: 4 decimals) keeps it.
      if (rt.def.format === 'price' && rt.def.precision === undefined)
        for (const s of rt.series.values()) s.applyOptions({ priceFormat: this.priceFormat() })
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
    for (const rt of this.runtimes) this.computeRuntime(rt)

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
    // Indicators catch up once per frame, not once per trade.
    if (this.runtimes.length) this.indicatorsDirty = true
    if (this.hoverIndex === null) this.emitLegend()
  }

  getBars(): readonly Candle[] {
    return this.bars
  }

  // ── indicators ──────────────────────────────────────────────────────────

  /** Shows these indicators, in order: overlays on the price pane, the rest in panes below. */
  setIndicators(list: IndicatorInstance[]) {
    this.instances = list
    const structure = list.map((i) => `${i.id}:${i.type}:${floats(i)}`).join('|')
    if (structure !== this.structure) {
      this.structure = structure
      this.rebuildIndicators()
    } else
      this.runtimes.forEach((rt, k) => {
        const inst = list[k]
        rt.inst = inst
        const inputsKey = JSON.stringify(inst.inputs)
        const stylesKey = JSON.stringify(inst.styles) + inst.hidden
        if (inputsKey === rt.inputsKey && stylesKey === rt.stylesKey) return
        rt.inputsKey = inputsKey
        if (stylesKey !== rt.stylesKey) {
          rt.stylesKey = stylesKey
          this.styleRuntime(rt)
        }
        this.computeRuntime(rt)
      })
    this.emitLegend()
  }

  /** Pane heights to use (from a saved layout); applied now and on every rebuild. */
  setPaneSizes(sizes: Record<string, number> | undefined) {
    this.paneSizes = sizes ?? {}
    this.applyPaneSizes()
  }

  private applyPaneSizes() {
    const panes = this.chart.panes()
    const factors = this.paneIds.map((id) => this.paneSizes[id] ?? (id === 'main' ? 3 : 1))
    // No pane under 6% of the chart: one squashed flat by an earlier version comes back usable.
    const floor = factors.reduce((a, b) => a + b, 0) * 0.06
    factors.forEach((f, k) => panes[k]?.setStretchFactor(Math.max(f, floor)))
  }

  /**
   * After a press and release on the chart: if the same panes now have other heights than at the
   * press, a separator was dragged — report the new sizes.
   */
  private checkPaneSizes(before: PaneHeights) {
    const panes = this.chart.panes()
    if (panes.length < 2 || panes.length !== this.paneIds.length || before.structure !== this.structure) return
    const heights = panes.map((p) => p.getHeight())
    if (heights.length !== before.heights.length || heights.every((v, k) => Math.abs(v - before.heights[k]) <= 1)) return
    const h = heights.reduce((a, b) => a + b, 0)
    if (!h) return
    const sizes = Object.fromEntries(this.paneIds.map((id, k) => [id, Math.round((heights[k] / h) * 1000) / 100]))
    this.paneSizes = sizes
    this.applyPaneSizes()
    this.emit('paneSizes', sizes)
  }

  /** Candles of other granularities (live objects: their `candles` grow as trades arrive). */
  setFeeds(feeds: Map<number, { candles: Candle[] }>) {
    this.feeds = feeds
    this.feedCache.clear()
    for (const rt of this.runtimes) if (rt.def.feeds) this.computeRuntime(rt)
    if (this.hoverIndex === null) this.emitLegend()
  }

  setProduct(product: string) {
    if (product === this.product) return
    this.product = product
    for (const rt of this.runtimes) if (rt.def.external) this.computeRuntime(rt)
  }

  /** Outside data an indicator reads (Kalshi) changed: redo those on the next frame. */
  refreshIndicators() {
    if (this.runtimes.some((rt) => rt.def.external)) this.indicatorsDirty = true
  }

  /** A feed candle changed: indicators catch up on the next frame. */
  feedsTicked() {
    if (this.runtimes.some((rt) => rt.def.feeds)) this.indicatorsDirty = true
  }

  /** Bars of `seconds` from the matching feed, rolled up and remembered until the feed moves. */
  private feedBars(seconds: number): Candle[] {
    if (this.def && this.def.kind === 'fixed' && seconds === this.def.seconds) return this.bars
    const g = granularityFor(seconds)
    const source = this.feeds.get(g)?.candles ?? []
    const last = source[source.length - 1]
    const key = `${source.length}:${last?.time}:${last?.close}:${last?.volume}`
    const id = `${g}:${seconds}`
    const hit = this.feedCache.get(id)
    if (hit && hit.key === key) return hit.bars
    const bars = seconds === g ? source.slice() : aggregateSeconds(source, seconds)
    this.feedCache.set(id, { key, bars })
    return bars
  }

  private context(): ComputeContext {
    return {
      interval: this.def ?? { id: '1D', label: 'D', name: '1 day', group: 'days', kind: 'fixed', seconds: 86400, intraday: false },
      product: this.product,
      feed: (seconds) => this.feedBars(seconds),
      timeToIndex: (time) => this.timeToLogical(time) ?? 0,
    }
  }

  /** The indicator's values at the legend's bar, ready to print. */
  indicatorValues(id: string, index: number): LegendValue[] {
    const rt = this.runtimes.find((r) => r.inst.id === id)
    if (!rt) return []
    return rt.def.plots
      .filter((p) => rt.inst.styles[p.key]?.visible !== false)
      // Signal dots (crosses, divergence circles) only show on the bars that have one.
      .filter((p) => p.kind !== 'dots' || Number.isFinite(rt.out.values[p.key]?.[index]))
      .map((p) => {
        const v = rt.out.values[p.key]?.[index]
        const color = rt.out.colors?.[p.key]?.[index] ?? rt.inst.styles[p.key]?.color ?? p.color
        // TradingView prints na as ∅.
        return { key: p.key, text: Number.isFinite(v) ? this.formatValue(rt.def, v) : '∅', color: opaqueOnBlack(color) }
      })
  }

  /** An indicator's last output and the bars it was computed on, for its floating window. */
  indicatorSnapshot(id: string): { def: IndicatorDef; out: Output; bars: readonly Candle[] } | null {
    const rt = this.runtimes.find((r) => r.inst.id === id)
    return rt ? { def: rt.def, out: rt.out, bars: this.bars } : null
  }

  formatValue(def: IndicatorDef, v: number): string {
    if (def.format === 'volume') return formatVolume(v, true)
    if (def.format === 'price') return formatPrice(v, def.precision ?? this.precision)
    return formatPrice(v, 2)
  }

  private indicatorFormat(def: IndicatorDef) {
    if (def.format === 'volume') return { type: 'volume' as const }
    if (def.format === 'price' && def.precision !== undefined)
      return { type: 'price' as const, precision: def.precision, minMove: 10 ** -def.precision }
    if (def.format === 'price') return this.priceFormat()
    return { type: 'price' as const, precision: 2, minMove: 0.01 }
  }

  private rebuildIndicators() {
    for (const rt of this.runtimes) {
      if (rt.drawing) this.chart.panes()[rt.pane]?.detachPrimitive(rt.drawing)
      if (rt.front && rt.frontHost === this.main) this.main?.detachPrimitive(rt.front)
      for (const s of rt.series.values()) this.chart.removeSeries(s)
    }
    this.runtimes = []
    while (this.chart.panes().length > 1) this.chart.removePane(this.chart.panes().length - 1)

    let nextPane = 1
    this.paneIds = ['main']
    for (const inst of this.instances) {
      const def = INDICATOR_BY_TYPE.get(inst.type)
      if (!def) continue
      // In its floating window instead of a pane: computed for the window, nothing drawn here.
      const floating = !def.overlay && floats(inst)
      const pane = def.overlay ? 0 : floating ? -1 : nextPane++
      if (!def.overlay && !floating) this.paneIds.push(inst.id)
      const rt: Runtime = {
        inst,
        def,
        series: new Map(),
        out: { values: {} },
        fill: null,
        drawing: null,
        front: null,
        frontHost: null,
        pane,
        heavy: false,
        lastFull: 0,
        count: 0,
        inputsKey: JSON.stringify(inst.inputs),
        stylesKey: JSON.stringify(inst.styles) + inst.hidden,
      }
      if (floating) {
        this.runtimes.push(rt)
        this.computeRuntime(rt)
        continue
      }
      for (const plot of def.plots) {
        // Legend-only values have no series of their own.
        if (plot.kind === 'value') continue
        const style = inst.styles[plot.key]
        const common = {
          priceScaleId: def.ownScale ? `ind-${inst.id}` : 'right',
          // The volume scale has no axis; its label is drawn by paintLabels.
          lastValueVisible: !def.ownScale,
          priceLineVisible: false,
          priceFormat: this.indicatorFormat(def),
          visible: !inst.hidden && style?.visible !== false,
        }
        const color = style?.color ?? plot.color
        const width = (style?.width ?? 1) as 1 | 2 | 3 | 4
        let series: ISeriesApi<SeriesType>
        if (plot.kind === 'histogram') series = this.chart.addSeries(HistogramSeries, { ...common, color }, pane)
        else if (plot.kind === 'dots')
          series = this.chart.addSeries(
            LineSeries,
            { ...common, color, lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1 + width / 2, crosshairMarkerVisible: false },
            pane,
          )
        else
          series = this.chart.addSeries(
            LineSeries,
            { ...common, color, lineWidth: width, lineType: plot.kind === 'step' ? LineType.WithSteps : LineType.Simple, crosshairMarkerRadius: 3 },
            pane,
          )
        if (def.ownScale) series.priceScale().applyOptions({ scaleMargins: { top: 0.75, bottom: 0 } })
        rt.series.set(plot.key, series)
      }
      const first = rt.series.values().next().value
      if (first) {
        for (const level of def.levels ?? [])
          first.createPriceLine({
            price: level.value,
            color: level.color,
            lineWidth: 1,
            lineStyle: LEVEL_STYLE[level.style],
            axisLabelVisible: false,
            title: '',
          })
        if (def.fills?.length) {
          rt.fill = new FillPrimitive()
          first.attachPrimitive(rt.fill)
        }
      }
      // Drawings sit on the pane, placed on the scale of the indicator's first line (or the
      // price series for drawing-only overlays such as Smart Money Concepts).
      const reference = rt.series.values().next().value ?? (pane === 0 ? this.main : null)
      const paneApi = this.chart.panes()[pane] ?? (pane === 0 ? null : this.chart.addPane())
      if (reference && paneApi) {
        rt.drawing = new DrawingPrimitive(reference, 'back')
        paneApi.attachPrimitive(rt.drawing)
        rt.front = new DrawingPrimitive(reference, 'front')
        rt.frontHost = reference
        reference.attachPrimitive(rt.front)
      }
      this.runtimes.push(rt)
      this.computeRuntime(rt)
    }

    // TradingView keeps most of the height for prices; each indicator pane gets a slice,
    // unless the layout remembers heights the user dragged.
    this.applyPaneSizes()
  }

  private styleRuntime(rt: Runtime) {
    for (const plot of rt.def.plots) {
      const style = rt.inst.styles[plot.key]
      const series = rt.series.get(plot.key)
      if (!series || !style) continue
      const visible = !rt.inst.hidden && style.visible
      const width = style.width as 1 | 2 | 3 | 4
      if (plot.kind === 'histogram') series.applyOptions({ color: style.color, visible })
      else if (plot.kind === 'dots') series.applyOptions({ color: style.color, visible, pointMarkersRadius: 1 + width / 2 })
      else series.applyOptions({ color: style.color, visible, lineWidth: width })
    }
  }

  private computeRuntime(rt: Runtime) {
    rt.out = rt.def.compute(this.bars, { ...defaultInputs(rt.def), ...rt.inst.inputs }, rt.inst.styles, this.context())
    rt.count = this.bars.length
    rt.lastFull = performance.now()
    rt.heavy = !!rt.def.feeds || !!rt.def.external || !!rt.out.drawings?.length
    for (const [key, series] of rt.series) series.setData(this.bars.map((_, i) => this.indicatorPoint(rt, key, i)))
    this.updateFills(rt)
    const drawings = rt.inst.hidden ? [] : (rt.out.drawings ?? [])
    rt.drawing?.set(drawings, this.bars.length - 1)
    rt.front?.set(drawings, this.bars.length - 1)
  }

  private indicatorPoint(rt: Runtime, key: string, i: number) {
    const time = asTime(this.bars[i].time)
    const v = rt.out.values[key]?.[i]
    if (v === undefined || !Number.isFinite(v)) return { time }
    const color = rt.out.colors?.[key]?.[i]
    return color ? { time, value: v, color } : { time, value: v }
  }

  private updateFills(rt: Runtime) {
    if (!rt.fill) return
    const fills: Fill[] = rt.inst.hidden
      ? []
      : (rt.def.fills ?? []).map((f) => ({
          from: typeof f.from === 'number' ? f.from : (rt.out.values[f.from] ?? []),
          to: typeof f.to === 'number' ? f.to : (rt.out.values[f.to] ?? []),
          color: f.color,
          colorBelow: f.colorBelow,
        }))
    rt.fill.setFills(fills)
  }

  /** Brings indicators up to the live bar: one recompute, then only the last point is sent. */
  private syncIndicators() {
    this.indicatorsDirty = false
    const n = this.bars.length
    // Outside data (Kalshi, other timeframes) can arrive before the chart's own bars.
    if (!n) return
    const now = performance.now()
    for (const rt of this.runtimes) {
      // Shapes and other-timeframe lines can move on any bar: redo them in full, four times a second.
      if (rt.heavy) {
        if (now - rt.lastFull >= 250) this.computeRuntime(rt)
        else this.indicatorsDirty = true
        continue
      }
      if (rt.count !== n) {
        this.computeRuntime(rt)
        continue
      }
      rt.out = rt.def.compute(this.bars, { ...defaultInputs(rt.def), ...rt.inst.inputs }, rt.inst.styles, this.context())
      for (const [key, series] of rt.series) series.update(this.indicatorPoint(rt, key, n - 1))
      this.updateFills(rt)
    }
    if (this.hoverIndex === null) this.emitLegend()
  }

  // ── appearance ──────────────────────────────────────────────────────────

  setChartType(type: ChartType) {
    if (type === this.type) return
    this.type = type
    if (this.main) this.chart.removeSeries(this.main)
    this.createMain()
    this.ha = type === 'heikinAshi' ? heikinAshi(this.bars) : []
    this.applyData()
    // Re-add indicators so they draw on top of the new price series again.
    this.structure = ''
    this.setIndicators(this.instances)
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
    this.cursor = mode
    this.horzHidden = false
    const lines = mode === 'cross'
    this.chart.applyOptions({
      crosshair: { vertLine: { visible: lines }, horzLine: { visible: lines, labelVisible: true } },
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

  // ── sync between charts of a layout ─────────────────────────────────────

  /** Shows another chart's crosshair here. `price` null = a different symbol: vertical line only. */
  syncCrosshair(time: number | null, price: number | null) {
    this.syncing = true
    try {
      const bar = time === null ? undefined : this.barAt(time)
      if (!bar || !this.main) {
        this.chart.clearCrosshairPosition()
        this.showHorzLine(true)
        return
      }
      this.showHorzLine(price !== null)
      this.chart.setCrosshairPosition(price ?? bar.close, asTime(bar.time), this.main)
    } finally {
      this.syncing = false
    }
  }

  /**
   * Follows another chart's scrolling: the same moment at the right edge, at this chart's own
   * zoom, as TradingView's time sync does between different intervals.
   */
  alignRightEdge(time: number) {
    const ts = this.chart.timeScale()
    const range = ts.getVisibleLogicalRange()
    const target = this.timeToLogical(time)
    if (!range || target === null) return
    this.applyingRangeUntil = performance.now() + 150
    ts.setVisibleLogicalRange({ from: target - (range.to - range.from), to: target })
  }

  /** Bar position of a time, with fractions, extended past either end at the interval's pace. */
  private timeToLogical(time: number): number | null {
    const bars = this.bars,
      sec = this.def?.seconds ?? 60
    if (!bars.length) return null
    const last = bars.length - 1
    if (time >= bars[last].time) return last + (time - bars[last].time) / sec
    if (time < bars[0].time) return (time - bars[0].time) / sec
    const bar = this.barAt(time)!
    const i = bars.indexOf(bar)
    return i + Math.min(0.999, (time - bar.time) / sec)
  }

  private logicalToTime(logical: number): number | null {
    const bars = this.bars,
      sec = this.def?.seconds ?? 60
    if (!bars.length) return null
    const last = bars.length - 1
    if (logical >= last) return bars[last].time + (logical - last) * sec
    if (logical < 0) return bars[0].time + logical * sec
    const i = Math.floor(logical)
    return bars[i].time + (logical - i) * sec
  }

  /** The bar holding `time`: the last one that opened at or before it. */
  private barAt(time: number): Candle | undefined {
    const bars = this.bars
    let lo = 0,
      hi = bars.length - 1,
      found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (bars[mid].time <= time) {
        found = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    return found < 0 ? undefined : bars[found]
  }

  private showHorzLine(show: boolean) {
    if (show === !this.horzHidden) return
    this.horzHidden = !show
    this.chart.applyOptions({
      crosshair: { horzLine: { visible: show && this.cursor === 'cross', labelVisible: show } },
    })
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

  private applyData() {
    if (!this.main) return
    const n = this.bars.length
    this.main.setData(Array.from({ length: n }, (_, i) => this.point(i)))
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
    this.emit(
      'legend',
      bar ? { bar, index: i, prevClose: this.bars[i - 1]?.close ?? null, live: this.hoverIndex === null } : null,
    )
  }

  private onCrosshair = (param: MouseEventParams<Time>) => {
    this.crosshairY = param.point && param.paneIndex === 0 ? param.point.y : null
    if (!this.syncing) {
      if (param.sourceEvent) this.showHorzLine(true)
      if (param.sourceEvent || !param.point)
        this.emit('crosshair', {
          time: param.point && param.time !== undefined ? (param.time as number) : null,
          price: param.point && param.paneIndex === 0 && this.main ? this.main.coordinateToPrice(param.point.y) : null,
        })
    }
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
    if (performance.now() < this.applyingRangeUntil) return
    const time = this.logicalToTime(range.to)
    if (time !== null) this.emit('timeRange', { time })
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

  private watchPanes() {
    const hostTop = this.host.getBoundingClientRect().top
    const rects = this.chart.panes().map((p) => {
      const r = p.getHTMLElement()?.getBoundingClientRect()
      return { top: r ? Math.round(r.top - hostTop) : 0, height: r ? Math.round(r.height) : p.getHeight() }
    })
    const key = rects.map((r) => `${r.top}:${r.height}`).join('|')
    if (key === this.panesKey) return
    this.panesKey = key
    this.emit('panes', rects)
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

    // The volume indicator lives on a scale with no axis, so its last value gets a label here.
    const vol = this.runtimes.find((r) => r.def.type === 'volume' && !r.inst.hidden && r.inst.styles.volume?.visible)
    const vSeries = vol?.series.get('volume')
    const vy = vSeries ? vSeries.priceToCoordinate(bar.volume) : null
    const vHeight = 19
    const vTop = vy === null ? null : Math.min(Math.max(vy - vHeight / 2, 0), paneHeight - vHeight)
    const vHidden =
      vTop === null ||
      (top !== null && !hidden && vTop < top + height && vTop + vHeight > top) ||
      (this.crosshairY !== null && Math.abs(this.crosshairY - (vy ?? 0)) < vHeight / 2 + 9)
    const vColor = opaqueOnBlack(vol?.out.colors?.volume?.[n - 1] ?? theme.volumeUp)
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
    // The pane heights when the mouse went down on this chart: a separator may be dragged.
    let pressed: PaneHeights | null = null
    const onDown = (event: PointerEvent) => {
      drag = null
      pressed = { structure: this.structure, heights: chart.panes().map((p) => p.getHeight()) }
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
    const onUp = () => {
      drag = null
      // A pane separator may just have been dragged. Only a press on this chart counts: a click
      // elsewhere (a legend button, the Indicators dialog) can rebuild the panes, and their
      // heights mid-rebuild are not sizes anyone chose.
      const before = pressed
      pressed = null
      if (before) requestAnimationFrame(() => this.checkPaneSizes(before))
    }

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
