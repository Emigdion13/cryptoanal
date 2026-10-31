/**
 * The trading lab as MCP tools, for an AI to paper trade through: `npx tsx server/lab/mcp.ts`.
 *
 * A stdio MCP server with no dependencies: it speaks newline-delimited JSON-RPC. The live tools pass
 * to the running dev server's /api/lab routes (CRYPTOANAL_URL, http://localhost:5190 by default);
 * the past ones (backtests, replays) run here on the archive and need no server. Everything is
 * paper: nothing here reaches money.
 */
import { createInterface } from 'node:readline'
import { RULE_HELP } from './moment'
import type { Study } from './study'

// Standard output carries the protocol only.
console.log = console.error

const BASE = (process.env.CRYPTOANAL_URL ?? 'http://localhost:5190').replace(/\/$/, '')
const PRODUCT = { type: 'string', description: "The coin, as Coinbase names it: BTC-USD (the lab's coins are in ~/.cryptoanal/lab/config.json)." }
const REASON = { type: 'string', description: 'Why: the setup, the evidence, the plan. Written to the journal with the market at that moment.' }

interface Tool {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  call: (args: Record<string, unknown>) => Promise<unknown>
}

async function lab(method: 'GET' | 'POST', route: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${BASE}/api/lab/${route}`, {
    method,
    headers: method === 'POST' ? { 'Content-Type': 'application/json', Origin: BASE, 'X-CryptoAnal-Phone': '1' } : {},
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  const value = (await response.json().catch(() => null)) as { message?: string } | null
  if (!response.ok) throw new Error(value?.message ?? `The lab answered ${response.status}.`)
  return value
}

let study: Promise<Study> | null = null
const past = () => (study ??= import('./study').then(({ Study }) => new Study()))

const RANGE = {
  days: { type: 'number', description: 'The last N days before today (default 30).' },
  from: { type: 'string', description: 'First day, YYYY-MM-DD (UTC).' },
  to: { type: 'string', description: 'Last day, YYYY-MM-DD (default yesterday).' },
}
const PRODUCTS = { type: 'array', items: { type: 'string' }, description: 'Coins (default BTC-USD: each coin behaves its own way, so study one at a time).' }

const query = (values: Record<string, unknown>) => {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== null && v !== '') params.set(k, String(v))
  const text = params.toString()
  return text ? `?${text}` : ''
}

const TOOLS: Tool[] = [
  {
    name: 'lab_status',
    description:
      "The paper account (cash, equity, P&L, holdings) and each coin's running Kalshi 15-minute round: seconds left, coin price, strike and distance from it, Up/Down bids and asks in cents, the top 5 levels of the book, and every desktop indicator's call and values at the last closed minute.",
    inputSchema: { type: 'object', properties: { product: PRODUCT } },
    call: (a) => lab('GET', `status${query({ product: a.product })}`),
  },
  {
    name: 'lab_buy',
    description:
      'Paper-buy Up (the coin closes the round at or above the strike) or Down, filled against the live Kalshi book level by level with real taker fees. Never pays more than maxCents, nor 2¢ over the best ask. Contracts pay $1 if right.',
    inputSchema: {
      type: 'object',
      properties: {
        product: PRODUCT,
        outcome: { type: 'string', enum: ['up', 'down'] },
        dollars: { type: 'number', minimum: 1, description: 'Dollars to spend, fees included.' },
        maxCents: { type: 'number', description: 'The most to pay per contract, cents (optional).' },
        reason: REASON,
      },
      required: ['product', 'outcome', 'dollars', 'reason'],
    },
    call: (a) => lab('POST', 'buy', a),
  },
  {
    name: 'lab_sell',
    description: "Paper-sell everything held in a coin's running round to the live bids, never under minCents.",
    inputSchema: {
      type: 'object',
      properties: { product: PRODUCT, minCents: { type: 'number', description: 'The least to accept per contract, cents (optional).' }, reason: REASON },
      required: ['product', 'reason'],
    },
    call: (a) => lab('POST', 'sell', a),
  },
  {
    name: 'lab_target',
    description: "Sell the whole holding automatically once the live bid reaches this price (checked on every book change while the dev server runs).",
    inputSchema: { type: 'object', properties: { product: PRODUCT, cents: { type: 'number' }, reason: REASON }, required: ['product', 'cents', 'reason'] },
    call: (a) => lab('POST', 'target', a),
  },
  {
    name: 'lab_cancel_target',
    description: "Cancel the target of a coin's running round.",
    inputSchema: { type: 'object', properties: { product: PRODUCT, reason: REASON }, required: ['product'] },
    call: (a) => lab('POST', 'target/cancel', a),
  },
  {
    name: 'lab_journal',
    description: 'The latest journal entries: every paper order with its reason and market context, targets, settlements, round P&L after fees, notes and resets.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'How many, newest last (default 30, at most 500).' } } },
    call: (a) => lab('GET', `journal${query({ limit: a.limit })}`),
  },
  {
    name: 'lab_rounds',
    description:
      "Recorded rounds, newest first: strike, result (up/down), the coin's price and the Up price minute by minute, and each minute's indicator calls. The raw data, 15-second samples included, is in ~/.cryptoanal/lab/rounds.",
    inputSchema: { type: 'object', properties: { product: PRODUCT, limit: { type: 'number', description: 'Rounds per coin (default 10, at most 200).' } } },
    call: (a) => lab('GET', `rounds${query({ product: a.product, limit: a.limit })}`),
  },
  {
    name: 'lab_note',
    description: 'Write a lesson, observation, rule, mistake or question to the journal.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, kind: { type: 'string', enum: ['lesson', 'observation', 'rule', 'mistake', 'question'] } },
      required: ['text'],
    },
    call: (a) => lab('POST', 'note', a),
  },
  {
    name: 'lab_playbook',
    description: 'Read PLAYBOOK.md, what has been learned in words; pass content to replace it with a revised version (send the whole file).',
    inputSchema: { type: 'object', properties: { content: { type: 'string', description: 'The whole new playbook (Markdown). Leave out to read.' } } },
    call: (a) => (typeof a.content === 'string' ? lab('POST', 'playbook', a) : lab('GET', 'playbook')),
  },
  {
    name: 'lab_past_status',
    description: 'How many past days are prepared for backtests and replays, and the preparing under way.',
    inputSchema: { type: 'object', properties: { products: PRODUCTS, ...RANGE } },
    call: async (a) => (await past()).pastStatus(a),
  },
  {
    name: 'lab_prepare',
    description:
      "Download and prepare past rounds (Kalshi's minute-by-minute prices, results, Coinbase candles, every indicator call as known then): 10-20 s per coin-day the first time (Kalshi's BTC 15-minute rounds began on 10 Dec 2025), in the background. Answers at once; follow it with lab_past_status.",
    inputSchema: { type: 'object', properties: { products: PRODUCTS, ...RANGE } },
    call: async (a) => (await past()).prepare(a),
  },
  {
    name: 'lab_backtest',
    description: `Play a rule on every prepared past round and count it up: win rate, P&L after Kalshi's taker fees, ROI, edge (win rate minus the price paid, for trades held to the result), drawdown, the two halves of the period (does it hold up?), and splits by price, minute, coin and exit. One entry a round at most, at the first minute the rule holds, buying at that minute's ask; the past knows only the best price, so stakes are $1-$100. Saved to ~/.cryptoanal/lab/backtests and noted in the journal.

rule: { name, side: "up" | "down" | "favorite" | "underdog" | expression giving 'up'/'down', enter: expression, minutes?: [first, last] (1-14, default [1, 13]), stake?: dollars (default 10), maxCents?, minCents?, exit?: expression, target?: cents, stop?: cents }
Expressions: numbers, 'text', and/or/not, < <= > >= == !=, + - * /, parentheses.
${RULE_HELP}
Example: { "name": "late favorite", "side": "favorite", "enter": "favAsk >= 85 and favAsk <= 92 and secondsLeft <= 180", "minutes": [11, 14] }`,
    inputSchema: {
      type: 'object',
      properties: {
        rule: { type: 'object', description: 'The rule (see above).' },
        products: PRODUCTS,
        ...RANGE,
        showTrades: { type: 'number', description: 'Also list the last N trades (at most 50).' },
      },
      required: ['rule'],
    },
    call: async (a) => (await past()).backtest(a),
  },
  {
    name: 'lab_replay_start',
    description:
      'Start a blind replay of a random past round not played before: no date and no result, the last hour of the coin, the results of the rounds before, then the screen at minute 1 (prices in cents, indicator calls). Trade it with lab_replay_step.',
    inputSchema: { type: 'object', properties: { product: { type: 'string', description: 'Default BTC-USD.' }, ...RANGE } },
    call: async (a) => (await past()).replayStart(a),
  },
  {
    name: 'lab_replay_step',
    description:
      "Act at the replay's current minute, then see the next: buy (outcome up/down, dollars 1-100, at the ask), sell (everything, at the bid) or wait (minutes, default 1). Buys and sells need a reason. After minute 14 the round ends: the result, its whole path, your P&L and the running replay score.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        action: { type: 'string', enum: ['buy', 'sell', 'wait'] },
        outcome: { type: 'string', enum: ['up', 'down'] },
        dollars: { type: 'number' },
        minutes: { type: 'number', description: 'For wait: how many minutes.' },
        reason: REASON,
      },
      required: ['id', 'action'],
    },
    call: async (a) => (await past()).replayStep(a),
  },
  {
    name: 'lab_reset',
    description: 'Start the paper account over with this much cash (the journal keeps everything).',
    inputSchema: { type: 'object', properties: { cash: { type: 'number' }, reason: REASON }, required: ['cash', 'reason'] },
    call: (a) => lab('POST', 'reset', a),
  },
]

const PAST_TOOLS = new Set(['lab_past_status', 'lab_prepare', 'lab_backtest', 'lab_replay_start', 'lab_replay_step'])

const send = (message: unknown): void => void process.stdout.write(`${JSON.stringify(message)}\n`)

async function answer(request: { id?: string | number; method?: string; params?: Record<string, unknown> }): Promise<void> {
  const { id, method, params = {} } = request
  if (id === undefined) return // A notification: nothing to say back.
  const reply = (result: unknown) => send({ jsonrpc: '2.0', id, result })
  if (method === 'initialize') {
    return reply({
      protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'cryptoanal-lab', version: '1.0.0' },
      instructions:
        "Paper trading on Kalshi's 15-minute crypto rounds with CryptoAnal's indicators, no money. Live: lab_status, lab_buy, lab_sell, lab_target on the real book (needs the dev server). Past: lab_backtest tests a rule on every prepared round, lab_replay_start / lab_replay_step trade a past round blind, minute by minute. Read the journal and the playbook first; give every order its reason; write what was learned (lab_note) and keep PLAYBOOK.md current with rules backed by backtests.",
    })
  }
  if (method === 'ping') return reply({})
  if (method === 'tools/list') return reply({ tools: TOOLS.map(({ call: _call, ...tool }) => tool) })
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params.name)
    if (!tool) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `No tool ${String(params.name)}.` } })
    try {
      const value = await tool.call((params.arguments as Record<string, unknown> | undefined) ?? {})
      return reply({ content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const hint = !PAST_TOOLS.has(tool.name) && /fetch failed|ECONNREFUSED/.test(message) ? ` Is the dev server running (npm run dev in the cryptoanal folder, ${BASE})?` : ''
      return reply({ content: [{ type: 'text', text: `${message}${hint}` }], isError: true })
    }
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${String(method)}.` } })
}

createInterface({ input: process.stdin })
  // The client went away: stop, even with a preparation under way (it carries on next time).
  .on('close', () => process.exit(0))
  .on('line', (line) => {
    if (!line.trim()) return
    let request: { id?: string | number; method?: string; params?: Record<string, unknown> }
    try {
      request = JSON.parse(line) as typeof request
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Not JSON.' } })
      return
    }
    void answer(request)
  })
