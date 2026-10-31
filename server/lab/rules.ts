/**
 * The rule language of backtests: small expressions an AI (or a person) writes, read safely with
 * no code run. `upAsk <= 92 and secondsLeft <= 180 and has("SAR", "ABOVE")`.
 *
 * Numbers, 'strings' or "strings", true / false, names, calls f(a, b); + - * /; < <= > >= == !=;
 * and / &&, or / ||, not / !; parentheses. A missing value (null) makes a comparison false and
 * arithmetic null, so a rule never trades on data that was not there.
 */

export type Value = number | string | boolean | null

type Node =
  | { kind: 'lit'; value: Value }
  | { kind: 'var'; name: string }
  | { kind: 'call'; name: string; args: Node[] }
  | { kind: 'not'; arg: Node }
  | { kind: 'neg'; arg: Node }
  | { kind: 'bin'; op: string; left: Node; right: Node }

export interface Scope {
  vars: (name: string) => Value | undefined
  fns: Record<string, (...args: Value[]) => Value>
}

export class RuleError extends Error {}

const TOKEN = /\s*(?:(\d+(?:\.\d+)?|\.\d+)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([A-Za-z_][A-Za-z0-9_]*)|(<=|>=|==|!=|&&|\|\||[-+*/()<>!,]))/y

function tokenize(text: string): string[] {
  const out: string[] = []
  TOKEN.lastIndex = 0
  let at = 0
  while (at < text.length) {
    if (/^\s*$/.test(text.slice(at))) break
    TOKEN.lastIndex = at
    const m = TOKEN.exec(text)
    if (!m) throw new RuleError(`Cannot read "${text.slice(at, at + 12).trim()}…"`)
    out.push(m[0].trim())
    at = TOKEN.lastIndex
  }
  return out
}

/** Reads an expression once; `known` names its variables and functions so a typo fails here. */
export function compile(text: string, known: { vars: readonly string[]; fns: readonly string[] }): Node {
  if (text.length > 4_000) throw new RuleError('That rule is too long.')
  const tokens = tokenize(text)
  let k = 0
  const peek = () => tokens[k]
  const next = () => tokens[k++]
  const expect = (t: string) => {
    if (next() !== t) throw new RuleError(`Expected "${t}" in: ${text}`)
  }
  const isWord = (t: string | undefined, ...words: string[]) => t !== undefined && words.includes(t.toLowerCase())

  const or = (): Node => {
    let left = and()
    while (peek() === '||' || isWord(peek(), 'or')) {
      next()
      left = { kind: 'bin', op: '||', left, right: and() }
    }
    return left
  }
  const and = (): Node => {
    let left = not()
    while (peek() === '&&' || isWord(peek(), 'and')) {
      next()
      left = { kind: 'bin', op: '&&', left, right: not() }
    }
    return left
  }
  const not = (): Node => {
    if (peek() === '!' || isWord(peek(), 'not')) {
      next()
      return { kind: 'not', arg: not() }
    }
    return compare()
  }
  const compare = (): Node => {
    const left = sum()
    const op = peek()
    if (op && ['<', '<=', '>', '>=', '==', '!='].includes(op)) {
      next()
      return { kind: 'bin', op, left, right: sum() }
    }
    return left
  }
  const sum = (): Node => {
    let left = product()
    while (peek() === '+' || peek() === '-') left = { kind: 'bin', op: next(), left, right: product() }
    return left
  }
  const product = (): Node => {
    let left = unary()
    while (peek() === '*' || peek() === '/') left = { kind: 'bin', op: next(), left, right: unary() }
    return left
  }
  const unary = (): Node => {
    if (peek() === '-') {
      next()
      return { kind: 'neg', arg: unary() }
    }
    return primary()
  }
  const primary = (): Node => {
    const t = next()
    if (t === undefined) throw new RuleError(`The rule ends too early: ${text}`)
    if (t === '(') {
      const inner = or()
      expect(')')
      return inner
    }
    if (/^(\d|\.\d)/.test(t)) return { kind: 'lit', value: Number(t) }
    if (t[0] === '"' || t[0] === "'") return { kind: 'lit', value: t.slice(1, -1).replace(/\\(.)/g, '$1') }
    if (/^[A-Za-z_]/.test(t)) {
      if (isWord(t, 'true', 'false')) return { kind: 'lit', value: t.toLowerCase() === 'true' }
      if (isWord(t, 'null')) return { kind: 'lit', value: null }
      if (peek() === '(') {
        if (!known.fns.includes(t)) throw new RuleError(`No function ${t}(). There are: ${known.fns.join(', ')}.`)
        next()
        const args: Node[] = []
        if (peek() !== ')') {
          args.push(or())
          while (peek() === ',') {
            next()
            args.push(or())
          }
        }
        expect(')')
        return { kind: 'call', name: t, args }
      }
      if (!known.vars.includes(t)) throw new RuleError(`No value named ${t}. There are: ${known.vars.join(', ')}.`)
      return { kind: 'var', name: t }
    }
    throw new RuleError(`Unexpected "${t}" in: ${text}`)
  }

  const tree = or()
  if (k < tokens.length) throw new RuleError(`Unexpected "${tokens[k]}" in: ${text}`)
  return tree
}

const num = (v: Value): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function evaluate(node: Node, scope: Scope): Value {
  switch (node.kind) {
    case 'lit':
      return node.value
    case 'var':
      return scope.vars(node.name) ?? null
    case 'call':
      return scope.fns[node.name](...node.args.map((a) => evaluate(a, scope)))
    case 'not':
      return !truthy(evaluate(node.arg, scope))
    case 'neg': {
      const v = num(evaluate(node.arg, scope))
      return v === null ? null : -v
    }
    case 'bin': {
      if (node.op === '&&') return truthy(evaluate(node.left, scope)) && truthy(evaluate(node.right, scope))
      if (node.op === '||') return truthy(evaluate(node.left, scope)) || truthy(evaluate(node.right, scope))
      const a = evaluate(node.left, scope)
      const b = evaluate(node.right, scope)
      if (node.op === '==' || node.op === '!=') {
        const equal = typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b
        return node.op === '==' ? equal : !equal
      }
      const x = num(a)
      const y = num(b)
      if (x === null || y === null) return ['<', '<=', '>', '>='].includes(node.op) ? false : null
      switch (node.op) {
        case '<':
          return x < y
        case '<=':
          return x <= y
        case '>':
          return x > y
        case '>=':
          return x >= y
        case '+':
          return x + y
        case '-':
          return x - y
        case '*':
          return x * y
        case '/':
          return y === 0 ? null : x / y
      }
      return null
    }
  }
}

export const truthy = (v: Value) => v !== null && v !== false && v !== 0 && v !== ''
