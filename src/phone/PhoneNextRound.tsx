import { useEffect, useState } from 'react'
import { ARMED_WORKING, TAKER_FEE, contractsFor, formatCents, onGrid, priceTicks, type ArmedBuy, type TradeOutcome } from '../trade/kalshiTrade'
import { QUICK_DOLLARS } from '../trade/quick'
import type { Trade } from './useTrade'

const STORE_KEY = 'cryptoanal.phone.nextRound'
/** btcAnalyzerV2's default cap: by the time a person taps, the open has often run to 70¢. */
const DEFAULT = { outcome: 'up' as TradeOutcome, cents: 59, dollars: 15, wait: 10 }
/** How long what did not fill keeps waiting at the cap, seconds (0: fill at once or never). */
const WAITS = [0, 10, 30, 60] as const

type Choice = typeof DEFAULT

function storedChoice(): Choice {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Partial<Choice> | null
    return { ...DEFAULT, ...(saved && typeof saved === 'object' ? saved : {}) }
  } catch {
    return DEFAULT
  }
}

const word = (outcome: TradeOutcome) => (outcome === 'up' ? 'Up' : 'Down')
const count = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))
/** 7:05, never negative. */
export const clockText = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const ET_TIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })
/** A round's open as Kalshi names it: 5:15pm (US Eastern). */
const roundTime = (ms: number) => ET_TIME.format(ms).replace(' AM', 'am').replace(' PM', 'pm')

/** The time now on the computer's clock, again every quarter second. */
function useNow(skewMs: number) {
  const [now, setNow] = useState(() => Date.now() + skewMs)
  useEffect(() => {
    setNow(Date.now() + skewMs)
    const timer = setInterval(() => setNow(Date.now() + skewMs), 250)
    return () => clearInterval(timer)
  }, [skewMs])
  return now
}

const working = (trade: Trade): ArmedBuy | null => trade.state?.armed?.find((a) => ARMED_WORKING.includes(a.state)) ?? null

/** Kalshi's chance for Up: the middle of its bid and ask, in % (one side alone when that is all there is). */
export function upChance(upBid: number | null, upAsk: number | null): number | null {
  if (upBid !== null && upAsk !== null) return (upBid + upAsk) / 20
  const one = upBid ?? upAsk
  return one === null ? null : one / 10
}

/** Left of the round's timer: Kalshi's Up and Down chances for the running round, as Kalshi shows them. */
export function KalshiOdds({ trade }: { trade: Trade }) {
  const market = trade.state?.market ?? null
  const up = market ? upChance(market.upBid, market.upAsk) : null
  const shown = up === null ? null : Math.round(up)
  const lead = shown === null ? '' : shown > 50 ? ' is-up' : shown < 50 ? ' is-down' : ''
  return (
    <div
      className={`phone-odds${lead}`}
      style={up !== null ? { ['--up' as string]: `${up}%` } : undefined}
      role="status"
      aria-label={shown !== null ? `Kalshi: Up ${shown}%, Down ${100 - shown}%` : 'Kalshi: no prices yet'}
    >
      <span className="phone-odds-up">Up {shown !== null ? `${shown}%` : '–'}</span>
      <span className="phone-odds-down">Down {shown !== null ? `${100 - shown}%` : '–'}</span>
    </div>
  )
}

/**
 * Left of the quick-trade button: the time left in Kalshi's running 15-minute round. Amber with
 * the side and cap while a next-round buy is armed. A tap opens the Next round sheet.
 */
export function NextRoundTimer({ trade, open, onToggle }: { trade: Trade; open: boolean; onToggle: () => void }) {
  const now = useNow(trade.skewMs)
  const market = trade.state?.market ?? null
  const active = working(trade)
  const left = market ? market.close * 1000 - now : null
  return (
    <button
      type="button"
      className={`phone-next-timer${active ? ' is-armed' : ''}${open ? ' is-on' : ''}${left !== null && left < 60_000 ? ' is-ending' : ''}`}
      aria-pressed={open}
      aria-label={`${left !== null ? `${clockText(left)} left in this round` : 'No round running'}. Next round buy`}
      onClick={onToggle}
    >
      <b>{left !== null ? clockText(left) : '–:––'}</b>
      <small>{active ? `${word(active.outcome)} ≤ ${formatCents(active.maxMills)}` : 'next round'}</small>
    </button>
  )
}

/**
 * btcAnalyzerV2's "Next round", as a sheet: arm a buy the computer sends the moment the next round
 * opens, at no more than the cap. Runs on the computer, so it fires with the phone locked. Live
 * takes two taps, like every order.
 */
export function NextRoundSheet({ trade, onClose }: { trade: Trade; onClose: () => void }) {
  const { state, busy, armed: confirming, status, send } = trade
  const now = useNow(trade.skewMs)
  const [choice, setChoiceState] = useState(storedChoice)
  const [typed, setTyped] = useState('')
  const setChoice = (patch: Partial<Choice>) =>
    setChoiceState((old) => {
      const next = { ...old, ...patch }
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(next))
      } catch {
        // Remembered for this visit only.
      }
      return next
    })

  const market = state?.market ?? null
  const active = working(trade)
  const last = state?.armed?.find((a) => a !== active && !ARMED_WORKING.includes(a.state)) ?? null
  const opensAt = active ? active.opensAt : market ? market.close * 1000 : null
  const maxMills = choice.cents * 10
  const typedDollars = typed ? Number(typed) : NaN
  const dollars = Number.isFinite(typedDollars) && typedDollars > 0 ? typedDollars : choice.dollars
  const fee = TAKER_FEE * (market?.feeMultiplier ?? 1)
  const contracts = contractsFor(dollars, maxMills, fee)
  const onPrice = !market || onGrid(choice.outcome, maxMills, priceTicks(market.bands))
  const canArm = !!state?.canTrade && !busy && contracts >= 1 && dollars >= 1 && onPrice
  const balance = state?.balance ?? null
  const short = balance !== null && dollars > balance + 1e-9

  const arm = () =>
    void send('narm', 'arm', { product: state?.product ?? 'BTC-USD', outcome: choice.outcome, maxMills, dollars, waitSeconds: choice.wait }).then((result) => {
      if (result) setTyped('')
    })

  return (
    <div className="phone-quick-pad-back" onClick={onClose}>
      <section className="phone-next" role="dialog" aria-label="Next round buy" onClick={(event) => event.stopPropagation()}>
        <header className="phone-next-head">
          <b>Next round</b>
          <span className="phone-spacer" />
          <span className="phone-next-opens">{opensAt !== null ? `${roundTime(opensAt)} opens in ${clockText(opensAt - now)}` : 'Waiting for the round…'}</span>
        </header>
        <p className="phone-next-kicker">
          Buys the moment the next round opens, only at {formatCents(maxMills)} or less. The computer sends it, so it fires with the phone locked.
        </p>

        <div className="phone-next-sides">
          {(['up', 'down'] as const).map((outcome) => (
            <button
              key={outcome}
              type="button"
              className={`phone-next-side is-${outcome}${choice.outcome === outcome ? ' is-on' : ''}`}
              aria-pressed={choice.outcome === outcome}
              onClick={() => setChoice({ outcome })}
            >
              {word(outcome)} {outcome === 'up' ? '▲' : '▼'}
            </button>
          ))}
        </div>

        <div className="phone-next-row">
          <span className="phone-next-label">Up to</span>
          <div className="phone-next-stepper">
            <button type="button" aria-label="1¢ less" disabled={choice.cents <= 1} onClick={() => setChoice({ cents: Math.max(1, choice.cents - 1) })}>
              −
            </button>
            <b>{formatCents(maxMills)}</b>
            <button type="button" aria-label="1¢ more" disabled={choice.cents >= 99} onClick={() => setChoice({ cents: Math.min(99, choice.cents + 1) })}>
              +
            </button>
          </div>
        </div>

        <div className="phone-next-row">
          <span className="phone-next-label">Amount</span>
          <div className="phone-next-chips">
            {QUICK_DOLLARS.map((d) => (
              <button
                key={d}
                type="button"
                className={!typed && choice.dollars === d ? 'is-on' : ''}
                onClick={() => {
                  setTyped('')
                  setChoice({ dollars: d })
                }}
              >
                ${d}
              </button>
            ))}
            <input
              className={typed ? 'is-on' : ''}
              type="text"
              inputMode="decimal"
              placeholder="$ other"
              aria-label="Other amount, in dollars"
              value={typed}
              onChange={(event) => setTyped(event.target.value.replace(/[^0-9.]/g, '').slice(0, 7))}
            />
          </div>
        </div>

        <div className="phone-next-row">
          <span className="phone-next-label">Keep trying</span>
          <div className="phone-next-chips">
            {WAITS.map((w) => (
              <button key={w} type="button" className={choice.wait === w ? 'is-on' : ''} onClick={() => setChoice({ wait: w })}>
                {w ? `${w}s` : 'no'}
              </button>
            ))}
          </div>
        </div>

        <p className="phone-next-note">
          {!onPrice
            ? `${formatCents(maxMills)} is not a price this market takes`
            : contracts >= 1
              ? `≈ ${count(contracts)} ${word(choice.outcome)} at up to ${formatCents(maxMills)}${choice.wait ? `; what does not fill waits ${choice.wait} s, then is canceled` : '; fills at once or not at all'}`
              : 'Enter an amount that buys at least one contract'}
          {short ? ' · more than the cash on the account' : ''}
        </p>

        <button type="button" className={`phone-next-arm is-${choice.outcome}${confirming === 'narm' ? ' is-armed' : ''}`} disabled={!canArm} onClick={arm}>
          {busy === 'narm'
            ? 'Arming…'
            : confirming === 'narm'
              ? 'Tap again · LIVE'
              : `${active ? 'Replace with' : 'Arm'} ${word(choice.outcome)} ≤ ${formatCents(maxMills)} · $${dollars % 1 ? dollars.toFixed(2) : dollars}`}
        </button>
        {!state?.canTrade && <p className="phone-next-note is-warn">{state?.setup || state?.message || 'Connecting…'}</p>}

        {active ? (
          <div className={`phone-next-active is-${active.state}`}>
            <span>
              {active.state === 'armed'
                ? `Armed · ${word(active.outcome)} ≤ ${formatCents(active.maxMills)} ×${count(active.count)} · opens in ${clockText(active.opensAt - now)}`
                : active.message}
            </span>
            {active.state !== 'sending' ? (
              <button type="button" disabled={!!busy} onClick={() => void send('ndisarm', 'disarm', { id: active.id }, { confirm: false })}>
                {busy === 'ndisarm' ? '…' : 'Cancel'}
              </button>
            ) : null}
          </div>
        ) : null}
        {last ? (
          <p className={`phone-next-note phone-next-last is-${last.state}`}>
            {roundTime(last.opensAt)} round: {last.message}
          </p>
        ) : null}
        {status ? (
          <p className={`phone-next-note is-${status.tone}`} role="status">
            {status.text}
          </p>
        ) : null}

        <button type="button" className="phone-quick-pad-done" onClick={onClose}>
          Done
        </button>
      </section>
    </div>
  )
}
