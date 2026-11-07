// Every word the radar shows, in plain language. The logic returns facts
// (codes and numbers); these functions turn them into short, readable phrases.

import type { ErrorKind } from '../types'

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
  }
  status: (online: number, total: number, working: number, waiting: number, longest: string) => string
  alert: {
    wentOffline: (name: string) => string
    backOnline: (name: string) => string
    queue: (n: number) => string
    longWait: (repo: string, job: string, wait: string) => string
  }
  savings: {
    title: string
    summary: string
    total: (amount: string, minutes: string) => string
    today: (amount: string, minutes: string) => string
    price: (price: string) => string
    counting: (done: number, total: number) => string
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
      counting: string
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
    rateLimit: () => 'GitHub API rate limit reached: pausing requests for 1 minute; raise the refresh interval or watch fewer repos',
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
  },
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
    title: 'Savings',
    summary: 'this month (UTC) vs. GitHub-hosted runners',
    total: (amount, minutes) => `💰 ${amount} saved · ${minutes} min on your runners`,
    today: (amount, minutes) => `today ${amount} · ${minutes} min`,
    price: price => `at ${price}/min, the GitHub-hosted Linux rate · /radar savings for details`,
    counting: (done, total) => `counting runs… ${done} of ${total}`,
    hosted: minutes => `${minutes} min still ran on GitHub-hosted runners`,
    none: 'No jobs on your runners yet this month.',
    thousands: ',',
    report: r =>
      [
        `Runner Radar savings · ${r.month} (UTC)`,
        '',
        `${r.total} saved · ${r.minutes} billable minutes on your self-hosted runners`,
        `today: ${r.today} · ${r.todayMinutes} min`,
        '',
        ...r.perRepo,
        '',
        r.hosted,
        `Price: ${r.price}/min (GitHub-hosted Linux 2-core). Change it in /plugin → runner-radar → Configure.`,
        'How: every job on a self-hosted runner, each rounded up to the whole minute and every re-run counted, as GitHub bills hosted runners. Self-hosted minutes themselves are free on GitHub today.',
        r.counting,
      ]
        .filter((line, i, all) => line !== '' || (all[i - 1] ?? '') !== '')
        .join('\n'),
    off: 'The savings counter is off (Savings counter option in /plugin → runner-radar → Configure).',
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
      'se alcanzó el límite de la API de GitHub: se pausan las consultas 1 minuto; sube el intervalo o vigila menos repos',
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
  },
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
    title: 'Ahorro',
    summary: 'este mes (UTC) frente a los runners de GitHub',
    total: (amount, minutes) => `💰 ${amount} ahorrados · ${minutes} min en tus runners`,
    today: (amount, minutes) => `hoy ${amount} · ${minutes} min`,
    price: price => `a ${price}/min, la tarifa de Linux en GitHub · /radar ahorro para el detalle`,
    counting: (done, total) => `contando runs… ${done} de ${total}`,
    hosted: minutes => `${minutes} min siguieron corriendo en runners de GitHub`,
    none: 'Todavía no hay jobs en tus runners este mes.',
    thousands: '.',
    report: r =>
      [
        `Ahorro de Runner Radar · ${r.month} (UTC)`,
        '',
        `${r.total} ahorrados · ${r.minutes} minutos facturables en tus runners self-hosted`,
        `hoy: ${r.today} · ${r.todayMinutes} min`,
        '',
        ...r.perRepo,
        '',
        r.hosted,
        `Precio: ${r.price}/min (Linux de 2 núcleos en GitHub). Cámbialo en /plugin → runner-radar → Configure.`,
        'Cálculo: cada job en un runner self-hosted, redondeado al minuto y contando cada reintento, como cobra GitHub sus runners. Los minutos self-hosted hoy son gratis en GitHub.',
        r.counting,
      ]
        .filter((line, i, all) => line !== '' || (all[i - 1] ?? '') !== '')
        .join('\n'),
    off: 'El contador de ahorro está apagado (opción Savings counter en /plugin → runner-radar → Configure).',
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
