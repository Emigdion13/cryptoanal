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

export type PlotKind = 'line' | 'histogram' | 'dots' | 'step'

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
}

export type Category = 'Trend' | 'Oscillators' | 'Volume' | 'Volatility' | 'Price Action'

/**
 * Shapes an indicator draws on its pane, positioned by bar index (fractions allowed) and price.
 * 'end' is the newest bar.
 */
export type Drawing =
  | { type: 'line'; x1: number; y1: number; x2: number | 'end'; y2: number; color: string; width?: number; dash?: number[] }
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
      /** Pixels to move the text: negative is up. */
      dy?: number
    }
  | { type: 'triangle'; x: number; y: number; dir: 'up' | 'down'; color: string; size: number }

/** What an indicator can read besides the chart's own bars. */
export interface ComputeContext {
  /** The chart's interval. */
  interval: IntervalDef
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
  /** Other resolutions (seconds) it reads through ctx.feed, for these inputs on this chart. */
  feeds?: (inputs: Record<string, InputValue>, chart: IntervalDef) => number[]
}

/** One indicator on one chart, as saved. */
export interface IndicatorInstance {
  id: string
  type: string
  inputs: Record<string, InputValue>
  styles: Record<string, PlotStyle>
  hidden: boolean
}
