import { useEffect, type RefObject } from 'react'

const COIN_COLORS: Record<string, string> = {
  BTC: '#f7931a',
  ETH: '#627eea',
  SOL: '#9945ff',
  XRP: '#23292f',
  DOGE: '#c2a633',
  ADA: '#0033ad',
  AVAX: '#e84142',
  LINK: '#2a5ada',
  LTC: '#345d9d',
  BCH: '#0ac18e',
  USDT: '#26a17b',
  USDC: '#2775ca',
}

function colorFor(symbol: string): string {
  if (COIN_COLORS[symbol]) return COIN_COLORS[symbol]
  let h = 0
  for (const ch of symbol) h = (h * 31 + ch.charCodeAt(0)) % 360
  return `hsl(${h} 55% 45%)`
}

/** A round coin badge with the ticker's first letter. */
export function CoinLogo({ symbol, size = 18 }: { symbol: string; size?: number }) {
  return (
    <span
      className="coin-logo"
      style={{ width: size, height: size, background: colorFor(symbol), fontSize: Math.round(size * 0.55) }}
    >
      {symbol.charAt(0)}
    </span>
  )
}

/** Closes a popup on a click outside `ref` or on Escape. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [ref, open, onClose])
}
