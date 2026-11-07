import { expect, test } from 'claude-code/testing'

import { strings } from '../hooks/i18n'
import { alerts, apiError, duration, freshMemory, headline, layout, parseRepos, partialWarning, queue, reasonFor, statusLine, waitLevel, waitReason } from '../hooks/logic'
import type { Snapshot } from '../types'

const NOW = Date.UTC(2026, 10, 7, 15, 0, 0)
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const MIN = 60_000
const en = strings('en')
const es = strings('es')

const PANE = {
  plugin: 'runner-radar',
  component: 'Pane',
  requestId: 'runner-radar',
  props: {
    title: 'Runner Radar · acme',
    isFocused: false,
    bodyColumns: 90,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

/** A fake `gh`: answers by the API path in argv. */
function fakeGh(argv: readonly string[], failApiRunner = false): { exitCode: number; stdout: string; stderr: string } {
  if (argv[1] === 'run' && argv[2] === 'view') {
    const log = [
      'e2e\tRun tests\t2026-11-07T14:50:00.0000000Z FAIL tests/login.spec.ts',
      'e2e\tRun tests\t2026-11-07T14:50:01.0000000Z Expected 200, got 500',
    ]
    return { exitCode: 0, stdout: log.join('\n') + '\n', stderr: '' }
  }
  const path = argv[2] ?? ''
  if (failApiRunner && path === 'repos/acme/api/actions/runners') {
    return { exitCode: 1, stdout: '', stderr: 'HTTP 403: Forbidden' }
  }
  const ok = (v: unknown) => ({ exitCode: 0, stdout: JSON.stringify(v), stderr: '' })
  if (path === 'users/acme') return ok({ type: 'Organization' })
  if (path.startsWith('orgs/acme/repos')) {
    return ok([
      { name: 'api', archived: false, owner: 'acme' },
      { name: 'old', archived: true, owner: 'acme' },
      { name: 'web', archived: false, owner: 'acme' },
    ])
  }
  if (path === 'orgs/acme/actions/runners') {
    return ok([
      { id: 1, name: 'box-1', status: 'online', busy: true, labels: ['self-hosted', 'linux'] },
      { id: 2, name: 'box-2', status: 'offline', busy: false, labels: ['self-hosted', 'linux'] },
    ])
  }
  if (path.endsWith('/actions/runners')) return ok([])
  if (path.startsWith('repos/acme/api/actions/runs?')) {
    return ok([
      { id: 10, name: 'CI', status: 'in_progress', conclusion: null, created_at: iso(20 * MIN) },
      { id: 9, name: 'CI', status: 'completed', conclusion: 'success', created_at: iso(60 * MIN) },
      { id: 8, name: 'CI', status: 'completed', conclusion: 'failure', created_at: iso(90 * MIN) },
    ])
  }
  if (path.startsWith('repos/acme/api/actions/runs/10/jobs')) {
    return ok([
      { id: 100, name: 'tests', status: 'in_progress', runner_name: 'box-1', created_at: iso(20 * MIN), started_at: iso(3 * MIN), labels: ['self-hosted'] },
      { id: 101, name: 'lint', status: 'queued', runner_name: null, created_at: iso(12 * MIN), started_at: null, labels: ['self-hosted'] },
      { id: 102, name: 'hosted', status: 'queued', runner_name: null, created_at: iso(30 * MIN), started_at: null, labels: ['ubuntu-latest'] },
    ])
  }
  if (path.startsWith('repos/acme/web/actions/runs?')) {
    return ok([{ id: 20, name: 'Web', status: 'completed', conclusion: 'failure', created_at: iso(15 * MIN), updated_at: iso(12 * MIN), head_branch: 'main', html_url: 'https://github.com/acme/web/actions/runs/20' }])
  }
  if (path.startsWith('repos/acme/web/actions/runs/20/jobs')) {
    return ok([{ name: 'e2e', step: 'Run tests', url: 'https://github.com/acme/web/actions/runs/20/job/7' }])
  }
  return { exitCode: 1, stdout: '', stderr: `unexpected call: ${argv.join(' ')}\n` }
}

type On = Parameters<Parameters<typeof test>[2]>[1]

function engine(
  on: On,
  toasts: string[] = [],
  runGh: (argv: readonly string[]) => ReturnType<typeof fakeGh> = argv => fakeGh(argv),
  store: Map<string, unknown> = new Map(),
) {
  on('store.get', (_, e) => ({ value: store.get((e as { key: string }).key) }))
  on('store.set', (_, e) => {
    const { key, value } = e as { key: string; value: unknown }
    store.set(key, JSON.parse(JSON.stringify(value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete((e as { key: string }).key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('clock.after', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'radar' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('clock.every', () => ({ value: { cancel: () => {} } }))
  on('clock.now', () => ({ value: NOW }))
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text: string }).text))
    return { value: undefined }
  })
  on('process.run', (_, e) => ({ value: runGh((e as { argv: readonly string[] }).argv) }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

test('/radar shows working runners, the queue with its reason, and repos', { options: { owner: 'acme' } }, async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = await $.command.run({ command: 'radar', args: '' })
  expect(ran.text).toContain('Watching acme')
  await new Promise(resolve => setTimeout(resolve, 80))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The headline answers first: a runner is down, one job waits.
  expect((await ui.find({ type: 'Text', text: /^✖/ }))?.text).toBe('✖ box-2 is offline · 1 job waiting (longest 12m00s)')
  expect(await ui.find({ type: 'Text', text: /1 of 2 online · 1 working/ })).toBeDefined()
  const box1 = (await ui.find({ type: 'Text', text: /box-1/ }))?.text ?? ''
  expect(box1).toContain('working')
  expect(box1).toContain('api › tests')
  expect(box1).toContain('3m00s')
  expect((await ui.find({ type: 'Text', text: /box-2/ }))?.text).toContain('offline')
  // Only the self-hosted job waits, with why: its one runner is working.
  const lint = (await ui.find({ type: 'Text', text: /api › lint/ }))?.text ?? ''
  expect(lint).toContain('12m00s')
  expect(lint).toContain("its runner is working, it's next")
  expect(await ui.find({ type: 'Text', text: /hosted$/ })).toBeUndefined()
  // Archived repos are skipped.
  expect(await ui.find({ type: 'Text', text: /old/ })).toBeUndefined()
  // Every watched repo gets its own row, the active one first.
  expect(await ui.find({ type: 'Text', text: /2 watched/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /api.*1 running · 2 waiting/ }))?.text).toContain('✓✗')
  // Fixed columns: the results come right after the name, aligned for every repo.
  expect(await ui.find({ type: 'Text', text: /2 watched · last 5 runs/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /● web\s+✗\s+no activity/ }))).toBeDefined()
  // The failed run says what failed, where, and how to read the error.
  expect((await ui.find({ type: 'Text', text: /^\s*✗ Web/ }))?.text).toContain('✗ Web · main · failed 12m00s ago in "e2e" › "Run tests"')
  expect((await ui.find({ type: 'Text', text: /radar logs web/ }))?.text).toContain('view on GitHub')
  await ui.unmount()

  expect(toasts.some(x => x.includes('api › lint has waited 12m00s'))).toBe(true)
})

test('partial runner API failures are shown and clear after a successful refresh', { options: { owner: 'acme' } }, async ($, on) => {
  let fail = true
  engine(on, [], argv => fakeGh(argv, fail))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radar', args: '' })
  await new Promise(resolve => setTimeout(resolve, 80))

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Runner list incomplete.*api/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 of 2 online/ })).toBeDefined()
  await ui.unmount()

  fail = false
  await $.command.run({ command: 'radar', args: 'refresh' })
  await new Promise(resolve => setTimeout(resolve, 80))
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Runner list incomplete/ })).toBeUndefined()
  await ui.unmount()
})

test('rate-limit responses pause the next refresh instead of immediately retrying', { options: { owner: 'acme' } }, async ($, on) => {
  let calls = 0
  engine(on, [], argv => {
    calls++
    if (argv[2] === 'users/acme') return { exitCode: 1, stdout: '', stderr: 'API rate limit exceeded' }
    return fakeGh(argv)
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radar', args: '' })
  await new Promise(resolve => setTimeout(resolve, 60))
  const afterFailure = calls
  expect(afterFailure).toBe(1)
  await $.command.run({ command: 'radar', args: 'refresh' })
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(calls).toBe(afterFailure)
})

test('rate limits from active-job lookups reach the pane and pause polling', { options: { owner: 'acme' } }, async ($, on) => {
  let calls = 0
  engine(on, [], argv => {
    calls++
    if (argv[2] === 'repos/acme/api/actions/runs/10/jobs?per_page=50') {
      return { exitCode: 1, stdout: '', stderr: 'API rate limit exceeded' }
    }
    return fakeGh(argv)
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radar', args: '' })
  await new Promise(resolve => setTimeout(resolve, 80))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /GitHub API rate limit reached/ })).toBeDefined()
  await ui.unmount()
  const afterFailure = calls
  await $.command.run({ command: 'radar', args: 'refresh' })
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(calls).toBe(afterFailure)
})

test('rate limits from failed-run detail lookups reach the pane and pause polling', { options: { owner: 'acme' } }, async ($, on) => {
  let calls = 0
  engine(on, [], argv => {
    calls++
    if (argv[2] === 'repos/acme/web/actions/runs/20/jobs?filter=latest&per_page=50') {
      return { exitCode: 1, stdout: '', stderr: 'API rate limit exceeded' }
    }
    return fakeGh(argv)
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radar', args: '' })
  await new Promise(resolve => setTimeout(resolve, 80))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /GitHub API rate limit reached/ })).toBeDefined()
  await ui.unmount()
  const afterFailure = calls
  await $.command.run({ command: 'radar', args: 'refresh' })
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(calls).toBe(afterFailure)
})

test('/radar logs <repo> prints the failed steps of the latest run', { options: { owner: 'acme' } }, async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radar', args: '' })
  await new Promise(resolve => setTimeout(resolve, 80))
  const logs = (await $.command.run({ command: 'radar', args: 'logs web' })).text
  expect(logs).toContain('Failed steps of web › Web (main)')
  expect(logs).toContain('https://github.com/acme/web/actions/runs/20')
  expect(logs).toContain('Expected 200, got 500')
  expect(logs).not.toContain('2026-11-07T')
  expect((await $.command.run({ command: 'radar', args: 'logs api' })).text).toContain('did not fail')
  expect((await $.command.run({ command: 'radar', args: 'logs nope' })).text).toContain('not one of the watched repos')
})

test('/radar es switches the whole pane to Spanish', { options: { owner: 'acme' } }, async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = await $.command.run({ command: 'radar', args: 'es' })
  expect(ran.text).toContain('Vigilando acme')
  await new Promise(resolve => setTimeout(resolve, 80))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^✖/ }))?.text).toBe('✖ box-2 está desconectado · 1 job esperando (el más largo 12m00s)')
  expect((await ui.find({ type: 'Text', text: /box-1/ }))?.text).toContain('trabajando')
  expect((await ui.find({ type: 'Text', text: /box-2/ }))?.text).toContain('desconectado')
  expect((await ui.find({ type: 'Text', text: /api › lint/ }))?.text).toContain('su runner está ocupado, sigue en la fila')
  expect((await ui.find({ type: 'Text', text: /● web\s+✗\s+sin actividad/ }))).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^\s*✗ Web/ }))?.text).toContain('falló hace 12m00s en')
  expect(await ui.find({ type: 'Text', text: /2 vigilados/ })).toBeDefined()
  await ui.unmount()
})

test('the language option sets Spanish by default', { options: { owner: 'acme', language: 'es' } }, async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ command: 'radar', args: '' })).text).toContain('Vigilando acme')
})

test('without an owner, /radar explains how to set one', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ command: 'radar', args: '' })).text).toContain('Set the GitHub owner')
})

test('/radar rejects something that is not an owner name', { options: { owner: 'acme' } }, async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ command: 'radar', args: '../etc' })).text).toContain('is not a GitHub owner name')
})

test('/radar off stops polling', { options: { owner: 'acme' } }, async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ command: 'radar', args: 'off' })).text).toContain('stopped')
})

// ── Pure logic ──────────────────────────────────────────────────

const base = (over: Partial<Snapshot> = {}): Snapshot => ({
  owner: 'acme',
  updatedAt: NOW,
  runners: [{ id: 1, name: 'box-1', online: true, busy: false, labels: ['self-hosted', 'linux'] }],
  jobs: [],
  repos: [],
  runnerErrors: [],
  ...over,
})

const job = (id: number, minutesWaiting: number) => ({
  id,
  repo: 'api',
  workflow: 'CI',
  name: `job-${id}`,
  status: 'queued',
  runner: '',
  createdAt: NOW - minutesWaiting * MIN,
  startedAt: 0,
  selfHosted: true,
  labels: ['self-hosted', 'linux'],
})

test('duration formats seconds, minutes and hours', () => {
  expect(duration(35_000)).toBe('35s')
  expect(duration(250_000)).toBe('4m10s')
  expect(duration(62 * MIN)).toBe('1h02m')
})

test('queue sorts by longest wait and the status line reports it', () => {
  const s = base({ jobs: [job(1, 2), job(2, 9)] })
  expect(queue(s).map(j => j.id)).toEqual([2, 1])
  expect(statusLine(s, NOW, en)).toBe('radar · 1/1 online · 2 waiting · longest 9m00s')
  expect(statusLine(s, NOW, es)).toBe('radar · 1/1 conectados · 2 esperando · máx 9m00s')
})

test('queue includes only recognized pending self-hosted job statuses', () => {
  const statuses = ['queued', 'waiting', 'pending', 'requested', 'in_progress', 'completed', 'cancelled', 'success', 'failure', 'skipped', 'future_status']
  const jobs = statuses.map((status, i) => ({ ...job(i, i), status }))
  expect(queue(base({ jobs })).map(j => j.status)).toEqual(['requested', 'pending', 'waiting', 'queued'])
  expect(queue(base({ jobs: jobs.map(j => ({ ...j, selfHosted: false })) }))).toEqual([])
})

test('alerts fire once per episode: offline runner, queue size, long wait', () => {
  const memory = freshMemory()
  const config = { queueAlert: 2, waitAlertMinutes: 5 }
  const next = base({
    runners: [{ id: 1, name: 'box-1', online: false, busy: false, labels: [] }],
    jobs: [job(1, 6), job(2, 1)],
  })
  const first = alerts(base(), next, NOW, config, memory, en)
  expect(first).toContain('Runner box-1 went offline')
  expect(first).toContain('2 jobs waiting for a runner')
  expect(first.some(x => x.startsWith('api › job-1 has waited'))).toBe(true)
  expect(alerts(next, next, NOW, config, memory, en)).toEqual([])
})

test('waitReason: a missing label, offline runners, a working fleet', () => {
  const linux = { id: 1, name: 'box-1', online: true, busy: false, labels: ['self-hosted', 'Linux'] }
  const gpuJob = { ...job(1, 3), labels: ['self-hosted', 'gpu'] }
  expect(waitReason(gpuJob, [linux], en)).toEqual({ text: 'no runner has the label "gpu"', blocking: true })
  expect(waitReason(gpuJob, [linux], es)).toEqual({ text: 'ningún runner tiene la etiqueta "gpu"', blocking: true })
  expect(waitReason(job(2, 3), [{ ...linux, online: false }], en)).toEqual({ text: 'its runner is offline', blocking: true })
  expect(waitReason(job(3, 3), [{ ...linux, busy: true }], en)).toEqual({ text: "its runner is working, it's next", blocking: false })
  const two = [{ ...linux, busy: true }, { ...linux, id: 2, name: 'box-2', busy: true }]
  expect(waitReason(job(4, 3), two, en)?.text).toBe('all 2 of its runners are working')
  // Labels match case-insensitively; a free fit means it is about to start.
  expect(waitReason(job(5, 3), [linux], en)).toBeUndefined()
})

test('partial runner inventory never claims a missing label or offline fleet is definitive', () => {
  const gpuJob = { ...job(1, 3), labels: ['self-hosted', 'gpu'] }
  const partial = base({ runnerErrors: [{ repo: 'private', error: apiError('HTTP 403: Forbidden') }] })
  expect(reasonFor(gpuJob, partial, en)).toEqual({ text: 'no visible runner has the label "gpu" (runner list incomplete)', blocking: false })
  expect(reasonFor(gpuJob, partial, es)?.text).toContain('ningún runner visible')
  expect(reasonFor(job(2, 3), { ...partial, runners: [{ id: 1, name: 'box', online: false, busy: false, labels: ['self-hosted', 'linux'] }] }, en)?.text)
    .toContain('visible runners are offline')
  expect(reasonFor(gpuJob, base({ error: apiError('network error') }), en)).toBeUndefined()
  expect(partialWarning(partial, en)).toContain('private')
  expect(headline(partial, NOW, { queueAlert: 5, waitAlertMinutes: 10 }, en).level).toBe('warn')
})

test('pane layout keeps summary below 40 body columns and compacts narrow views', () => {
  expect(layout(39)).toBe('summary')
  expect(layout(40)).toBe('compact')
  expect(layout(71)).toBe('compact')
  expect(layout(72)).toBe('full')
})

test('GitHub errors are classified into actionable categories', () => {
  expect(apiError('API rate limit exceeded').kind).toBe('rateLimit')
  expect(apiError('gh auth login required').kind).toBe('auth')
  expect(apiError('HTTP 403: Forbidden').kind).toBe('forbidden')
  expect(apiError('connect ETIMEDOUT').kind).toBe('network')
})

test('headline: all good, a warning on a long wait, bad when a job cannot start', () => {
  const config = { queueAlert: 5, waitAlertMinutes: 10 }
  expect(headline(base(), NOW, config, en)).toEqual({ level: 'ok', text: 'All good · 1 runner free' })
  expect(headline(base(), NOW, config, es)).toEqual({ level: 'ok', text: 'Todo bien · 1 runner libre' })
  const busyFleet = [{ id: 1, name: 'box-1', online: true, busy: true, labels: ['self-hosted', 'linux'] }]
  expect(headline(base({ runners: busyFleet, jobs: [job(1, 6)] }), NOW, config, en).level).toBe('warn')
  const gpu = { ...job(2, 1), labels: ['self-hosted', 'gpu'] }
  expect(headline(base({ jobs: [gpu] }), NOW, config, en)).toEqual({
    level: 'bad',
    text: "1 job can't start · 1 job waiting (longest 1m00s)",
  })
  expect(waitLevel(4 * MIN, 10)).toBe('ok')
  expect(waitLevel(5 * MIN, 10)).toBe('warn')
  expect(waitLevel(10 * MIN, 10)).toBe('bad')
})

test('parseRepos accepts names and owner/name, trims and drops blanks', () => {
  expect(parseRepos(' api, acme/web ,, ')).toEqual(['api', 'web'])
  expect(parseRepos('')).toEqual([])
})

// ── Savings ─────────────────────────────────────────────────────

import { billableMinutes } from '../hooks/github'
import { dayKey, grouped, money, monthKey, readMonth, storeKey, summarize } from '../hooks/savings'

test('billable minutes round each job up, and a job that never ran is free', () => {
  expect(billableMinutes(0)).toBe(0)
  expect(billableMinutes(1)).toBe(1)
  expect(billableMinutes(60)).toBe(1)
  expect(billableMinutes(61)).toBe(2)
})

test('month and day keys are UTC, and the store key is per owner and month', () => {
  expect(monthKey(NOW)).toBe('2026-11')
  expect(dayKey(Date.UTC(2026, 10, 30, 23, 59))).toBe('2026-11-30')
  expect(storeKey('Acme', '2026-11')).toBe('usage:acme:2026-11')
})

test('summarize totals the month, today and repos; malformed store data is dropped', () => {
  const usage = readMonth({
    '1': ['api', '2026-11-07', 10, 0],
    '2': ['api', '2026-11-02', 5, 3],
    '3': ['web', '2026-11-07', 2, 0],
    bad: ['web', 7, 'x', 0],
  })
  expect(Object.keys(usage)).toEqual(['1', '2', '3'])
  const s = summarize(usage, { owner: 'acme', month: '2026-11', today: '2026-11-07', pricePerMinute: 0.006, runsPending: 4, updatedAt: NOW })
  expect(s.monthMinutes).toBe(17)
  expect(s.todayMinutes).toBe(12)
  expect(s.hostedMinutes).toBe(3)
  expect(s.perRepo).toEqual([{ repo: 'api', minutes: 15 }, { repo: 'web', minutes: 2 }])
  expect(s.runsCounted).toBe(3)
  expect(money(6400, 0.006)).toBe('$38.40')
  expect(money(1, 0.006)).toBe('<$0.01')
  expect(grouped(6400, ',')).toBe('6,400')
  expect(grouped(1228, '.')).toBe('1.228')
})

/** fakeGh plus the savings calls: this month's completed runs and their jobs' minutes. */
function savingsGh(calls: string[]) {
  return (argv: readonly string[]) => {
    const path = argv[2] ?? ''
    const ok = (v: unknown) => ({ exitCode: 0, stdout: JSON.stringify(v), stderr: '' })
    if (path.includes('status=completed')) {
      calls.push(`list ${path.split('/')[2]}`)
      if (path.startsWith('repos/acme/api/')) {
        return ok([
          { id: 9, created_at: iso(60 * MIN) },
          { id: 8, created_at: '2026-11-02T10:00:00Z' },
        ])
      }
      if (path.startsWith('repos/acme/web/')) return ok([{ id: 20, created_at: iso(15 * MIN) }])
      return ok([])
    }
    const minutes = /runs\/(\d+)\/jobs\?filter=all/.exec(path)
    if (minutes) {
      calls.push(`jobs ${minutes[1]}`)
      const byRun: Record<string, Array<{ sh: boolean; s: number }>> = {
        '9': [{ sh: true, s: 61 }, { sh: true, s: 30 }, { sh: false, s: 120 }],
        '8': [{ sh: true, s: 600 }],
        '20': [{ sh: true, s: 59 }],
      }
      return ok(byRun[minutes[1] ?? ''] ?? [])
    }
    return fakeGh(argv)
  }
}

test('savings: the pane and /radar savings show the month, today and repos', { options: { owner: 'acme' } }, async ($, on) => {
  const calls: string[] = []
  const store = new Map<string, unknown>()
  engine(on, [], savingsGh(calls), store)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radar', args: '' })
  await new Promise(resolve => setTimeout(resolve, 120))

  // 9: 2+1 min on your runners (+2 hosted) · 8: 10 min · 20: 1 min = 14 min, $0.084
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /💰/ }))?.text).toContain('💰 $0.08 saved · 14 min on your runners')
  expect((await ui.find({ type: 'Text', text: /^\s*today/ }))?.text).toContain('today $0.02 · 4 min')
  expect((await ui.find({ type: 'Text', text: /api \$0\.08/ }))?.text).toContain('api $0.08 · web <$0.01')
  await ui.unmount()

  // Each run was looked up once and kept by run id for the month.
  expect(calls.filter(c => c.startsWith('jobs')).sort()).toEqual(['jobs 20', 'jobs 8', 'jobs 9'])
  expect(Object.keys(store.get('usage:acme:2026-11') as object).sort()).toEqual(['20', '8', '9'])

  const report = (await $.command.run({ command: 'radar', args: 'savings' })).text
  expect(report).toContain('$0.08 saved · 14 billable minutes on your self-hosted runners')
  expect(report).toContain('today: $0.02 · 4 min')
  expect(report).toContain('2 min still ran on GitHub-hosted runners')
  expect(report).toContain('Price: $0.006/min')
  // The second pass only lists runs; nothing counted before is looked up again.
  expect(calls.filter(c => c.startsWith('jobs')).length).toBe(3)
})

test('savings in Spanish, and off when the option says so', { options: { owner: 'acme', savings: false } }, async ($, on) => {
  engine(on, [], savingsGh([]))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ command: 'radar', args: 'ahorro' })).text).toContain('savings counter is off')
  expect(es.savings.total('$7.37', grouped(1228, es.savings.thousands))).toBe('💰 $7.37 ahorrados · 1.228 min en tus runners')
})
