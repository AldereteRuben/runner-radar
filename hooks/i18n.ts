// Every word the radar shows, in plain language. The logic returns facts
// (codes and numbers); these functions turn them into short, readable phrases.

import type { ErrorKind } from '../types'
import { SAVINGS_CALLS_PER_HOUR, SAVINGS_CALLS_PER_PASS } from './savings'

export type Lang = 'en' | 'es'

export const parseLang = (v: unknown): Lang => (String(v ?? '').toLowerCase().startsWith('es') ? 'es' : 'en')

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

export type Strings = {
  state: { free: string; working: string; offline: string }
  runnersTitle: string
  runnersSummary: (online: number, total: number, working: number) => string
  queueTitle: string
  queueSummary: (n: number) => string
  reposTitle: string
  reposSummary: (n: number) => string
  repoQuiet: string
  failure: (workflow: string, branch: string, ago: string, where: string) => string
  failedAt: (job: string, step: string) => string
  viewOnGitHub: string
  logsHint: (repo: string) => string
  repoRow: (running: number, waiting: number) => string
  /** Pending runs GitHub has not created jobs for yet, and the oldest one's wait. */
  repoUnscheduled: (n: number, longest: string) => string
  lastRuns: string
  andMore: (n: number) => string
  updated: (time: string, seconds: number) => string
  stale: string
  asking: string
  noRunners: (owner: string) => string
  /** Some repo runner lists failed: which repos, and why when it is one kind. */
  runnersPartial: (repos: string[], why: string) => string
  /** Status line suffix while the runner list is partial. */
  statusPartial: string
  /** Below the minimum width: what the pane leaves out and how to get it back. */
  narrow: (columns: number) => string
  /** A GitHub failure, by kind, in words the user can act on. */
  error: Record<ErrorKind, (detail: string) => string>
  reason: {
    noLabel: (labels: string[]) => string
    /** Like noLabel, but the runner list is partial: only what we can see. */
    noVisibleLabel: (labels: string[]) => string
    offline: string
    offlineVisible: string
    working: (n: number) => string
  }
  headline: {
    allClear: (free: number) => string
    working: (working: number, total: number) => string
    runnerOffline: (name: string) => string
    runnersOffline: (n: number) => string
    cantStart: (n: number) => string
    waiting: (n: number, longest: string) => string
    partial: (repos: number) => string
    repoErrors: (repos: number) => string
    /** Pending runs without jobs yet: waiting on GitHub, not on a runner. */
    unscheduled: (n: number, longest: string) => string
  }
  /** Status line suffix: pending runs GitHub has not created jobs for yet. */
  statusUnscheduled: (n: number) => string
  status: (online: number, total: number, working: number, waiting: number, longest: string) => string
  alert: {
    wentOffline: (name: string) => string
    backOnline: (name: string) => string
    queue: (n: number) => string
    longWait: (repo: string, job: string, wait: string) => string
  }
  /** The hosted-equivalent estimate (`/radar savings`): hypothetical, never "saved". */
  savings: {
    title: string
    summary: string
    total: (amount: string, minutes: string) => string
    today: (amount: string, minutes: string) => string
    price: (price: string) => string
    /** One-line caveat under the pane figures. */
    caveat: string
    counting: (done: number, total: number) => string
    history: (back: string, from: string) => string
    running: (n: number) => string
    rebuilding: string
    incomplete: string
    complete: (from: string) => string
    lastOk: (time: string) => string
    never: string
    stale: string
    paused: { rateLimit: (time: string) => string; budget: (time: string) => string; quota: (time: string) => string }
    failed: (reason: string) => string
    hosted: (minutes: string) => string
    none: string
    /** Thousands separator: `6,400` / `6.400`. */
    thousands: string
    report: (r: {
      month: string
      total: string
      minutes: string
      today: string
      todayMinutes: string
      perRepo: string[]
      hosted: string
      price: string
      status: string[]
      from: string
    }) => string
    off: string
  }
  cmd: {
    stopped: string
    badOwner: (arg: string) => string
    needOwner: string
    watching: (owner: string, seconds: number) => string
    watchingNarrow: (owner: string, seconds: number) => string
    failed: string
    logsUsage: string
    logsNoRepo: (repo: string) => string
    logsNoFailure: (repo: string) => string
    logsUnavailable: (repo: string, reason: string) => string
    logsHeader: (repo: string, workflow: string, branch: string, url: string) => string
    logsEmpty: string
  }
}

const en: Strings = {
  state: { free: 'free', working: 'working', offline: 'offline' },
  runnersTitle: 'Runners',
  runnersSummary: (online, total, working) => `${online} of ${total} online · ${working} working`,
  queueTitle: 'Waiting for a runner',
  queueSummary: n => (n === 0 ? 'nothing waiting' : `${n} ${plural(n, 'job', 'jobs')}`),
  reposTitle: 'Repositories',
  reposSummary: n => `${n} watched`,
  repoQuiet: 'no activity',
  failure: (workflow, branch, ago, where) => `✗ ${workflow} · ${branch} · failed ${ago} ago${where ? ` in ${where}` : ''}`,
  failedAt: (job, step) => (step ? `"${job}" › "${step}"` : `"${job}"`),
  viewOnGitHub: 'view on GitHub',
  logsHint: repo => `logs: /radar logs ${repo}`,
  repoRow: (running, waiting) => `${running} running · ${waiting} waiting`,
  repoUnscheduled: (n, longest) => `${n} ${plural(n, 'run', 'runs')} queued, no jobs yet (${longest})`,
  lastRuns: 'last 5 runs',
  andMore: n => `…and ${n} more`,
  updated: (time, s) => `Updated ${time} · refreshes every ${s}s · /radar off to stop`,
  stale: 'not updating · ',
  asking: 'Asking GitHub…',
  noRunners: owner => `No runners visible for ${owner}. For org runners run: gh auth refresh -s admin:org`,
  runnersPartial: (repos, why) =>
    `⚠ Runner list incomplete: could not read the runners of ${repos.join(', ')}${why ? ` (${why})` : ''}`,
  statusPartial: 'runner list incomplete',
  narrow: columns => `Summary only at ${columns} columns. Widen to 44+ columns for runner and repo details.`,
  error: {
    orgScope: () => 'org runners need the admin:org scope: gh auth refresh -h github.com -s admin:org',
    rateLimit: () =>
      'GitHub API rate limit reached: requests paused until GitHub says to retry (at least 1 minute); raise the refresh interval or watch fewer repos',
    auth: () => 'gh is not signed in: run gh auth login',
    forbidden: () => 'GitHub denied access (403): repo runners need admin on the repo; check gh auth status',
    notFound: () => 'not found (404): check the owner and repo names, and your access',
    network: () => 'could not reach GitHub: retrying next refresh',
    ghMissing: () => 'gh CLI not found on PATH: install it from https://cli.github.com',
    unexpected: () => 'unexpected response from gh: retrying next refresh',
    other: detail => detail || 'GitHub query failed',
  },
  reason: {
    noLabel: labels =>
      labels.length === 1
        ? `no runner has the label "${labels[0]}"`
        : `no runner has the labels ${labels.map(l => `"${l}"`).join(', ')}`,
    noVisibleLabel: labels =>
      labels.length === 1
        ? `no visible runner has the label "${labels[0]}" (runner list incomplete)`
        : `no visible runner has the labels ${labels.map(l => `"${l}"`).join(', ')} (runner list incomplete)`,
    offline: 'its runner is offline',
    offlineVisible: 'its visible runners are offline (runner list incomplete)',
    working: n => (n === 1 ? "its runner is working, it's next" : `all ${n} of its runners are working`),
  },
  headline: {
    allClear: free => `All good · ${free} ${plural(free, 'runner', 'runners')} free`,
    working: (working, total) => `Working · ${working} of ${total} runners busy, nothing waiting`,
    runnerOffline: name => `${name} is offline`,
    runnersOffline: n => `${n} runners offline`,
    cantStart: n => `${n} ${plural(n, "job can't", "jobs can't")} start`,
    waiting: (n, longest) => `${n} ${plural(n, 'job', 'jobs')} waiting (longest ${longest})`,
    partial: n => `runner list incomplete (${n} ${plural(n, 'repo', 'repos')} unreadable)`,
    repoErrors: n => `${n} ${plural(n, 'repo scan has', 'repo scans have')} errors`,
    unscheduled: (n, longest) =>
      `${n} ${plural(n, 'run', 'runs')} queued at GitHub, no jobs yet (longest ${longest})`,
  },
  statusUnscheduled: n => `${n} ${plural(n, 'run', 'runs')} without jobs yet`,
  status: (online, total, working, waiting, longest) =>
    [`radar · ${online}/${total} online`, working ? `${working} working` : '', waiting ? `${waiting} waiting · longest ${longest}` : '']
      .filter(Boolean)
      .join(' · '),
  alert: {
    wentOffline: name => `Runner ${name} went offline`,
    backOnline: name => `Runner ${name} is back online`,
    queue: n => `${n} jobs waiting for a runner`,
    longWait: (repo, job, wait) => `${repo} › ${job} has waited ${wait} for a runner`,
  },
  savings: {
    title: 'Hosted equivalent',
    summary: 'this month (UTC) · hypothetical, not a bill',
    total: (amount, minutes) => `≈ ${amount} estimated GitHub-hosted equivalent · ${minutes} min on your runners`,
    today: (amount, minutes) => `today ${amount} · ${minutes} min`,
    price: price => `at ${price}/min, your comparison rate · /radar savings for details`,
    caveat: 'public repos and included plan minutes may mean $0 extra; hardware and power not subtracted',
    counting: (done, total) => `counting runs… ${done} of ${total}`,
    history: (back, from) => `history listed back to ${back} of ${from}`,
    running: n => `${n} ${plural(n, 'run', 'runs')} still running, counted when finished`,
    rebuilding: 'recalculating: 0.3.1 dates minutes by when each job finished',
    incomplete: 'incomplete: totals grow as history is counted',
    complete: from => `all runs created since ${from} counted`,
    lastOk: time => `last complete update ${time}`,
    never: 'never',
    stale: 'not updating',
    paused: {
      rateLimit: time => `paused by a GitHub rate limit until ${time}`,
      budget: time => `request budget used: continues ${time ? `after ${time}` : 'next pass'}`,
      quota: time => `paused to keep API quota for the radar until ${time}`,
    },
    failed: reason => `last update failed: ${reason}`,
    hosted: minutes => `${minutes} min ran on GitHub-hosted runners`,
    none: 'No jobs on your runners yet this month.',
    thousands: ',',
    report: r =>
      [
        `Runner Radar · estimated GitHub-hosted equivalent · ${r.month} (UTC)`,
        '',
        `≈ ${r.total} estimated GitHub-hosted equivalent · ${r.minutes} minutes on your self-hosted runners`,
        `today: ${r.today} · ${r.todayMinutes} min`,
        '',
        ...r.perRepo,
        '',
        ...r.status,
        '',
        r.hosted,
        `Comparison rate: ${r.price}/min (default: GitHub-hosted standard Linux x64 2-core). Change it in /plugin → runner-radar → Configure.`,
        'This is a hypothetical figure, not a bill and not money you saved: what these minutes would cost at that rate on GitHub-hosted runners.',
        "Standard GitHub-hosted runners are free for public repositories, and your plan's included minutes may mean the same jobs would have cost nothing extra. Your hardware, power and maintenance are not subtracted, and your machines may not perform like the selected hosted runner.",
        `How: each job's run time is rounded up to the whole minute once and assigned to the UTC day the job finished; every attempt counts. An estimate, not an invoice reconciliation. Runs created since ${r.from} are covered; re-runs of older runs are found by a daily re-check.`,
        `API use: at most ${SAVINGS_CALLS_PER_PASS} requests per pass and ${SAVINGS_CALLS_PER_HOUR} per hour per owner in one active session, /radar savings included; it waits while the radar refreshes or GitHub's remaining quota is low.`,
      ]
        .filter((line, i, all) => line !== '' || (all[i - 1] ?? '') !== '')
        .join('\n'),
    off: 'The hosted-equivalent estimate is off (Hosted-equivalent estimate option in /plugin → runner-radar → Configure).',
  },
  cmd: {
    stopped: 'Runner Radar stopped: no more GitHub polling.',
    badOwner: arg => `"${arg}" is not a GitHub owner name. Usage: /radar [off | refresh | <owner>]`,
    needOwner:
      'Set the GitHub owner to watch first: /plugin → Installed → runner-radar → Configure (or try /radar <owner> for this session).',
    watching: (owner, s) => `Watching ${owner} (every ${s}s). /radar off to stop.`,
    watchingNarrow: (owner, s) =>
      `Watching ${owner} (every ${s}s); the pane waits for a wider terminal, the status line has the summary.`,
    failed: 'Runner Radar: the command failed. Check that `gh` is installed and signed in (gh auth status).',
    logsUsage: 'Usage: /radar logs <repo>',
    logsNoRepo: repo => `"${repo}" is not one of the watched repos (open /radar first).`,
    logsNoFailure: repo => `The latest run of ${repo} did not fail.`,
    logsUnavailable: (repo, reason) => `Could not check the latest run of ${repo}: ${reason}`,
    logsHeader: (repo, workflow, branch, url) => `Failed steps of ${repo} › ${workflow} (${branch})
${url}`,
    logsEmpty: 'GitHub returned no log lines for the failed steps (the logs may have expired).',
  },
}

const es: Strings = {
  state: { free: 'libre', working: 'trabajando', offline: 'desconectado' },
  runnersTitle: 'Runners',
  runnersSummary: (online, total, working) => `${online} de ${total} conectados · ${working} trabajando`,
  queueTitle: 'Esperando un runner',
  queueSummary: n => (n === 0 ? 'nada en espera' : `${n} ${plural(n, 'job', 'jobs')}`),
  reposTitle: 'Repositorios',
  reposSummary: n => `${n} ${plural(n, 'vigilado', 'vigilados')}`,
  repoQuiet: 'sin actividad',
  failure: (workflow, branch, ago, where) => `✗ ${workflow} · ${branch} · falló hace ${ago}${where ? ` en ${where}` : ''}`,
  failedAt: (job, step) => (step ? `"${job}" › "${step}"` : `"${job}"`),
  viewOnGitHub: 'ver en GitHub',
  logsHint: repo => `logs: /radar logs ${repo}`,
  repoRow: (running, waiting) => `${running} corriendo · ${waiting} esperando`,
  repoUnscheduled: (n, longest) => `${n} ${plural(n, 'run', 'runs')} en cola sin jobs aún (${longest})`,
  lastRuns: 'últimos 5 runs',
  andMore: n => `…y ${n} más`,
  updated: (time, s) => `Actualizado ${time} · se refresca cada ${s} s · /radar off para detener`,
  stale: 'sin actualizar · ',
  asking: 'Consultando GitHub…',
  noRunners: owner =>
    `No veo runners de ${owner}. Para runners de una org: gh auth refresh -s admin:org`,
  runnersPartial: (repos, why) =>
    `⚠ Lista de runners incompleta: no se pudieron leer los runners de ${repos.join(', ')}${why ? ` (${why})` : ''}`,
  statusPartial: 'lista de runners incompleta',
  narrow: columns => `Solo resumen con ${columns} columnas. Ensánchalo a 44 o más para ver runners y repos.`,
  error: {
    orgScope: () => 'los runners de la org necesitan el permiso admin:org: gh auth refresh -h github.com -s admin:org',
    rateLimit: () =>
      'se alcanzó el límite de la API de GitHub: consultas en pausa hasta que GitHub permita reintentar (al menos 1 minuto); sube el intervalo o vigila menos repos',
    auth: () => 'gh no tiene sesión: ejecuta gh auth login',
    forbidden: () => 'GitHub negó el acceso (403): los runners de un repo requieren admin en el repo; revisa gh auth status',
    notFound: () => 'no encontrado (404): revisa los nombres del dueño y del repo, y tu acceso',
    network: () => 'no se pudo conectar con GitHub: reintenta en el próximo refresco',
    ghMissing: () => 'no se encontró gh en el PATH: instálalo desde https://cli.github.com',
    unexpected: () => 'respuesta inesperada de gh: reintenta en el próximo refresco',
    other: detail => detail || 'falló la consulta a GitHub',
  },
  reason: {
    noLabel: labels =>
      labels.length === 1
        ? `ningún runner tiene la etiqueta "${labels[0]}"`
        : `ningún runner tiene las etiquetas ${labels.map(l => `"${l}"`).join(', ')}`,
    noVisibleLabel: labels =>
      labels.length === 1
        ? `ningún runner visible tiene la etiqueta "${labels[0]}" (lista de runners incompleta)`
        : `ningún runner visible tiene las etiquetas ${labels.map(l => `"${l}"`).join(', ')} (lista de runners incompleta)`,
    offline: 'su runner está desconectado',
    offlineVisible: 'sus runners visibles están desconectados (lista de runners incompleta)',
    working: n => (n === 1 ? 'su runner está ocupado, sigue en la fila' : `sus ${n} runners están ocupados`),
  },
  headline: {
    allClear: free => `Todo bien · ${free} ${plural(free, 'runner libre', 'runners libres')}`,
    working: (working, total) => `Trabajando · ${working} de ${total} runners ocupados, nada en espera`,
    runnerOffline: name => `${name} está desconectado`,
    runnersOffline: n => `${n} runners desconectados`,
    cantStart: n => `${n} ${plural(n, 'job no puede', 'jobs no pueden')} empezar`,
    waiting: (n, longest) => `${n} ${plural(n, 'job esperando', 'jobs esperando')} (el más largo ${longest})`,
    partial: n => `lista de runners incompleta (${n} ${plural(n, 'repo ilegible', 'repos ilegibles')})`,
    repoErrors: n => `${n} ${plural(n, 'repo tiene', 'repos tienen')} errores de consulta`,
    unscheduled: (n, longest) =>
      `${n} ${plural(n, 'run', 'runs')} en cola en GitHub, sin jobs aún (el más largo ${longest})`,
  },
  statusUnscheduled: n => `${n} ${plural(n, 'run', 'runs')} sin jobs aún`,
  status: (online, total, working, waiting, longest) =>
    [
      `radar · ${online}/${total} conectados`,
      working ? `${working} trabajando` : '',
      waiting ? `${waiting} esperando · máx ${longest}` : '',
    ]
      .filter(Boolean)
      .join(' · '),
  alert: {
    wentOffline: name => `El runner ${name} se desconectó`,
    backOnline: name => `El runner ${name} volvió a conectarse`,
    queue: n => `${n} jobs esperando un runner`,
    longWait: (repo, job, wait) => `${repo} › ${job} lleva ${wait} esperando un runner`,
  },
  savings: {
    title: 'Coste equivalente',
    summary: 'este mes (UTC) · hipotético, no es una factura',
    total: (amount, minutes) => `≈ ${amount} coste equivalente estimado en GitHub · ${minutes} min en tus runners`,
    today: (amount, minutes) => `hoy ${amount} · ${minutes} min`,
    price: price => `a ${price}/min, tu tarifa de comparación · /radar ahorro para el detalle`,
    caveat: 'repos públicos y minutos incluidos en tu plan pueden suponer $0 extra; no descuenta hardware ni electricidad',
    counting: (done, total) => `contando runs… ${done} de ${total}`,
    history: (back, from) => `historial revisado hasta ${back} de ${from}`,
    running: n => `${n} ${plural(n, 'run sigue', 'runs siguen')} en curso, se cuentan al terminar`,
    rebuilding: 'recalculando: 0.3.1 fecha los minutos por cuándo terminó cada job',
    incomplete: 'incompleto: el total crece mientras se cuenta el historial',
    complete: from => `contados todos los runs creados desde ${from}`,
    lastOk: time => `última actualización completa ${time}`,
    never: 'nunca',
    stale: 'sin actualizar',
    paused: {
      rateLimit: time => `en pausa por el límite de la API de GitHub hasta ${time}`,
      budget: time => `presupuesto de consultas agotado: sigue ${time ? `después de ${time}` : 'en la próxima pasada'}`,
      quota: time => `en pausa para reservar cuota de la API al radar hasta ${time}`,
    },
    failed: reason => `falló la última actualización: ${reason}`,
    hosted: minutes => `${minutes} min corrieron en runners de GitHub`,
    none: 'Todavía no hay jobs en tus runners este mes.',
    thousands: '.',
    report: r =>
      [
        `Runner Radar · coste equivalente estimado en GitHub · ${r.month} (UTC)`,
        '',
        `≈ ${r.total} coste equivalente estimado · ${r.minutes} minutos en tus runners self-hosted`,
        `hoy: ${r.today} · ${r.todayMinutes} min`,
        '',
        ...r.perRepo,
        '',
        ...r.status,
        '',
        r.hosted,
        `Tarifa de comparación: ${r.price}/min (por defecto: runner estándar de GitHub Linux x64 de 2 núcleos). Cámbiala en /plugin → runner-radar → Configure.`,
        'Es una cifra hipotética, no una factura ni dinero ahorrado: lo que costarían estos minutos a esa tarifa en runners de GitHub.',
        'Los runners estándar de GitHub son gratis en repos públicos, y los minutos incluidos en tu plan pueden hacer que esos jobs no costaran nada extra. No descuenta tu hardware, electricidad ni mantenimiento, y tus máquinas pueden no rendir como el runner de GitHub elegido.',
        `Cálculo: el tiempo de cada job se redondea al minuto una sola vez y se asigna al día UTC en que terminó el job; cuenta cada intento. Es una estimación, no una conciliación de factura. Cubre los runs creados desde ${r.from}; los reintentos de runs antiguos se detectan con una revisión diaria.`,
        `Uso de la API: como mucho ${SAVINGS_CALLS_PER_PASS} consultas por pasada y ${SAVINGS_CALLS_PER_HOUR} por hora por owner en una sesión activa, /radar ahorro incluido; espera mientras el radar se refresca o si queda poca cuota en GitHub.`,
      ]
        .filter((line, i, all) => line !== '' || (all[i - 1] ?? '') !== '')
        .join('\n'),
    off: 'La estimación de coste equivalente está apagada (opción Hosted-equivalent estimate en /plugin → runner-radar → Configure).',
  },
  cmd: {
    stopped: 'Runner Radar detenido: ya no consulta GitHub.',
    badOwner: arg => `"${arg}" no es un nombre de usuario u org de GitHub. Uso: /radar [off | refresh | <owner>]`,
    needOwner:
      'Primero configura el dueño a vigilar: /plugin → Installed → runner-radar → Configure (o prueba /radar <owner> para esta sesión).',
    watching: (owner, s) => `Vigilando ${owner} (cada ${s} s). /radar off para detener.`,
    watchingNarrow: (owner, s) =>
      `Vigilando ${owner} (cada ${s} s); el panel espera una terminal más ancha, la línea de estado tiene el resumen.`,
    failed: 'Runner Radar: el comando falló. Revisa que `gh` esté instalado y con sesión (gh auth status).',
    logsUsage: 'Uso: /radar logs <repo>',
    logsNoRepo: repo => `"${repo}" no es uno de los repos vigilados (abre /radar primero).`,
    logsNoFailure: repo => `El último run de ${repo} no falló.`,
    logsUnavailable: (repo, reason) => `No se pudo consultar el último run de ${repo}: ${reason}`,
    logsHeader: (repo, workflow, branch, url) => `Pasos que fallaron en ${repo} › ${workflow} (${branch})
${url}`,
    logsEmpty: 'GitHub no devolvió líneas de log de los pasos fallidos (puede que los logs hayan expirado).',
  },
}

export const strings = (lang: Lang): Strings => (lang === 'es' ? es : en)
