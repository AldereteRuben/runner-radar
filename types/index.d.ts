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

/**
 * One counted run, as kept in `$.store`: [repo, UTC day (YYYY-MM-DD),
 * self-hosted billable minutes, GitHub-hosted billable minutes].
 */
export type UsageEntry = [string, string, number, number]

/** Runs counted this month, by run id. */
export type UsageMonth = Record<string, UsageEntry>

/** What the savings section shows: computed from the stored month. */
export type Savings = {
  owner: string
  /** `YYYY-MM`, UTC: GitHub bills minutes in UTC. */
  month: string
  pricePerMinute: number
  /** Billable minutes (each job rounded up to the minute) on your runners. */
  monthMinutes: number
  todayMinutes: number
  /** Minutes that still ran on GitHub-hosted runners this month. */
  hostedMinutes: number
  perRepo: Array<{ repo: string; minutes: number }>
  runsCounted: number
  runsPending: number
  updatedAt: number
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
