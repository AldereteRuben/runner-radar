import type { ApiError, Savings, UsageEntry, UsageMonth } from '../types'

// Pure helpers for the savings counter: no `$`, no GitHub.
//
// The counter answers "what would these minutes have cost on GitHub-hosted
// runners?": billable minutes of the jobs that ran on your self-hosted runners
// (each job rounded up to the minute, every attempt counted, as GitHub bills)
// times a per-minute price the user can set (default: Linux 2-core).

/** GitHub's Linux 2-core hosted rate after the January 2026 price cut, USD/min. */
export const DEFAULT_PRICE_PER_MINUTE = 0.006

const pad2 = (n: number) => String(n).padStart(2, '0')

/** `YYYY-MM` of a time, in UTC (GitHub bills Actions minutes in UTC). */
export const monthKey = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`
}

/** `YYYY-MM-DD` of a time, in UTC. */
export const dayKey = (ms: number): string => {
  const d = new Date(ms)
  return `${monthKey(ms)}-${pad2(d.getUTCDate())}`
}

/** The `$.store` key of one owner's month. */
export const storeKey = (owner: string, month: string): string => `usage:${owner.toLowerCase()}:${month}`

/** Reads a stored month defensively: anything malformed is dropped, not trusted. */
export function readMonth(value: unknown): UsageMonth {
  if (!value || typeof value !== 'object') return {}
  const out: UsageMonth = {}
  for (const [id, e] of Object.entries(value as Record<string, unknown>)) {
    if (
      Array.isArray(e) &&
      e.length === 4 &&
      typeof e[0] === 'string' &&
      typeof e[1] === 'string' &&
      typeof e[2] === 'number' &&
      typeof e[3] === 'number'
    ) {
      out[id] = e as UsageEntry
    }
  }
  return out
}

export function summarize(
  usage: UsageMonth,
  input: {
    owner: string
    month: string
    today: string
    pricePerMinute: number
    runsPending: number
    updatedAt: number
    error?: ApiError
  },
): Savings {
  let monthMinutes = 0
  let todayMinutes = 0
  let hostedMinutes = 0
  const byRepo = new Map<string, number>()
  for (const [repo, day, selfHosted, hosted] of Object.values(usage)) {
    monthMinutes += selfHosted
    hostedMinutes += hosted
    if (day === input.today) todayMinutes += selfHosted
    byRepo.set(repo, (byRepo.get(repo) ?? 0) + selfHosted)
  }
  const perRepo = [...byRepo.entries()]
    .filter(([, minutes]) => minutes > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([repo, minutes]) => ({ repo, minutes }))
  return {
    owner: input.owner,
    month: input.month,
    pricePerMinute: input.pricePerMinute,
    monthMinutes,
    todayMinutes,
    hostedMinutes,
    perRepo,
    runsCounted: Object.keys(usage).length,
    runsPending: input.runsPending,
    updatedAt: input.updatedAt,
    error: input.error,
  }
}

/** `$38.40` (two decimals; a non-zero amount under a cent shows `<$0.01`). */
export function money(minutes: number, pricePerMinute: number): string {
  const usd = minutes * pricePerMinute
  if (usd > 0 && usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

/** `6,400` / `6.400`: thousands grouped with the language's separator. */
export function grouped(n: number, separator: string): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, separator)
}
