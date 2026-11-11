import { expect, test } from 'claude-code/testing'

import { strings } from '../hooks/i18n'
import { alerts, apiError, duration, freshMemory, headline, layout, parseRepos, partialWarning, queue, reasonFor, statusLine, unscheduled, waitLevel, waitReason } from '../hooks/logic'
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

type GhResult = ReturnType<typeof fakeGh>

function engine(
  on: On,
  toasts: string[] = [],
  runGh: (argv: readonly string[]) => GhResult | Promise<GhResult> = argv => fakeGh(argv),
  store: Map<string, unknown> = new Map(),
  clock: () => number = () => NOW,
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
  on('clock.now', () => ({ value: clock() }))
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text: string }).text))
    return { value: undefined }
  })
  on('process.run', async (_, e) => ({ value: await runGh((e as { argv: readonly string[] }).argv) }))
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

test('runs GitHub has queued without creating jobs are shown per repo and in the headline', { options: { owner: 'acme' } }, async ($, on) => {
  // Two queued runs whose job lists are empty: GitHub has not scheduled them,
  // so no runner can take them and the queue cannot list them.
  engine(on, [], argv => {
    const path = argv[2] ?? ''
    if (path.startsWith('repos/acme/api/actions/runs?')) {
      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify([
          { id: 12, name: 'CI', status: 'queued', conclusion: null, created_at: iso(2 * MIN) },
          { id: 11, name: 'DB', status: 'queued', conclusion: null, created_at: iso(14 * MIN) },
          { id: 10, name: 'CI', status: 'in_progress', conclusion: null, created_at: iso(20 * MIN) },
          { id: 9, name: 'CI', status: 'completed', conclusion: 'success', created_at: iso(60 * MIN) },
        ]),
      }
    }
    if (path.startsWith('repos/acme/api/actions/runs/11/jobs') || path.startsWith('repos/acme/api/actions/runs/12/jobs')) {
      return { exitCode: 0, stdout: '[]', stderr: '' }
    }
    return fakeGh(argv)
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radar', args: '' })
  await new Promise(resolve => setTimeout(resolve, 80))

  // Wide enough that the headline is not cut.
  const wide = { ...PANE, viewport: { columns: 150, rows: 60 }, surface: 'terminal' as const }
  const ui = await $.ui.mount(wide)
  expect((await ui.find({ type: 'Text', text: /^✖/ }))?.text).toBe(
    '✖ box-2 is offline · 1 job waiting (longest 12m00s) · 2 runs queued at GitHub, no jobs yet (longest 14m00s)',
  )
  // The queue still lists only real jobs; the repo row says what GitHub is holding.
  expect(await ui.find({ type: 'Text', text: /Waiting for a runner\s+1 job/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /api.*1 running · 2 waiting/ }))?.text).toContain('2 runs queued, no jobs yet (14m00s)')
  await ui.unmount()

  await $.command.run({ command: 'radar', args: 'es' })
  await new Promise(resolve => setTimeout(resolve, 80))
  const es = await $.ui.mount(wide)
  expect((await es.find({ type: 'Text', text: /^✖/ }))?.text).toContain('2 runs en cola en GitHub, sin jobs aún (el más largo 14m00s)')
  expect((await es.find({ type: 'Text', text: /api.*1 corriendo · 2 esperando/ }))?.text).toContain('2 runs en cola sin jobs aún (14m00s)')
  await es.unmount()
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

const repoSummary = (repo: string, unscheduled: number, minutesAgo: number) => ({
  repo,
  running: 0,
  queued: 0,
  unscheduled,
  unscheduledSince: unscheduled ? NOW - minutesAgo * MIN : 0,
  recent: [],
})

test('unscheduled runs: counted across repos, oldest first, in the headline and status line', () => {
  const config = { queueAlert: 5, waitAlertMinutes: 10 }
  const repos = [repoSummary('api', 2, 3), repoSummary('web', 1, 7), repoSummary('docs', 0, 0)]
  expect(unscheduled(base({ repos }))).toEqual({ count: 3, since: NOW - 7 * MIN })
  expect(unscheduled(base())).toEqual({ count: 0, since: 0 })

  // Nothing in the job queue: the headline still says what GitHub is holding, ok while recent.
  expect(headline(base({ repos }), NOW, config, en)).toEqual({
    level: 'warn',
    text: '3 runs queued at GitHub, no jobs yet (longest 7m00s)',
  })
  expect(headline(base({ repos: [repoSummary('api', 1, 2)] }), NOW, config, en)).toEqual({
    level: 'ok',
    text: '1 run queued at GitHub, no jobs yet (longest 2m00s)',
  })
  expect(headline(base({ repos: [repoSummary('api', 1, 2)] }), NOW, config, es).text).toBe(
    '1 run en cola en GitHub, sin jobs aún (el más largo 2m00s)',
  )
  // Alongside a real queue, and a bad headline keeps it too.
  expect(headline(base({ repos, jobs: [job(1, 1)] }), NOW, config, en).text).toBe(
    '1 job waiting (longest 1m00s) · 3 runs queued at GitHub, no jobs yet (longest 7m00s)',
  )
  const gpu = { ...job(2, 1), labels: ['self-hosted', 'gpu'] }
  expect(headline(base({ repos, jobs: [gpu] }), NOW, config, en)).toEqual({
    level: 'bad',
    text: "1 job can't start · 1 job waiting (longest 1m00s) · 3 runs queued at GitHub, no jobs yet (longest 7m00s)",
  })

  expect(statusLine(base({ repos }), NOW, en)).toBe('radar · 1/1 online · 3 runs without jobs yet')
  expect(statusLine(base({ repos, jobs: [job(1, 2)] }), NOW, es)).toBe('radar · 1/1 conectados · 1 esperando · máx 2m00s · 3 runs sin jobs aún')
  // Unscheduled runs are never in the job queue nor its alerts.
  expect(queue(base({ repos }))).toEqual([])
  expect(alerts(null, base({ repos }), NOW, config, freshMemory(), en)).toEqual([])
})

test('parseRepos accepts names and owner/name, trims and drops blanks', () => {
  expect(parseRepos(' api, acme/web ,, ')).toEqual(['api', 'web'])
  expect(parseRepos('')).toEqual([])
})

// ── Hosted-equivalent estimate ──────────────────────────────────

import { cooldownEnd, freshLimiter, isRateLimited, pause, splitHead } from '../hooks/limiter'
import {
  addJob,
  addJobsPage,
  afterHead,
  billableMinutes,
  dayKey,
  freshProgress,
  freshRepo,
  grouped,
  isComplete,
  money,
  monthKey,
  readRepo,
  repoKey,
  stepSegment,
  summarize,
  windowStart,
} from '../hooks/savings'

type FJob = { a?: number; sh: boolean; st: string; ct: string }
type FRun = { id: number; c: string; st?: string; a?: number; jobs: FJob[] }
type Model = Record<string, FRun[]>

/** A job that started at `start` and ran `seconds`. */
const ran = (start: string, seconds: number, sh = true, a = 1): FJob => ({
  a,
  sh,
  st: start,
  ct: new Date(Date.parse(start) + seconds * 1000).toISOString(),
})

const ok = (v: unknown): GhResult => ({ exitCode: 0, stdout: JSON.stringify(v), stderr: '' })
const ROUTE = /^repos\/acme\/([^/]+)\/actions\/runs(?:\?(.*)|\/(\d+)(?:\/jobs\?(.*))?)$/

/** The counter's request paths, by kind; everything else goes to fakeGh (the radar). */
function counterPath(path: string): RegExpExecArray | undefined {
  const m = ROUTE.exec(path)
  if (!m) return undefined
  if (m[2] !== undefined) return m[2].includes('per_page=100') ? m : undefined
  if (m[4] === undefined) return m
  return m[4].includes('filter=all') ? m : undefined
}

/**
 * A fake GitHub for the counter: runs newest first, `created` ranges and the
 * 1,000-result cap, single runs, and job pages; `hook` can answer first.
 */
function github(
  model: Model,
  calls: string[],
  hook?: (path: string) => GhResult | Promise<GhResult> | undefined,
  radar: (argv: readonly string[]) => GhResult | Promise<GhResult> = fakeGh,
) {
  return async (argv: readonly string[]): Promise<GhResult> => {
    const path = argv[2] ?? ''
    const m = counterPath(path)
    if (!m) return radar(argv)
    calls.push(path)
    const hooked = await hook?.(path)
    if (hooked) return hooked
    const runs = [...(model[m[1] ?? ''] ?? [])].sort((a, b) => Date.parse(b.c) - Date.parse(a.c))
    const listed = (r: FRun) => ({ id: r.id, st: r.st ?? 'completed', a: r.a ?? 1, c: r.c })
    if (m[2] !== undefined) {
      const q = new URLSearchParams(m[2])
      const page = Number(q.get('page') ?? 1)
      let rs = runs
      const created = q.get('created')
      if (created) {
        const [from, to] = created.split('..').map(x => Date.parse(x))
        rs = page > 10 ? [] : rs.filter(r => Date.parse(r.c) >= (from ?? 0) && Date.parse(r.c) <= (to ?? 0))
      }
      return ok(rs.slice((page - 1) * 100, page * 100).map(listed))
    }
    const run = runs.find(r => r.id === Number(m[3]))
    if (!run) return { exitCode: 1, stdout: '', stderr: 'HTTP 404: Not Found' }
    if (m[4] === undefined) return ok(listed(run))
    const page = Number(new URLSearchParams(m[4]).get('page') ?? 1)
    return ok({ t: run.jobs.length, j: run.jobs.slice((page - 1) * 100, page * 100).map(j => ({ ...j, a: j.a ?? 1 })) })
  }
}

const jobCalls = (calls: string[], id?: number) =>
  calls.filter(c => c.includes('/jobs?filter=all') && (id === undefined || c.includes(`/runs/${id}/`)))

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * A store that notes the request count each time a counter pass ends (its
 * last write), whoever started the pass: a command, a refresh or a catch-up.
 */
function passStore(calls: string[], entries: Array<[string, unknown]> = []) {
  const ends: number[] = []
  class PassMap extends Map<string, unknown> {
    override set(key: string, value: unknown) {
      if (key === 'scan2meta:acme') ends.push(calls.length)
      return super.set(key, value)
    }
  }
  const store = new PassMap(entries)
  const perPass = () => ends.map((n, i) => n - (ends[i - 1] ?? 0))
  return { store, perPass }
}

/** api: run 9 today (2+1 min here, 2 hosted) and run 8 on Nov 2 (10 min); web: run 20 (1 min). */
const basicModel = (): Model => ({
  api: [
    { id: 9, c: iso(60 * MIN), jobs: [ran(iso(50 * MIN), 61), ran(iso(50 * MIN), 30), ran(iso(50 * MIN), 120, false)] },
    { id: 8, c: '2026-11-02T10:00:00Z', jobs: [ran('2026-11-02T10:01:00Z', 600)] },
  ],
  web: [{ id: 20, c: iso(15 * MIN), jobs: [ran(iso(14 * MIN), 59)] }],
})

test('hosted equivalent: the pane and /radar savings show the month, today, repos and caveats', { options: { owner: 'acme' } }, async ($, on) => {
  const calls: string[] = []
  const store = new Map<string, unknown>()
  engine(on, [], github(basicModel(), calls), store)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radar', args: '' })
  await sleep(150)

  // 9: 2+1 min on your runners (+2 hosted) · 8: 10 min · 20: 1 min = 14 min, $0.084
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Hosted equivalent/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /≈/ }))?.text).toContain('≈ $0.08 estimated GitHub-hosted equivalent · 14 min on your runners')
  expect((await ui.find({ type: 'Text', text: /^\s*today/ }))?.text).toContain('today $0.02 · 4 min')
  expect((await ui.find({ type: 'Text', text: /api \$0\.08/ }))?.text).toContain('api $0.08 · web <$0.01')
  expect(await ui.find({ type: 'Text', text: /all runs created since 2026-10-02 counted/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /public repos and included plan minutes may mean \$0 extra/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /last complete update/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /saved/ })).toBeUndefined()
  await ui.unmount()

  // Each run was fetched once and kept by owner and repo.
  expect(jobCalls(calls).length).toBe(3)
  expect(Object.keys(readRepo(store.get(repoKey('acme', 'api'))).runs).sort()).toEqual(['8', '9'])

  const report = (await $.command.run({ command: 'radar', args: 'savings' })).text
  expect(report).toContain('≈ $0.08 estimated GitHub-hosted equivalent · 14 minutes on your self-hosted runners')
  expect(report).toContain('today: $0.02 · 4 min')
  expect(report).toContain('2 min ran on GitHub-hosted runners')
  expect(report).toContain('Comparison rate: $0.006/min')
  expect(report).toContain('not a bill and not money you saved')
  expect(report).toContain('free for public repositories')
  expect(report).toContain("plan's included minutes")
  expect(report).toContain('hardware, power and maintenance are not subtracted')
  expect(report).toContain('may not perform like the selected hosted runner')
  expect(report).toContain('assigned to the UTC day the job finished')
  expect(report).toContain('at most 30 requests per pass and 150 per hour')
  expect(report).not.toMatch(/\$[\d.]+ saved/)
  // The second pass only lists the newest runs; nothing counted is fetched again.
  expect(jobCalls(calls).length).toBe(3)
})

// Shared by the next two tests: the second one is a restart on the first one's store.
const restartStore = new Map<string, unknown>()
const rerunModel: Model = { api: [{ id: 9, c: iso(60 * MIN), jobs: [ran(iso(50 * MIN), 61), ran(iso(50 * MIN), 30)] }] }

test('repeated passes never double count; a later attempt adds its minutes exactly once', { options: { owner: 'acme' } }, async ($, on) => {
  const calls: string[] = []
  engine(on, [], github(rerunModel, calls), restartStore)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radar', args: '' })
  await sleep(120)
  const savings = async () => (await $.command.run({ command: 'radar', args: 'savings' })).text
  for (let i = 0; i < 3; i++) expect(await savings()).toContain('· 3 minutes on your self-hosted runners')
  expect(jobCalls(calls).length).toBe(1)

  // Re-run: attempt 2 adds a 2m05s job (3 min). Attempt 1 is not counted again.
  const run = rerunModel.api?.[0] as FRun
  run.a = 2
  run.jobs.push(ran(iso(5 * MIN), 125, true, 2))
  expect(await savings()).toContain('· 6 minutes on your self-hosted runners')
  for (let i = 0; i < 3; i++) expect(await savings()).toContain('· 6 minutes on your self-hosted runners')
  expect(jobCalls(calls, 9).length).toBe(2)
})

test('after a restart the stored totals are reused, not fetched or added again', { options: { owner: 'acme' } }, async ($, on) => {
  const calls: string[] = []
  engine(on, [], github(rerunModel, calls), restartStore)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radar', args: '' })
  await sleep(120)
  const report = (await $.command.run({ command: 'radar', args: 'savings' })).text
  expect(report).toContain('· 6 minutes on your self-hosted runners')
  expect(report).toContain('all runs created since 2026-10-02 counted')
  expect(jobCalls(calls).length).toBe(0)
})

test('more than 300 runs are all counted over several passes, incomplete until then; the 0.3.0 cache is rebuilt', { options: { owner: 'acme' } }, async ($, on) => {
  const calls: string[] = []
  let now = NOW
  const { store, perPass } = passStore(calls, [['usage:acme:2026-11', { '1': ['api', '2026-11-07', 10, 0] }]])
  const runs: FRun[] = []
  for (let i = 0; i < 350; i++) {
    const c = new Date(NOW - i * 20 * MIN - 5 * MIN).toISOString()
    runs.push({ id: 1000 + i, c, jobs: [ran(new Date(Date.parse(c) + MIN).toISOString(), 60)] })
  }
  engine(on, [], github({ api: runs }, calls), store, () => now)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radar', args: '' })
  await sleep(200)
  expect(store.has('usage:acme:2026-11')).toBe(false)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /recalculating: 0\.3\.1 dates minutes/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /incomplete: totals grow/ })).toBeDefined()
  await ui.unmount()

  const reports: string[] = []
  for (let pass = 0; pass < 40; pass++) {
    now += 13 * MIN
    const text = (await $.command.run({ command: 'radar', args: 'savings' })).text
    reports.push(text)
    if (text.includes('all runs created since')) break
  }
  expect(reports[0]).toContain('incomplete')
  expect(reports.some(r => /counting runs… \d+ of 350/.test(r))).toBe(true)
  expect(reports.slice(0, -1).every(r => !r.includes('all runs created since'))).toBe(true)
  const last = reports[reports.length - 1] ?? ''
  expect(last).toContain('≈ $2.10 estimated GitHub-hosted equivalent · 350 minutes')
  expect(last).not.toContain('recalculating')
  expect(Math.max(...perPass())).toBeLessThanOrEqual(30)
  // Every run fetched exactly once.
  expect(new Set(jobCalls(calls)).size).toBe(350)
  expect(jobCalls(calls).length).toBe(350)
})

test('a run with more than 100 jobs over two attempts is counted in full; a failed page 2 never finalizes it', { options: { owner: 'acme' } }, async ($, on) => {
  const calls: string[] = []
  const start = iso(3 * 60 * MIN)
  const jobs = [
    ...Array.from({ length: 100 }, () => ran(start, 60, true, 1)),
    ...Array.from({ length: 50 }, () => ran(iso(60 * MIN), 60, true, 2)),
  ]
  let failures = 0
  engine(on, [], github({ api: [{ id: 30, c: start, a: 2, jobs }] }, calls, path => {
    if (path.includes('/runs/30/jobs') && path.includes('page=2') && failures < 2) {
      failures++
      return { exitCode: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway' }
    }
    return undefined
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radar', args: '' })
  await sleep(150)

  // Page 1 (100 jobs) counted nowhere yet; the failure and the gap are on screen.
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /≈/ }))?.text).toContain('≈ $0.00 estimated GitHub-hosted equivalent · 0 min')
  expect(await ui.find({ type: 'Text', text: /last update failed: could not reach GitHub/ })).toBeDefined()
  // Cut to the pane width: "incomplete: totals grow as history is counted · counting runs… 0 o…"
  expect(await ui.find({ type: 'Text', text: /incomplete.*counting runs… 0/ })).toBeDefined()
  await ui.unmount()

  const en = (await $.command.run({ command: 'radar', args: 'savings' })).text
  expect(en).toContain('· 0 minutes on your self-hosted runners')
  expect(en).toContain('✖ last update failed: could not reach GitHub')
  expect(en).toContain('⚠ incomplete: totals grow as history is counted · counting runs… 0 of 1')

  await $.command.run({ command: 'radar', args: 'es' })
  await sleep(80)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Coste equivalente/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /falló la última actualización: no se pudo conectar con GitHub/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /incompleto: el total crece/ })).toBeDefined()
  await ui.unmount()

  const es = (await $.command.run({ command: 'radar', args: 'ahorro' })).text
  expect(es).toContain('≈ $0.90 coste equivalente estimado · 150 minutos en tus runners self-hosted')
  expect(es).toContain('contados todos los runs creados desde 2026-10-02')
  expect(es).not.toContain('falló')
  // Page 1 was kept and not fetched again; page 2 was retried until it worked.
  expect(calls.filter(c => c.includes('/runs/30/jobs') && c.endsWith('page=1')).length).toBe(1)
  expect(calls.filter(c => c.includes('/runs/30/jobs') && c.endsWith('page=2')).length).toBe(3)
})

test('the request budget holds across repeated /radar savings commands', { options: { owner: 'acme' } }, async ($, on) => {
  const calls: string[] = []
  const runs: FRun[] = Array.from({ length: 400 }, (_, i) => {
    const c = new Date(NOW - i * 10 * MIN - MIN).toISOString()
    return { id: 5000 + i, c, jobs: [ran(c, 30)] }
  })
  const { store, perPass } = passStore(calls)
  engine(on, [], github({ api: runs }, calls), store)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radar', args: '' })
  await sleep(200)
  let last = ''
  for (let i = 0; i < 10; i++) last = (await $.command.run({ command: 'radar', args: 'savings' })).text
  // At most 30 per pass and 150 per rolling hour: discovery, job pages, retries,
  // catch-up and manual passes included.
  expect(perPass().length).toBeGreaterThanOrEqual(10)
  expect(Math.max(...perPass())).toBeLessThanOrEqual(30)
  expect(calls.length).toBe(150)
  expect(last).toContain('request budget used: continues after')
  expect(last).toContain('incomplete')
})

test('a rate limit during discovery stops the pass and pauses the radar; a concurrent successful refresh keeps the pause', { options: { owner: 'acme', repos: 'api,web' } }, async ($, on) => {
  const calls: string[] = []
  const all: string[] = []
  let now = NOW
  let armed = false
  let slowRadar = false
  const radarGh = async (argv: readonly string[]) => {
    if (slowRadar) await sleep(80)
    // No active or failed runs: a refresh that succeeds with no follow-up request.
    if (/\/actions\/runs\?per_page=20$/.test(argv[2] ?? '')) return ok([])
    return fakeGh(argv)
  }
  engine(on, [], async argv => {
    all.push(argv[2] ?? '')
    return github({}, calls, async path => {
      if (!armed || !path.startsWith('repos/acme/api/actions/runs?')) return undefined
      await sleep(40)
      return {
        exitCode: 1,
        stdout: 'HTTP/2.0 403 Forbidden\r\nRetry-After: 3600\r\nX-Ratelimit-Remaining: 4000\r\n\r\n{"message":"You have exceeded a secondary rate limit"}',
        stderr: 'gh: You have exceeded a secondary rate limit (HTTP 403)',
      }
    }, radarGh)(argv)
  }, new Map(), () => now)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radar', args: '' })
  await sleep(150)
  // Headers are asked for on every API call, no separate quota request.
  expect(all.length).toBeGreaterThan(0)

  armed = true
  slowRadar = true
  const before = calls.length
  const pass = $.command.run({ command: 'radar', args: 'savings' })
  await sleep(5)
  await $.command.run({ command: 'radar', args: 'refresh' }) // radar requests now in flight
  const report = (await pass).text
  await sleep(150) // the radar refresh finishes successfully after the rate limit
  expect(calls.length - before).toBe(1) // web's discovery was never requested
  expect(report).toContain('paused by a GitHub rate limit until')
  expect(report).toContain('last update failed: GitHub API rate limit reached')

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /paused by a GitHub rate limit/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /GitHub API rate limit reached/ })).toBeDefined()
  await ui.unmount()

  // The successful refresh did not end the cooldown: Retry-After (1 hour) holds.
  slowRadar = false
  const held = all.length
  now += 61_000
  await $.command.run({ command: 'radar', args: 'refresh' })
  await sleep(40)
  now += 20 * MIN
  const stale = (await $.command.run({ command: 'radar', args: 'savings' })).text
  expect(all.length).toBe(held)
  expect(stale).toContain('not updating · last complete update')
  expect(stale).toContain('paused by a GitHub rate limit')
  await $.command.run({ command: 'radar', args: 'es' })
  await sleep(40)
  const staleEs = (await $.command.run({ command: 'radar', args: 'ahorro' })).text
  expect(staleEs).toContain('sin actualizar · última actualización completa')
  expect(staleEs).toContain('en pausa por el límite de la API de GitHub')
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /sin actualizar · última actualización completa/ })).toBeDefined()
  await ui.unmount()
  expect(all.length).toBe(held)

  // After Retry-After, requests resume.
  now = NOW + 3_601_000
  armed = false
  await $.command.run({ command: 'radar', args: 'refresh' })
  await sleep(80)
  expect(all.length).toBeGreaterThan(held)
})

test('passes never overlap, and an owner change mid-pass publishes nothing stale and does not resume', { options: { owner: 'acme' } }, async ($, on) => {
  const calls: string[] = []
  let slow = false
  // Small enough to finish within the hourly budget before the checks below.
  const runs: FRun[] = Array.from({ length: 20 }, (_, i) => {
    const c = new Date(NOW - i * 10 * MIN - MIN).toISOString()
    return { id: 7000 + i, c, jobs: [ran(c, 30)] }
  })
  engine(on, [], github({ api: runs }, calls, async () => {
    if (slow) await sleep(30)
    return undefined
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radar', args: '' })
  await sleep(200)

  // Two commands at once share one pass: the newest page is listed once.
  const heads = () => calls.filter(c => c === 'repos/acme/api/actions/runs?per_page=100&page=1').length
  const before = heads()
  await Promise.all([
    $.command.run({ command: 'radar', args: 'savings' }),
    $.command.run({ command: 'radar', args: 'savings' }),
  ])
  expect(heads() - before).toBe(1)

  // Switch owner while a slow pass is in flight.
  slow = true
  const pass = $.command.run({ command: 'radar', args: 'savings' })
  await sleep(10)
  await $.command.run({ command: 'radar', args: 'beta' })
  const atSwitch = calls.length
  await pass
  await sleep(150)
  // The request in flight finished; no further acme request, no catch-up.
  const after = calls.length
  expect(after).toBe(atSwitch)
  // Nothing of acme is shown as beta's.
  expect((await $.command.run({ command: 'radar', args: 'savings' })).text).not.toContain('estimated GitHub-hosted equivalent ·')
  expect(calls.length).toBe(after)
})

test('minutes are dated by job completion in UTC: midnight, month end, and an old run re-run this month', { options: { owner: 'acme' } }, async ($, on) => {
  const calls: string[] = []
  engine(on, [], github({
    api: [
      // Created Oct 20, re-run today: only attempt 2 (3 min) is in November.
      { id: 50, c: '2026-10-20T10:00:00Z', a: 2, jobs: [ran('2026-10-20T10:01:00Z', 600, true, 1), ran(iso(30 * MIN), 180, true, 2)] },
      // Created Oct 31 before midnight, finished in November: 10 min, all in November.
      { id: 51, c: '2026-10-31T23:50:00Z', jobs: [ran('2026-10-31T23:55:00Z', 600)] },
      // Created before the window: never looked at.
      { id: 52, c: '2026-09-20T10:00:00Z', jobs: [ran('2026-09-20T10:00:00Z', 600)] },
    ],
  }, calls))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radar', args: '' })
  await sleep(150)
  const report = (await $.command.run({ command: 'radar', args: 'savings' })).text
  expect(report).toContain('· 13 minutes on your self-hosted runners')
  expect(report).toContain('today: $0.02 · 3 min')
  expect(jobCalls(calls, 52).length).toBe(0)
  expect(jobCalls(calls).length).toBe(2)
})

test('UTC day attribution rounds each job once and never splits it', () => {
  const d = {}
  // 70 s across midnight: 2 min, all on the day it finished.
  addJob(d, { a: 1, sh: true, st: '2026-11-07T23:59:30Z', ct: '2026-11-08T00:00:40Z' })
  // 3m30s across the month end: 4 min, all in November.
  addJob(d, { a: 1, sh: true, st: '2026-10-31T23:58:00Z', ct: '2026-11-01T00:01:30Z' })
  // Never started: nothing.
  addJob(d, { a: 1, sh: true, st: null, ct: '2026-11-01T00:01:30Z' })
  addJob(d, { a: 1, sh: false, st: '2026-11-07T10:00:00Z', ct: '2026-11-07T10:00:01Z' })
  expect(d).toEqual({ '2026-11-08': [2, 0], '2026-11-01': [4, 0], '2026-11-07': [0, 1] })
  const total = Object.values(d as Record<string, [number, number]>).reduce((s, [a, b]) => s + a + b, 0)
  expect(total).toBe(billableMinutes(70) + billableMinutes(210) + billableMinutes(1))
})

test('job pages: a changed job count restarts the fetch; a short page ends it', () => {
  const p = freshProgress(1)
  const job = ran('2026-11-07T10:00:00Z', 60)
  expect(addJobsPage(p, { total: 150, jobs: Array(100).fill(job) })).toBe('more')
  expect(addJobsPage(p, { total: 160, jobs: Array(50).fill(job) })).toBe('restart')
  const q = freshProgress(1)
  addJobsPage(q, { total: 150, jobs: Array(100).fill(job) })
  expect(addJobsPage(q, { total: 150, jobs: Array(50).fill(job) })).toBe('done')
  expect(q.d).toEqual({ '2026-11-07': [150, 0] })
})

test('history scans resume from a stored cursor and narrow the range past 1,000 results', () => {
  const win = windowStart(NOW)
  const state = freshRepo()
  const page = (from: number) =>
    Array.from({ length: 100 }, (_, i) => ({ id: from + i, st: 'completed', a: 1, c: NOW - (from + i) * MIN }))
  afterHead(state, page(0), win, NOW)
  expect(state.segs).toEqual([{ from: win, to: NOW - 99 * MIN, page: 1 }])
  expect(isComplete(state, win)).toBe(false)
  const seg = state.segs[0]
  if (!seg) throw new Error('no segment')
  seg.page = 10
  stepSegment(state, seg, page(1000), win, NOW)
  expect(seg).toMatchObject({ page: 1, to: NOW - 1099 * MIN })
  // A stored state survives a round trip; malformed parts are dropped.
  const back = readRepo(JSON.parse(JSON.stringify({ ...state, runs: { ...state.runs, x: { c: 'bad' } } })))
  expect(back.segs).toEqual(state.segs)
  expect(Object.keys(back.runs).length).toBe(Object.keys(state.runs).length)
  stepSegment(state, seg, page(1100).slice(0, 10), win, NOW)
  expect(state.segs).toEqual([])
  expect(isComplete(state, win)).toBe(true)
})

test('rate-limit headers: retry-after, then the reset time, else a minute; a pause is never shortened', () => {
  const head = (h: string) => splitHead(`HTTP/2.0 403 Forbidden\r\n${h}\r\n\r\n{"message":"x"}`).head
  expect(splitHead('HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 4999\r\n\r\n[1,2]')).toEqual({
    head: { status: 200, headers: { 'x-ratelimit-remaining': '4999' } },
    body: '[1,2]',
  })
  expect(splitHead('[1,2]')).toEqual({ body: '[1,2]' })
  expect(cooldownEnd(head('Retry-After: 120'), NOW)).toBe(NOW + 120_000)
  const reset = Math.floor(NOW / 1000) + 600
  expect(cooldownEnd(head(`X-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: ${reset}`), NOW)).toBe(reset * 1000 + 1000)
  expect(cooldownEnd(undefined, NOW)).toBe(NOW + 60_000)
  expect(isRateLimited('HTTP 403', head('X-Ratelimit-Remaining: 0'))).toBe(true)
  expect(isRateLimited('HTTP 403: Forbidden', head('X-Ratelimit-Remaining: 12'))).toBe(false)
  expect(isRateLimited('HTTP 429', undefined)).toBe(true)
  const limiter = freshLimiter()
  pause(limiter, NOW + 300_000)
  pause(limiter, NOW + 60_000)
  expect(limiter.until).toBe(NOW + 300_000)
})

test('summaries: month keys are UTC, money and grouping', () => {
  expect(monthKey(NOW)).toBe('2026-11')
  expect(dayKey(Date.UTC(2026, 10, 30, 23, 59))).toBe('2026-11-30')
  expect(dayKey(windowStart(NOW))).toBe('2026-10-02')
  expect(money(6400, 0.006)).toBe('$38.40')
  expect(money(1, 0.006)).toBe('<$0.01')
  expect(grouped(6400, ',')).toBe('6,400')
  expect(grouped(1228, '.')).toBe('1.228')
  const state = freshRepo()
  state.runs['1'] = { c: NOW, a: 1, st: 'completed', k: NOW, f: true, d: { '2026-11-07': [10, 2], '2026-10-30': [99, 0] } }
  state.runs['2'] = { c: NOW, a: 1, st: 'in_progress', k: NOW, f: false }
  const s = summarize([{ repo: 'api', state }], {
    owner: 'acme',
    now: NOW,
    pricePerMinute: 0.006,
    meta: { v: 2, log: [], ok: NOW, rebuilding: false },
    updatedAt: NOW,
  })
  expect(s).toMatchObject({ monthMinutes: 10, todayMinutes: 10, hostedMinutes: 2, runsCounted: 1, runsRunning: 1, coverage: 'catchingUp' })
})

test('the estimate in Spanish, and off when the option says so', { options: { owner: 'acme', savings: false } }, async ($, on) => {
  engine(on, [], github(basicModel(), []))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ command: 'radar', args: 'ahorro' })).text).toContain('estimate is off')
  expect(es.savings.total('$7.37', grouped(1228, es.savings.thousands))).toBe('≈ $7.37 coste equivalente estimado en GitHub · 1.228 min en tus runners')
  expect(es.savings.caveat).toContain('repos públicos')
})


test('an unchanged busy head does not rediscover a completed history window', () => {
  const state = freshRepo()
  const win = windowStart(NOW)
  const runs = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, st: 'completed', a: 1, c: NOW - i * 100 }))
  afterHead(state, runs, win, NOW)
  const seg = state.segs[0]
  if (!seg) throw new Error('missing initial history segment')
  stepSegment(state, seg, [], win, NOW)
  expect(isComplete(state, win)).toBe(true)
  afterHead(state, runs, win, NOW + MIN)
  expect(state.segs).toEqual([])
  expect(isComplete(state, win)).toBe(true)
})
