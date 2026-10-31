/**
 * The lab from a terminal: `npm run lab -- prepare [days] [coins…]` reads the past into the archive;
 * `npm run lab -- backtest rule.json [days]` plays a rule on it and prints the numbers.
 */
import { readFile } from 'node:fs/promises'
import { DEFAULT_PRODUCTS, Study } from './study'

const [command, ...args] = process.argv.slice(2)
const study = new Study()

if (command === 'prepare') {
  const days = Number(args[0]) || 30
  const products = args.slice(1).length ? args.slice(1) : DEFAULT_PRODUCTS
  const start = Date.now()
  study.prepare({ days, products })
  const timer = setInterval(() => {
    const s = study.past.status
    console.log(`${s.done}/${s.total} coin-days · ${s.product ?? ''} ${s.day ?? ''} · ${Math.round((Date.now() - start) / 1000)} s`)
  }, 10_000)
  await study.past.settled()
  clearInterval(timer)
  const status = study.pastStatus({ days, products })
  console.log(status.preparing.error ? `Stopped: ${status.preparing.error}` : 'Ready:', status.ready)
} else if (command === 'backtest' && args[0]) {
  const rule = JSON.parse(await readFile(args[0], 'utf8')) as Record<string, unknown>
  const result = await study.backtest({ rule, days: Number(args[1]) || 30 })
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log('npm run lab -- prepare [days] [coins…]\nnpm run lab -- backtest rule.json [days]')
}
