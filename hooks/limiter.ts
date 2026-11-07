import type { EngineInterface } from 'claude-code'

import { classify } from './logic'

// One limiter per activation, shared by the radar and the hosted-equivalent
// counter: a rate limit hit by either pauses both, and nothing but time ends a
// cooldown (a later successful call never clears it).
//
// Rate-limit details come from the response headers of calls the mod makes
// anyway (`gh api --include`): no separate quota request, no token handling.

export type Gh = { ok: true; out: string } | { ok: false; error: string }

/** A `gh` invocation through the limiter. */
export type Call = (args: string[]) => Promise<Gh>

export type Limiter = {
  /** No request starts before this time (ms). Only ever moves forward. */
  until: number
  /** The last `x-ratelimit-remaining` / `x-ratelimit-reset` GitHub reported. */
  quota?: { remaining: number; reset: number }
  /** Ask `gh api` for headers; turned off if this gh does not support it. */
  include: boolean
}

export const freshLimiter = (): Limiter => ({ until: 0, include: true })

/** Without retry/reset headers, wait this long after a rate limit (GitHub's own advice: at least a minute). */
export const DEFAULT_BACKOFF_MS = 60_000
/** Never trust a header to pause for more than this. */
export const MAX_BACKOFF_MS = 65 * 60_000

export type Head = { status: number; headers: Record<string, string> }

/**
 * Splits `gh api --include` output into the status line + headers and the body.
 * Output without a leading `HTTP/…` status line is returned as the body as is.
 */
export function splitHead(out: string): { head?: Head; body: string } {
  const m = /^HTTP\/[\d.]+ (\d{3})[^\n]*\n/.exec(out)
  if (!m) return { body: out }
  const end = /\r?\n\r?\n/.exec(out)
  const headText = end ? out.slice(0, end.index) : out
  const body = end ? out.slice(end.index + end[0].length) : ''
  const headers: Record<string, string> = {}
  for (const line of headText.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':')
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return { head: { status: Number(m[1]), headers }, body }
}

/** Is this response a rate limit? By gh's message, or by status and headers. */
export function isRateLimited(error: string, head: Head | undefined): boolean {
  if (classify(error) === 'rateLimit') return true
  if (!head) return false
  if (head.status === 429) return true
  return head.status === 403 && (head.headers['x-ratelimit-remaining'] === '0' || 'retry-after' in head.headers)
}

/**
 * When requests may start again after a rate limit: `retry-after` seconds, else
 * the `x-ratelimit-reset` time when the quota is exhausted, else a minute.
 */
export function cooldownEnd(head: Head | undefined, now: number): number {
  const h = head?.headers ?? {}
  const retry = Number(h['retry-after'])
  let end = now + DEFAULT_BACKOFF_MS
  if (h['retry-after'] !== undefined && Number.isFinite(retry) && retry >= 0) end = now + retry * 1000
  else if (h['x-ratelimit-remaining'] === '0' && Number.isFinite(Number(h['x-ratelimit-reset']))) {
    end = Number(h['x-ratelimit-reset']) * 1000 + 1000
  }
  return Math.min(now + MAX_BACKOFF_MS, Math.max(now + 1000, end))
}

/** Pauses the limiter until `end`, never shortening a pause already set. */
export function pause(limiter: Limiter, end: number): void {
  limiter.until = Math.max(limiter.until, end)
}

function noteQuota(limiter: Limiter, head: Head | undefined): void {
  const remaining = Number(head?.headers['x-ratelimit-remaining'])
  const reset = Number(head?.headers['x-ratelimit-reset'])
  if (head?.headers['x-ratelimit-remaining'] !== undefined && Number.isFinite(remaining) && Number.isFinite(reset)) {
    limiter.quota = { remaining, reset: reset * 1000 }
  }
}

/** The message of a request the limiter held back: classified as a rate limit. */
export const PAUSED = 'API rate limit: requests paused by Runner Radar until the limit resets'

async function run($: EngineInterface, argv: string[]): Promise<{ ok: boolean; out: string; error: string }> {
  try {
    const r = await $.process.run(['gh', ...argv], { timeoutMs: 20_000 })
    if (r.exitCode !== 0) {
      const line = (r.stderr || '').trim().split('\n')[0] || (r.stdout || '').trim().split('\n')[0]
      return { ok: false, out: r.stdout ?? '', error: line || `gh exited with ${r.exitCode}` }
    }
    return { ok: true, out: r.stdout ?? '', error: '' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, out: '', error: /ENOENT|not found|cannot start/i.test(message) ? 'gh CLI not found on PATH' : message }
  }
}

/**
 * Every `gh` call goes through here: held back during a cooldown, headers read
 * for the quota and the rate-limit reset, and any rate limit starts a cooldown
 * at once, so no further request is scheduled by the radar or the counter.
 */
export function caller($: EngineInterface, limiter: Limiter): Call {
  return async args => {
    const now = await $.clock.now()
    if (now < limiter.until) return { ok: false, error: PAUSED }
    const api = args[0] === 'api'
    let r = await run($, api && limiter.include ? [...args, '--include'] : args)
    if (api && limiter.include && !r.ok && /unknown (flag|shorthand).*include|--include/i.test(r.error)) {
      limiter.include = false
      r = await run($, args)
    }
    const { head, body } = api ? splitHead(r.out) : { head: undefined, body: r.out }
    noteQuota(limiter, head)
    if (r.ok && (!head || head.status < 400)) return { ok: true, out: body }
    const error = r.ok ? `HTTP ${head?.status}` : r.error
    if (isRateLimited(error, head)) {
      pause(limiter, cooldownEnd(head, await $.clock.now()))
      return { ok: false, error: classify(error) === 'rateLimit' ? error : `API rate limit exceeded (${error})` }
    }
    return { ok: false, error }
  }
}
