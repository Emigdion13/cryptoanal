import type { Candle } from '../data/types'

export type InputValue = number | string | boolean

export interface InputDef {
  key: string
  label: string
  type: 'int' | 'float' | 'source' | 'bool' | 'select'
  default: InputValue
  min?: number
  max?: number
  step?: number
  options?: string[]
  /** Left out of the legend title (TradingView hides booleans and some options). */
  hideInTitle?: boolean
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

export type Category = 'Trend' | 'Oscillators' | 'Volume' | 'Volatility'

/** Values per bar for each plot; per-bar colors for histograms that change color. */
export interface Output {
  values: Record<string, number[]>
  colors?: Record<string, (string | undefined)[]>
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
  compute(bars: readonly Candle[], inputs: Record<string, InputValue>, styles: Record<string, PlotStyle>): Output
}

/** One indicator on one chart, as saved. */
export interface IndicatorInstance {
  id: string
  type: string
  inputs: Record<string, InputValue>
  styles: Record<string, PlotStyle>
  hidden: boolean
}
