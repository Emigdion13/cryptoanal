/** One bar. `time` is the bar's open in seconds since the epoch (UTC). */
export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface Product {
  /** Coinbase product id, e.g. BTC-USD. */
  id: string
  base: string
  quote: string
  /** TradingView-style ticker, e.g. BTCUSD. */
  ticker: string
  /** Decimal places of the quote increment. */
  precision: number
}
