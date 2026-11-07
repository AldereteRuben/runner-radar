import type { Job, Runner, Snapshot } from '../types'
import type { Strings } from './i18n'

// Pure functions over a snapshot: no `$`, no GitHub, easy to test. Every phrase
// comes from `Strings`, so the logic stays the same in every language.

/** `4m10s`, `1h02m`, `35s`. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** Self-hosted jobs not running yet, longest waiting first. */
export function queue(s: Snapshot): Job[] {
  return s.jobs
    .filter(j => j.selfHosted && j.status !== 'in_progress')
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** The job each busy runner is working on, by runner name. */
export function assignments(s: Snapshot): Map<string, Job> {
  const map = new Map<string, Job>()
  for (const j of s.jobs) if (j.status === 'in_progress' && j.runner) map.set(j.runner, j)
  return map
}

export function statusLine(s: Snapshot, now: number, t: Strings): string {
  if (s.error && s.runners.length === 0) return `radar · ${s.error}`
  const waiting = queue(s)
  const oldest = waiting[0]
  return t.status(
    s.runners.filter(r => r.online).length,
    s.runners.length,
    s.runners.filter(r => r.busy).length,
    waiting.length,
    oldest ? duration(now - oldest.createdAt) : '',
  )
}

const lower = (xs: string[]) => xs.map(x => x.toLowerCase())

/**
 * Why a queued self-hosted job is still waiting, from the runners we can see:
 * a label no runner has (it will never start), matching runners offline, or all
 * of them working. `undefined` when a free runner fits (it is about to start).
 */
export function waitReason(job: Job, runners: Runner[], t: Strings): { text: string; blocking: boolean } | undefined {
  const wanted = lower(job.labels)
  const fits = runners.filter(r => {
    const has = new Set(lower(r.labels))
    return wanted.every(l => has.has(l))
  })
  if (fits.length === 0) {
    const missing = job.labels.filter(l => !runners.some(r => lower(r.labels).includes(l.toLowerCase())))
    const shown = missing.length ? missing : job.labels.filter(l => l.toLowerCase() !== 'self-hosted')
    return { text: t.reason.noLabel(shown.length ? shown : job.labels), blocking: true }
  }
  const online = fits.filter(r => r.online)
  if (online.length === 0) return { text: t.reason.offline, blocking: true }
  if (online.every(r => r.busy)) return { text: t.reason.working(online.length), blocking: false }
  return undefined
}

export type Level = 'ok' | 'warn' | 'bad'

export type AlertConfig = { queueAlert: number; waitAlertMinutes: number }

/** How bad a wait is: past the wait alert is bad, past half of it a warning. */
export function waitLevel(waitMs: number, waitAlertMinutes: number): Level {
  const limit = (waitAlertMinutes > 0 ? waitAlertMinutes : 10) * 60_000
  if (waitMs >= limit) return 'bad'
  if (waitMs >= limit / 2) return 'warn'
  return 'ok'
}

/** One line that answers "is anything wrong?" before reading the rest. */
export function headline(s: Snapshot, now: number, config: AlertConfig, t: Strings): { level: Level; text: string } {
  const offline = s.runners.filter(r => !r.online)
  const waiting = queue(s)
  const stuck = s.error ? [] : waiting.filter(j => waitReason(j, s.runners, t)?.blocking)
  const oldest = waiting[0]
  const wait = oldest ? t.headline.waiting(waiting.length, duration(now - oldest.createdAt)) : ''

  const bad: string[] = []
  if (s.error && s.runners.length === 0) bad.push(s.error)
  if (offline.length === 1 && offline[0]) bad.push(t.headline.runnerOffline(offline[0].name))
  if (offline.length > 1) bad.push(t.headline.runnersOffline(offline.length))
  if (stuck.length) bad.push(t.headline.cantStart(stuck.length))
  if (bad.length) return { level: 'bad', text: [...bad, wait].filter(Boolean).join(' · ') }

  const longWait = oldest && waitLevel(now - oldest.createdAt, config.waitAlertMinutes) !== 'ok'
  const bigQueue = config.queueAlert > 0 && waiting.length >= config.queueAlert
  if (longWait || bigQueue) return { level: 'warn', text: wait }
  if (waiting.length) return { level: 'ok', text: wait }

  const busy = s.runners.filter(r => r.busy).length
  if (busy) return { level: 'ok', text: t.headline.working(busy, s.runners.length) }
  return { level: 'ok', text: t.headline.allClear(s.runners.filter(r => r.online).length) }
}

/** What already fired, so each alert shows once per episode. */
export type AlertMemory = { queueAlerted: boolean; waitAlerted: Set<number> }

export const freshMemory = (): AlertMemory => ({ queueAlerted: false, waitAlerted: new Set() })

/**
 * Toasts for what changed between two snapshots: a runner that went offline or
 * came back, the queue crossing its threshold, a job waiting past the limit.
 * Mutates `memory`.
 */
export function alerts(
  prev: Snapshot | null,
  next: Snapshot,
  now: number,
  config: AlertConfig,
  memory: AlertMemory,
  t: Strings,
): string[] {
  const out: string[] = []

  if (prev && prev.owner === next.owner) {
    const before = new Map(prev.runners.map((r): [string, Runner] => [r.name, r]))
    for (const r of next.runners) {
      const was = before.get(r.name)
      if (was?.online && !r.online) out.push(t.alert.wentOffline(r.name))
      if (was && !was.online && r.online) out.push(t.alert.backOnline(r.name))
    }
  }

  const waiting = queue(next)
  if (config.queueAlert > 0) {
    if (waiting.length >= config.queueAlert && !memory.queueAlerted) {
      out.push(t.alert.queue(waiting.length))
      memory.queueAlerted = true
    } else if (waiting.length < config.queueAlert) {
      memory.queueAlerted = false
    }
  }

  if (config.waitAlertMinutes > 0) {
    const limit = config.waitAlertMinutes * 60_000
    const stillWaiting = new Set(waiting.map(j => j.id))
    for (const id of memory.waitAlerted) if (!stillWaiting.has(id)) memory.waitAlerted.delete(id)
    for (const j of waiting) {
      if (now - j.createdAt >= limit && !memory.waitAlerted.has(j.id)) {
        out.push(t.alert.longWait(j.repo, j.name, duration(now - j.createdAt)))
        memory.waitAlerted.add(j.id)
      }
    }
  }

  return out
}

/** `✓` success, `✗` failure, `⊘` cancelled, `·` anything else. */
export function mark(conclusion: string): { glyph: string; color: string } {
  if (conclusion === 'success') return { glyph: '✓', color: 'green' }
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure')
    return { glyph: '✗', color: 'red' }
  if (conclusion === 'cancelled') return { glyph: '⊘', color: 'gray' }
  return { glyph: '·', color: 'gray' }
}

export function parseRepos(value: unknown): string[] {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',')
  return list
    .map(x => String(x).trim())
    .filter(Boolean)
    .map(x => x.replace(/^.*\//, ''))
}
