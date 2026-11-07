// Every word the radar shows, in plain language. The logic returns facts
// (codes and numbers); these functions turn them into short, readable phrases.

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
  reason: {
    noLabel: (labels: string[]) => string
    offline: string
    working: (n: number) => string
  }
  headline: {
    allClear: (free: number) => string
    working: (working: number, total: number) => string
    runnerOffline: (name: string) => string
    runnersOffline: (n: number) => string
    cantStart: (n: number) => string
    waiting: (n: number, longest: string) => string
  }
  status: (online: number, total: number, working: number, waiting: number, longest: string) => string
  alert: {
    wentOffline: (name: string) => string
    backOnline: (name: string) => string
    queue: (n: number) => string
    longWait: (repo: string, job: string, wait: string) => string
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
  reason: {
    noLabel: labels =>
      labels.length === 1
        ? `no runner has the label "${labels[0]}"`
        : `no runner has the labels ${labels.map(l => `"${l}"`).join(', ')}`,
    offline: 'its runner is offline',
    working: n => (n === 1 ? "its runner is working, it's next" : `all ${n} of its runners are working`),
  },
  headline: {
    allClear: free => `All good · ${free} ${plural(free, 'runner', 'runners')} free`,
    working: (working, total) => `Working · ${working} of ${total} runners busy, nothing waiting`,
    runnerOffline: name => `${name} is offline`,
    runnersOffline: n => `${n} runners offline`,
    cantStart: n => `${n} ${plural(n, "job can't", "jobs can't")} start`,
    waiting: (n, longest) => `${n} ${plural(n, 'job', 'jobs')} waiting (longest ${longest})`,
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
  reason: {
    noLabel: labels =>
      labels.length === 1
        ? `ningún runner tiene la etiqueta "${labels[0]}"`
        : `ningún runner tiene las etiquetas ${labels.map(l => `"${l}"`).join(', ')}`,
    offline: 'su runner está desconectado',
    working: n => (n === 1 ? 'su runner está ocupado, sigue en la fila' : `sus ${n} runners están ocupados`),
  },
  headline: {
    allClear: free => `Todo bien · ${free} ${plural(free, 'runner libre', 'runners libres')}`,
    working: (working, total) => `Trabajando · ${working} de ${total} runners ocupados, nada en espera`,
    runnerOffline: name => `${name} está desconectado`,
    runnersOffline: n => `${n} runners desconectados`,
    cantStart: n => `${n} ${plural(n, 'job no puede', 'jobs no pueden')} empezar`,
    waiting: (n, longest) => `${n} ${plural(n, 'job esperando', 'jobs esperando')} (el más largo ${longest})`,
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
    logsHeader: (repo, workflow, branch, url) => `Pasos que fallaron en ${repo} › ${workflow} (${branch})
${url}`,
    logsEmpty: 'GitHub no devolvió líneas de log de los pasos fallidos (puede que los logs hayan expirado).',
  },
}

export const strings = (lang: Lang): Strings => (lang === 'es' ? es : en)
