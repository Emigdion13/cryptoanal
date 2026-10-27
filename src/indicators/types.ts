import type { IntervalDef } from '../data/intervals'
import type { Candle } from '../data/types'

export type InputValue = number | string | boolean

export interface InputDef {
  key: string
  label: string
  type: 'int' | 'float' | 'source' | 'bool' | 'select' | 'color'
  default: InputValue
  min?: number
  max?: number
  step?: number
  options?: string[]
  /** Left out of the legend title (TradingView hides booleans and some options). */
  hideInTitle?: boolean
  /** Settings dialog section this input sits under, as TradingView's groups. */
  group?: string
  /** Labels for select options, when they differ from the stored values. */
  optionLabels?: Record<string, string>
}

/** 'value': shown in the legend only (a plotshape's 0/1): the indicator draws it as shapes. */
export type PlotKind = 'line' | 'histogram' | 'dots' | 'step' | 'value'

export interface PlotDef {
  key: string
  title: string
  kind: PlotKind
  color: string
  /** Second color for two-tone histograms (falling bars). */
  color2?: string
  width?: number
  /** Off until switched on in Style. */
  hidden?: boolean
}

export interface LevelDef {
  title: string
  value: number
  color: string
  style: 'solid' | 'dashed' | 'dotted'
}

export interface FillDef {
  /** A plot key or a fixed level. */
  from: string | number
  to: string | number
  color: string
  /** Color where `from` is below `to` (the cloud flips). */
  colorBelow?: string
  /** Per-bar colours from the output's `colors[colorsKey]` (Pine's fill with a series colour). */
  colorsKey?: string
}

export type Category = 'Trend' | 'Oscillators' | 'Volume' | 'Volatility' | 'Price Action'

/**
 * Shapes an indicator draws on its pane, positioned by bar index (fractions allowed) and price.
 * 'end' is the newest bar.
 */
export type Drawing =
  | {
      type: 'line'
      x1: number
      y1: number
      x2: number | 'end'
      y2: number
      color: string
      width?: number
      dash?: number[]
      /** Runs on to the price axis, like a price line. */
      extendRight?: boolean
    }
  | {
      type: 'box'
      x1: number
      x2: number | 'end'
      top: number
      bottom: number
      fill: string
      border?: string
      text?: string
      textColor?: string
      textSize?: number
      /** Text at the box's top-left (default) or centred. */
      textAlign?: 'left' | 'center'
    }
  | {
      type: 'text'
      x: number | 'end'
      y: number
      text: string
      color: string
      size?: number
      weight?: number
      align?: 'center' | 'left' | 'right'
      /** Pixels to move the text: negative is up, positive is right. */
      dy?: number
      dx?: number
      /** A filled label behind the text (a badge). */
      bg?: string
    }
  | { type: 'triangle'; x: number; y: number; dir: 'up' | 'down'; color: string; size: number }
  | {
      /**
       * Pine's marks, anchored to a bar's high or low: plotshape triangles and arrows (with
       * their text) and plotarrow's tall entry arrows. `offset` is pixels away from the bar.
       */
      type: 'shape'
      shape: 'triangleUp' | 'triangleDown' | 'arrowUp' | 'arrowDown' | 'plotArrowUp' | 'plotArrowDown' | 'labelUp' | 'labelDown'
      x: number
      y: number
      offset: number
      color: string
      text?: string
    }

/** What an indicator can read besides the chart's own bars. */
export interface ComputeContext {
  /** The chart's interval. */
  interval: IntervalDef
  /** The chart's Coinbase product, e.g. BTC-USD. */
  product: string
  /** Bars of another resolution (seconds), built from Coinbase candles; empty until loaded. */
  feed: (seconds: number) => Candle[]
  /** The chart bar position of a time, with fractions. */
  timeToIndex: (time: number) => number
}

/** Values per bar for each plot; per-bar colors for histograms that change color. */
export interface Output {
  values: Record<string, number[]>
  colors?: Record<string, (string | undefined)[]>
  drawings?: Drawing[]
}

export interface PlotStyle {
  color: string
  color2?: string
  width: number
  visible: boolean
}

export interface IndicatorDef {
  type: string
  name: string
  /** Legend prefix: "RSI", "BB". */
  short: string
  category: Category
  /** Drawn on the price pane (true) or in a pane of its own. */
  overlay: boolean
  /** Its own overlay price scale on the price pane, squeezed to the bottom (volume). */
  ownScale?: boolean
  /** How values print: like prices, as volume, or with two decimals. */
  format: 'price' | 'volume' | 'fixed'
  /** Decimals for 'price' values, when the script sets its own (Pine's precision). */
  precision?: number
  inputs: InputDef[]
  plots: PlotDef[]
  levels?: LevelDef[]
  fills?: FillDef[]
  compute(
    bars: readonly Candle[],
    inputs: Record<string, InputValue>,
    styles: Record<string, PlotStyle>,
    ctx: ComputeContext,
  ): Output
  /** Reads data from outside the bars (Kalshi): redone in full whenever that data changes. */
  external?: boolean
  /** Other resolutions (seconds) it reads through ctx.feed, for these inputs on this chart. */
  feeds?: (inputs: Record<string, InputValue>, chart: IntervalDef) => number[]
}

/** An indicator's floating window (V2's oscillator windows), as saved with the layout. */
export interface FloatingState {
  open: boolean
  /** Where it was dragged to, from the chart's top-left; docked at the top right until then. */
  x?: number
  y?: number
  minimized?: boolean
  /** Bars in the window. */
  bars?: number
}

/** One indicator on one chart, as saved. */
export interface IndicatorInstance {
  id: string
  type: string
  inputs: Record<string, InputValue>
  styles: Record<string, PlotStyle>
  hidden: boolean
  floating?: FloatingState
}
