import { useState, type ReactNode } from 'react'
import { formatCents, netProfitDollars, sellNowBreakdown, sellNowResult, type TradeOutcome, type TradeTarget } from '../trade/kalshiTrade'
import {
  QUICK_DOLLARS,
  QUICK_AUTO_SELL_UNDER_PCT,
  keypadNumber,
  keypadPress,
  quickBuy,
  quickPlan,
  quickSellFloor,
  quickTarget,
  quickTargets,
  quickAutoSell,
  type QuickTarget,
} from '../trade/quick'
import type { Trade } from './useTrade'

/** The keypad's keys, row by row. */
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'] as const

const word = (outcome: TradeOutcome) => (outcome === 'up' ? 'Up' : 'Down')
const money = (dollars: number) => `${dollars < 0 ? '−' : '+'}$${Math.abs(dollars).toFixed(2)}`
/** Green when the money is a win, red when a loss. */
const tone = (dollars: number) => (dollars > 0 ? 'is-win' : dollars < 0 ? 'is-loss' : '')
const count = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))

/**
 * btcAnalyzerV2's quick-trade circles: tap the button at the bottom middle and solid circles float
 * at the screen's edges, two by two from the bottom third, pinned while the cards scroll under them.
 *
 * With nothing held: a keypad circle and $5 / $15 / $30 on the left, Up (picked) / Down on the
 * right; a tap buys at once. Once held: Buy more, a keypad circle, +10% / +20% / +30% left, +50% /
 * +75% / Sell now right, each target with what it wins at least, after fees. A target sells
 * EVERYTHING once buyers pay it: the computer watches the book and sells right away to the best
 * buyers, never under the target. Tapping another moves it; tapping it again cancels it. Hide under
 * each column hides it. Only the button at the bottom middle (an X while they show) closes them.
 * What is held shows in HoldingColumn, open or closed.
 */
export function PhoneQuickTrade({ trade }: { trade: Trade }) {
  const { state, busy, armed, status, send } = trade
  const [side, setSide] = useState<TradeOutcome>('up')
  const [hidden, setHidden] = useState({ left: false, right: false })
  // The keypad circle's typed values, and which one the open keypad is typing.
  const [typedDollars, setTypedDollars] = useState('')
  const [typedPct, setTypedPct] = useState('')
  const [pad, setPad] = useState<'dollars' | 'pct' | null>(null)
  // Holding: the buy circles instead of the targets, to buy more.
  const [buyMore, setBuyMore] = useState(false)

  const market = state?.market ?? null
  const canTrade = !!state?.canTrade && !!market
  const position = state?.position ?? null
  const held = position && position.avgMills !== null && position.contracts > 0 ? position : null
  const off = !canTrade || !!busy
  const tapAgain = (key: string, text: string) => (armed === key ? 'Tap again' : text)

  let left: ReactNode = null
  let right: ReactNode = null
  let padHint = ''
  const buying = !held || !market || buyMore
  // Holding: Buy more (over the targets) and Targets (over the buy circles) switch.
  const mode =
    held && market ? (
      <button
        type="button"
        className={`phone-quick-mode${buyMore ? '' : ' is-buy'}`}
        onClick={() => {
          if (!buyMore) setSide(held.outcome)
          setBuyMore(!buyMore)
        }}
      >
        {buyMore ? '← Targets' : '+ Buy more'}
      </button>
    ) : null

  if (buying) {
    const balance = state?.balance ?? null
    const buyCircle = (dollars: number, key: string, text: string) => {
      const buy = market ? quickBuy(market, side, dollars) : null
      return (
        <button
          key={key}
          type="button"
          className={`phone-quick-circle is-${side}${armed === key ? ' is-armed' : ''}`}
          disabled={off || !buy || (balance !== null && dollars > balance + 1e-9)}
          onClick={() => {
            if (!buy || !market) return
            // The price shown is the most it pays: the computer never buys over it.
            void send(key, 'buy', { ticker: market.ticker, outcome: side, dollars, maxMills: buy.mills }).then((result) => {
              if (!result || !((result.filled ?? 0) > 0)) return
              if (key === 'q$typed') setTypedDollars('')
              setBuyMore(false)
            })
          }}
        >
          {busy === key ? '…' : tapAgain(key, text)}
          {buy ? <small>{count(buy.count)}×</small> : null}
        </button>
      )
    }
    const typed = keypadNumber(typedDollars)
    const typedBuy = typed !== null && market ? quickBuy(market, side, typed) : null
    padHint = typedBuy
      ? `≈ ${count(typedBuy.count)} ${word(side)} · up to ${formatCents(typedBuy.mills)}`
      : typed !== null
        ? 'Not enough for one contract'
        : `Type the dollars to buy ${word(side)}`
    left = [
      typed === null ? (
        <KeypadCircle key="q$typed" className={`is-${side}`} text="$" onOpen={() => setPad('dollars')} />
      ) : (
        <TypedCircle key="q$typed" onClear={() => setTypedDollars('')}>
          {buyCircle(typed, 'q$typed', `$${typedDollars}`)}
        </TypedCircle>
      ),
      ...QUICK_DOLLARS.map((dollars) => buyCircle(dollars, `q$${dollars}`, `$${dollars}`)),
    ]
    right = (['up', 'down'] as const).map((outcome) => (
      <button
        key={outcome}
        type="button"
        className={`phone-quick-circle is-big is-${outcome}${side === outcome ? ' is-on' : ''}`}
        aria-pressed={side === outcome}
        onClick={() => setSide(outcome)}
      >
        {word(outcome)} {outcome === 'up' ? '▲' : '▼'}
        <small>{formatCents(market ? (outcome === 'up' ? market.upAsk : market.downAsk) : null)}</small>
      </button>
    ))
  }

  if (held && market) {
    const bid = held.outcome === 'up' ? market.upBid : market.downBid
    const entry = held.avgMills ?? 0
    const targets = quickTargets(entry, bid, held.contracts, market)
    const mine = quickPlan(state?.targets ?? [], market.ticker)
    const floor = quickSellFloor(bid, market)

    if (!buying) {
      const circle = (t: QuickTarget, key = `qt${t.pct}`) => {
        const on = mine !== null && t.mills !== null && mine.topMills === t.mills
        return (
          <button
            key={key}
            type="button"
            className={`phone-quick-circle${on ? ' is-target' : ''}${armed === key ? ' is-armed' : ''}`}
            disabled={off || t.state === 'over'}
            aria-pressed={on}
            onClick={() => {
              if (on && mine) return void send(key, 'target/cancel', { id: mine.id }, { confirm: false })
              void send(key, 'target', { ticker: market.ticker, topMills: t.mills }).then((result) => {
                if (result && key === 'qt-typed') setTypedPct('')
              })
            }}
          >
            {busy === key ? '…' : tapAgain(key, `+${t.pct}%`)}
            <small>{t.state === 'over' ? '>99¢' : t.state === 'bid' ? `bid ${formatCents(t.atMills)}` : formatCents(t.mills)}</small>
            {t.state !== 'over' && t.netDollars !== null ? <small className={`phone-quick-money ${tone(t.netDollars)}`}>{money(t.netDollars)}</small> : null}
          </button>
        )
      }
      const pct = keypadNumber(typedPct)
      const typed = pct !== null ? quickTarget(entry, bid, held.contracts, market, pct) : null
      padHint =
        typed === null
          ? `Type the % over your ${formatCents(entry)} average`
          : typed.state === 'over'
            ? 'Past 99.9¢: nothing to sell at'
            : `Sells all ${count(held.contracts)} at ${typed.state === 'bid' ? `the ${formatCents(typed.atMills)} bid` : `${formatCents(typed.mills)} or more`}${typed.netDollars !== null ? ` · ${money(typed.netDollars)}` : ''}`
      left = [
        typed === null ? (
          <KeypadCircle key="qt-typed" text="%" onOpen={() => setPad('pct')} />
        ) : (
          <TypedCircle key="qt-typed" onClear={() => setTypedPct('')}>
            {circle(typed, 'qt-typed')}
          </TypedCircle>
        ),
        ...targets.slice(0, 3).map((t) => circle(t)),
      ]
      right = (
        <>
          {targets.slice(3).map((t) => circle(t))}
          <button
            type="button"
            className={`phone-quick-circle is-down is-sell${armed === 'qout' ? ' is-armed' : ''}`}
            disabled={off || floor === null}
            onClick={() => void send('qout', 'sell-now', { ticker: market.ticker, minMills: floor })}
          >
            {busy === 'qout' ? '…' : tapAgain('qout', 'Sell now')}
            <small>{formatCents(bid)}</small>
          </button>
        </>
      )
    }
  }

  // Under the circles: the last tap's answer; else, while trading is off, why (no key, connecting).
  const setup = !canTrade ? state?.setup || (state ? state.message || 'Waiting for the next round…' : 'Connecting…') : ''
  const column = (where: 'left' | 'right', circles: ReactNode) => (
    <div className={`phone-quick-col is-${where}`}>
      {hidden[where] ? null : <div className="phone-quick-grid">{circles}</div>}
      <div className="phone-quick-foot">
        {where === 'left' && !hidden.left ? mode : null}
        <button type="button" className="phone-quick-hide" aria-pressed={hidden[where]} onClick={() => setHidden((h) => ({ ...h, [where]: !h[where] }))}>
          {hidden[where] ? 'Show' : 'Hide'}
        </button>
      </div>
    </div>
  )

  return (
    <div className="phone-quick">
      {column('left', left)}
      {column('right', right)}
      {status || setup ? (
        <div className={`phone-quick-pill phone-quick-note${status ? ` is-${status.tone}` : ' is-warn'}`} role="status">
          {status?.text ?? setup}
        </div>
      ) : null}
      {pad ? (
        <QuickKeypad
          kind={pad}
          value={pad === 'dollars' ? typedDollars : typedPct}
          hint={padHint}
          onChange={pad === 'dollars' ? setTypedDollars : setTypedPct}
          onClose={() => setPad(null)}
        />
      ) : null}
    </div>
  )
}

/**
 * What is held in the running round, as a column of blocks on the right under the buyers /
 * sellers split: the holding, the bid, what selling now leaves after fees, the target and the
 * auto-sell (a tap takes it off for this round, or queues it again). Shown while anything is held,
 * with the quick-trade circles open or closed.
 */
export function HoldingColumn({ trade }: { trade: Trade }) {
  const { state, busy, send } = trade
  const market = state?.market ?? null
  const position = state?.position ?? null
  const held = position && position.avgMills !== null && position.contracts > 0 ? position : null
  if (!held || !market) return null
  const bid = held.outcome === 'up' ? market.upBid : market.downBid
  const entry = held.avgMills ?? 0
  const mine = quickPlan(state?.targets ?? [], market.ticker)
  const auto = quickAutoSell(state?.targets ?? [], market.ticker)
  // What selling it all at the bid now leaves in the cash: the move less the buy's and the sale's fee.
  const sold = bid !== null ? sellNowResult(held.contracts, entry, bid, market.feeMultiplier) : null
  // A target sells to the buyers there (a taker sale), at the target at least.
  const targetMoney = mine ? netProfitDollars(held.contracts, entry, mine.topMills, market.feeMultiplier, market.makerFees, true) : null
  const off = !state?.canTrade || !!busy

  return (
    <div className="phone-hold" aria-label="What you hold">
      <div className={`phone-hold-block is-${held.outcome}`}>
        <small>Holding</small>
        <b>
          {word(held.outcome)} {held.outcome === 'up' ? '▲' : '▼'} {count(held.contracts)} @ {formatCents(entry)}
        </b>
      </div>
      <div className="phone-hold-block">
        <small>Bid now</small>
        <b>{formatCents(bid)}</b>
      </div>
      <div className="phone-hold-block" title={sold ? sellNowBreakdown(sold) : undefined}>
        <small>Sold now, after fees</small>
        <b className={sold ? `phone-quick-money ${tone(sold.netDollars)}` : ''}>{sold ? money(sold.netDollars) : '—'}</b>
      </div>
      {mine ? (
        <div className="phone-hold-block is-target">
          <small>Target</small>
          <b>
            {mine.state === 'selling'
              ? mine.message
              : `${formatCents(mine.topMills)}+${targetMoney !== null ? ` · ${money(targetMoney)}` : ''}`}
          </b>
        </div>
      ) : null}
      {/* The sell every buy queues on Kalshi: a tap takes it off for this round, or queues it again. */}
      <button
        type="button"
        className={`phone-hold-block is-auto${auto ? ' is-on' : ''}`}
        disabled={off}
        onClick={() =>
          void (auto ? send('qauto', 'target/cancel', { id: auto.id }, { confirm: false }) : send('qauto', 'auto-sell', { ticker: market.ticker }, { confirm: false }))
        }
      >
        <small>Auto-sell · max profit −{auto?.underPct ?? QUICK_AUTO_SELL_UNDER_PCT}%</small>
        <b>{busy === 'qauto' ? '…' : auto ? autoSellText(auto) : 'Off · tap to queue'}</b>
      </button>
    </div>
  )
}

/** "98.2¢ · +$3.64 ✕": the auto-sell's order resting on Kalshi (a tap takes it off). */
function autoSellText(auto: TradeTarget): string {
  if (!(auto.topMills > 0) || !auto.orderId) return `${auto.message} ✕`
  const made = auto.profitDollars != null ? ` · ${money(auto.profitDollars)}` : ''
  return `${formatCents(auto.topMills)}${made} ✕`
}

/** The empty keypad circle: a tap opens the keypad. */
function KeypadCircle({ text, className = '', onOpen }: { text: '$' | '%'; className?: string; onOpen: () => void }) {
  return (
    <button type="button" className={`phone-quick-circle is-keypad ${className}`} onClick={onOpen} aria-label={text === '$' ? 'Type an amount to buy' : 'Type a % to sell at'}>
      <KeypadIcon />
      <small>{text === '$' ? '$ amount' : '% target'}</small>
    </button>
  )
}

/** A circle holding a typed value, with a small × that empties it. */
function TypedCircle({ children, onClear }: { children: ReactNode; onClear: () => void }) {
  return (
    <div className="phone-quick-typed">
      {children}
      <button type="button" className="phone-quick-typed-clear" onClick={onClear} aria-label="Clear the typed value">
        <CloseIcon size={12} />
      </button>
    </div>
  )
}

/** The keypad: digits, a point and ⌫. A tap anywhere outside it closes it and keeps the value. */
function QuickKeypad({ kind, value, hint, onChange, onClose }: { kind: 'dollars' | 'pct'; value: string; hint: string; onChange: (value: string) => void; onClose: () => void }) {
  return (
    <div className="phone-quick-pad-back" onClick={onClose}>
      <div className="phone-quick-pad" role="dialog" aria-label={kind === 'dollars' ? 'Dollars to buy' : '% over your average to sell at'} onClick={(event) => event.stopPropagation()}>
        <div className="phone-quick-pad-value">{kind === 'dollars' ? `$${value || '0'}` : `+${value || '0'}%`}</div>
        <div className="phone-quick-pad-hint">{hint}</div>
        <div className="phone-quick-pad-keys">
          {KEYS.map((key) => (
            <button key={key} type="button" onClick={() => onChange(keypadPress(value, key))} aria-label={key === 'back' ? 'Delete' : key}>
              {key === 'back' ? <BackIcon /> : key}
            </button>
          ))}
        </div>
        <button type="button" className="phone-quick-pad-done" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}

const CloseIcon = ({ size = 15 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
)

const KeypadIcon = () => (
  <svg width={20} height={20} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
    <rect x={4} y={2.5} width={12} height={15} rx={2} />
    <path d="M7 6h6M7 10h.01M10 10h.01M13 10h.01M7 13.5h.01M10 13.5h.01M13 13.5h.01" strokeWidth={1.8} />
  </svg>
)

const BackIcon = () => (
  <svg width={22} height={22} viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 5h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H8l-5-6z" />
    <path d="M11 9l4 4M15 9l-4 4" />
  </svg>
)
