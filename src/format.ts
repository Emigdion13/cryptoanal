const MINUS = '−'
const formatters = new Map<number, Intl.NumberFormat>()

/** 80,019.66 — grouped, with the product's decimals. */
export function formatPrice(value: number, precision: number): string {
  let f = formatters.get(precision)
  if (!f) {
    f = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    })
    formatters.set(precision, f)
  }
  const text = f.format(Math.abs(value))
  return value < 0 ? MINUS + text : text
}

/** 6.53K, 1.2M — TradingView's volume shorthand. `space` puts a gap before the suffix. */
export function formatVolume(value: number, space = false): string {
  const abs = Math.abs(value)
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ]
  for (const [size, suffix] of units)
    if (abs >= size) return `${trim(value / size)}${space ? ' ' : ''}${suffix}`
  return trim(value)
}

function trim(v: number): string {
  const abs = Math.abs(v)
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6
  return v.toFixed(digits).replace(/\.?0+$/, '') || '0'
}

/** +1.23 or −1.23 with the product's decimals. */
export function formatChange(value: number, precision: number): string {
  return (value > 0 ? '+' : '') + formatPrice(value, precision)
}

/** +0.04% / −0.04% */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0.00%'
  const text = Math.abs(value).toFixed(2) + '%'
  return value > 0 ? '+' + text : value < 0 ? MINUS + text : text
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')

/** Crosshair date label: "Mon 26 Oct '26" and, intraday, "  21:53" (with ":07" on seconds charts). */
export function formatCrosshairTime(sec: number, intraday: boolean, seconds = false): string {
  const d = new Date(sec * 1000)
  const date = `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} '${pad(d.getUTCFullYear() % 100)}`
  if (!intraday) return date
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  return `${date}   ${seconds ? `${time}:${pad(d.getUTCSeconds())}` : time}`
}

/** Time left on the live bar: 02:07:02, 07:02, or 3d 4h for weeks and months. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const days = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (days > 0) return `${days}d ${h}h`
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

export function formatClock(date: Date): string {
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`
}
