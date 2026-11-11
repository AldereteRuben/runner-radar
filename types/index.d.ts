export type Runner = {
  id: number
  name: string
  online: boolean
  busy: boolean
  labels: string[]
}

/** A job of an active run, as the radar needs it. */
export type Job = {
  id: number
  repo: string
  workflow: string
  name: string
  status: string
  runner: string
  createdAt: number
  startedAt: number
  selfHosted: boolean
  /** The `runs-on` labels the job asked for. */
  labels: string[]
}

/** A job of a failed run, and the step it failed on. */
export type FailedJob = { name: string; step: string; url: string }

/** The latest completed run of a repo, when it failed. */
export type Failure = {
  runId: number
  workflow: string
  branch: string
  url: string
  at: number
  jobs: FailedJob[]
}

/**
 * What kind of failure a GitHub query hit. The pane turns the kind into a short,
 * localized, actionable sentence; `detail` keeps gh's own words for `other`.
 */
export type ErrorKind =
  | 'orgScope'
  | 'rateLimit'
  | 'auth'
  | 'forbidden'
  | 'notFound'
  | 'network'
  | 'ghMissing'
  | 'unexpected'
  | 'other'

export type ApiError = { kind: ErrorKind; detail: string }

/** A repo whose runner list could not be read this refresh. */
export type RunnerError = { repo: string; error: ApiError }

export type RepoSummary = {
  repo: string
  running: number
  queued: number
  /**
   * Runs GitHub reports as `queued` without having created any job yet,
   * among the active runs inspected. Nothing a runner can take: the wait is
   * on GitHub's side, not the fleet's.
   */
  unscheduled: number
  /** Creation time (ms) of the oldest such run; 0 when there is none. */
  unscheduledSince: number
  /** Conclusions of the latest completed runs, newest first. */
  recent: string[]
  failure?: Failure
  error?: ApiError
}

export type Snapshot = {
  owner: string
  updatedAt: number
  runners: Runner[]
  jobs: Job[]
  repos: RepoSummary[]
  /** The org runner list (or the whole refresh) failed. */
  error?: ApiError
  /** Repo-level runner lists that failed: the runner inventory is partial. */
  runnerErrors: RunnerError[]
}

/** Why the hosted-equivalent counter stopped early, and until when (ms; 0 = next pass). */
export type SavingsPause = { reason: 'rateLimit' | 'budget' | 'quota'; until: number }

/**
 * What the hosted-equivalent section shows: a hypothetical GitHub-hosted cost
 * of the minutes that ran on self-hosted runners, computed from the stored scan.
 */
export type Savings = {
  owner: string
  /** `YYYY-MM`, UTC. */
  month: string
  pricePerMinute: number
  /** Minutes (each job rounded up to the minute once) on your runners, by UTC job completion day. */
  monthMinutes: number
  todayMinutes: number
  /** Minutes that ran on GitHub-hosted runners this month. */
  hostedMinutes: number
  perRepo: Array<{ repo: string; minutes: number }>
  /** Runs whose every job page was fetched for their latest known attempt. */
  runsCounted: number
  /** Finished runs (or new attempts) not counted yet. */
  runsPending: number
  /** Runs still running: counted when they finish. */
  runsRunning: number
  /** `rebuilding` after the 0.3.0 cache was dropped, `catchingUp` while history or runs are left. */
  coverage: 'complete' | 'catchingUp' | 'rebuilding'
  /** `YYYY-MM-DD`: runs created since this day are covered. */
  historyFrom: string
  /** `YYYY-MM-DD`: how far back history is listed so far, while it is incomplete. */
  scannedBack?: string
  reposScanning: number
  /** The last pass, successful or not. */
  updatedAt: number
  /** The last pass without an error; 0 = never. */
  lastSuccessAt: number
  paused?: SavingsPause
  error?: ApiError
}

declare module 'claude-code' {
  interface PluginState {
    'runner-radar': {
      snapshot: Shaped<Snapshot | null>
      polling: Shaped<boolean>
      savings: Shaped<Savings | null>
    }
  }
}
