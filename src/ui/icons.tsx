import type { ReactNode, SVGProps } from 'react'
import type { ChartType, CursorMode } from '../chart/ChartEngine'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 28, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      {...rest}
    >
      {children}
    </svg>
  )
}

export const SearchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12.5" cy="12.5" r="5.5" />
    <path d="M16.5 16.5 21 21" strokeLinecap="round" />
  </Icon>
)

export const PlusIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 7v14M7 14h14" />
  </Icon>
)

export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m8 8 12 12M20 8 8 20" />
  </Icon>
)

export const ChevronDown = (p: IconProps) => (
  <Icon size={16} viewBox="0 0 16 16" {...p}>
    <path d="m4 6.5 4 4 4-4" />
  </Icon>
)

export const ChevronRight = (p: IconProps) => (
  <Icon size={16} viewBox="0 0 16 16" {...p}>
    <path d="m6.5 4 4 4-4 4" />
  </Icon>
)

export const StarIcon = ({ filled, ...p }: IconProps & { filled?: boolean }) => (
  <Icon size={18} viewBox="0 0 18 18" {...p} fill={filled ? '#f7c948' : 'none'} stroke={filled ? '#f7c948' : 'currentColor'}>
    <path d="m9 2.2 2 4.3 4.6.5-3.4 3.2.9 4.6L9 12.5l-4.1 2.3.9-4.6-3.4-3.2 4.6-.5z" strokeLinejoin="round" />
  </Icon>
)

export const FullscreenIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 11V7h4M17 7h4v4M21 17v4h-4M11 21H7v-4" />
  </Icon>
)

export const CameraIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 10.5A1.5 1.5 0 0 1 7.5 9h2.6l1.4-2h5l1.4 2h2.6a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 6 18.5z" />
    <circle cx="14" cy="14.5" r="3" />
  </Icon>
)

export const WatchlistIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 8.5h14M7 14h14M7 19.5h9" />
    <path d="m19.5 17.5 1.2 2.3 2.3.3-1.7 1.6.4 2.3-2.2-1.1-2.1 1.1.4-2.3-1.7-1.6 2.3-.3z" strokeLinejoin="round" />
  </Icon>
)

export const RealtimeIcon = (p: IconProps) => (
  <Icon size={18} viewBox="0 0 18 18" strokeWidth={1.5} {...p}>
    <path d="m5 5 4 4-4 4M10 5l4 4-4 4" />
  </Icon>
)

export const EyeIcon = ({ off, ...p }: IconProps & { off?: boolean }) => (
  <Icon size={18} viewBox="0 0 18 18" {...p}>
    <path d="M1.5 9S4.2 4 9 4s7.5 5 7.5 5-2.7 5-7.5 5-7.5-5-7.5-5z" />
    <circle cx="9" cy="9" r="2.2" />
    {off && <path d="m3 15 12-12" />}
  </Icon>
)

export const GearIcon = (p: IconProps) => (
  <Icon size={18} viewBox="0 0 18 18" {...p}>
    <circle cx="9" cy="9" r="2.2" />
    <path d="M7.6 2h2.8l.4 1.9 1.4.8 1.8-.7 1.4 2.4-1.5 1.3v1.6l1.5 1.3-1.4 2.4-1.8-.7-1.4.8-.4 1.9H7.6l-.4-1.9-1.4-.8-1.8.7-1.4-2.4 1.5-1.3V8.1L2.6 6.8 4 4.4l1.8.7 1.4-.8z" strokeLinejoin="round" />
  </Icon>
)

export const FxIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13 8.5c-1.6-.6-3 .2-3.3 2L8.5 20.5c-.3 1.8-1.7 2.6-3.3 2M6.5 12.5h6" strokeLinecap="round" />
    <path d="m15.5 13 6 7M21.5 13l-6 7" strokeLinecap="round" />
  </Icon>
)

export const LayoutIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="6.5" y="7.5" width="15" height="13" rx="1.5" />
    <path d="M14 7.5v13M6.5 14h7.5" />
  </Icon>
)

export const MenuIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 9h14M7 14h14M7 19h14" />
  </Icon>
)

// ── cursors ───────────────────────────────────────────────────────────────

export const CURSOR_ICONS: Record<CursorMode, (p: IconProps) => ReactNode> = {
  cross: (p) => (
    <Icon {...p}>
      <path d="M14 5v18M5 14h18" />
    </Icon>
  ),
  dot: (p) => (
    <Icon {...p}>
      <circle cx="14" cy="14" r="2.5" fill="currentColor" />
    </Icon>
  ),
  arrow: (p) => (
    <Icon {...p}>
      <path d="M10 6.5v14l3.6-3.4 2.5 5.4 2-1-2.5-5.2h4.9z" strokeLinejoin="round" />
    </Icon>
  ),
}

// ── chart types ───────────────────────────────────────────────────────────

const candle = (x: number, top: number, bottom: number, wickTop: number, wickBottom: number, fill: boolean) => (
  <g>
    <path d={`M${x + 2} ${wickTop}v${top - wickTop}M${x + 2} ${bottom}v${wickBottom - bottom}`} />
    <rect x={x} y={top} width="4" height={bottom - top} fill={fill ? 'currentColor' : 'none'} />
  </g>
)

export const CHART_TYPE_ICONS: Record<ChartType, (p: IconProps) => ReactNode> = {
  bars: (p) => (
    <Icon {...p}>
      <path d="M10 7v13M8 9h2M10 17h2M18 9v13M16 18h2M18 11h2" />
    </Icon>
  ),
  candles: (p) => (
    <Icon {...p}>
      {candle(8, 9, 18, 6, 21, true)}
      {candle(16, 11, 17, 8, 22, false)}
    </Icon>
  ),
  hollow: (p) => (
    <Icon {...p}>
      {candle(8, 9, 18, 6, 21, false)}
      {candle(16, 11, 17, 8, 22, false)}
    </Icon>
  ),
  heikinAshi: (p) => (
    <Icon {...p}>
      {candle(8, 8, 16, 6, 19, false)}
      {candle(16, 12, 19, 10, 22, true)}
    </Icon>
  ),
  line: (p) => (
    <Icon {...p}>
      <path d="m5 19 6-6 4 3 8-9" strokeLinejoin="round" />
    </Icon>
  ),
  lineMarkers: (p) => (
    <Icon {...p}>
      <path d="m6 19 5-6 4 3 7-8" strokeLinejoin="round" />
      <circle cx="11" cy="13" r="1.5" fill="currentColor" />
      <circle cx="15" cy="16" r="1.5" fill="currentColor" />
      <circle cx="6" cy="19" r="1.5" fill="currentColor" />
      <circle cx="22" cy="8" r="1.5" fill="currentColor" />
    </Icon>
  ),
  step: (p) => (
    <Icon {...p}>
      <path d="M5 19h5v-6h5v3h4V8h4" strokeLinejoin="round" />
    </Icon>
  ),
  area: (p) => (
    <Icon {...p}>
      <path d="m5 18 6-6 4 3 8-8v15H5z" fill="currentColor" fillOpacity="0.2" strokeLinejoin="round" />
    </Icon>
  ),
  baseline: (p) => (
    <Icon {...p}>
      <path d="M5 14h18" strokeDasharray="2 2" />
      <path d="m5 17 4-6 5 6 4-9 5 4" strokeLinejoin="round" />
    </Icon>
  ),
  columns: (p) => (
    <Icon {...p}>
      <path d="M7 22v-8h3v8M12.5 22V9h3v13M18 22v-5h3v5" />
    </Icon>
  ),
}
