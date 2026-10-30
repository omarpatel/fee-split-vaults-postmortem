/**
 * The job registry.
 *
 * One list, in one place, so "what runs in production" is a question with a
 * single answer. assertRegistryComplete() fails the build if a JobId exists in
 * the type but not in the list, which is how a job that was written and never
 * wired up gets caught.
 */

import type { OpsPorts } from './ports.js'
import type { JobDefinition, JobId } from './types.js'
import { deliveryPredicatesJob } from './jobs/delivery-predicates.js'
import { escrowSweepJob } from './jobs/escrow-sweep.js'
import { fleetTickJob } from './jobs/fleet-tick.js'
import { reconciliationJobs } from './jobs/reconciliation.js'
import { monitoringEvaluateJob } from './jobs/monitoring.js'
import { publishingHealthJob } from './jobs/publishing-health.js'
import { rescreenJob } from './jobs/rescreen.js'
import { settleJob } from './jobs/settle.js'
import { tierReevaluateJob } from './jobs/tier-reevaluate.js'
import { vaultHeartbeatJob } from './jobs/vault-heartbeat.js'
import { weeklyReportJob } from './jobs/weekly-report.js'

export const ALL_JOB_IDS: readonly JobId[] = [
  'escrow.sweep',
  'escrow.settle',
  'recon.structural',
  'recon.sweep_match',
  'recon.trial_balance',
  'recon.clean_room',
  'tier.reevaluate',
  'delivery.predicates',
  'report.weekly_dev',
  'screening.rescreen',
  'fleet.tick',
  'vault.heartbeat',
  'publishing.health',
  'monitoring.evaluate',
]

/**
 * The jobs that broadcast a transaction or allocate money.
 *
 * Duplicated as data rather than derived from buildJobs() so the operator CLI
 * can consult it without constructing every job and its ports during an
 * incident. assertRegistryComplete() checks the two agree.
 */
export const MONEY_MOVING_JOB_IDS: readonly string[] = ['escrow.sweep', 'escrow.settle', 'fleet.tick']

export function buildJobs(ports: OpsPorts): JobDefinition[] {
  return [
    escrowSweepJob(ports),
    settleJob(ports),
    ...reconciliationJobs(ports),
    tierReevaluateJob(ports),
    deliveryPredicatesJob(ports),
    weeklyReportJob(ports),
    rescreenJob(ports),
    fleetTickJob(ports),
    vaultHeartbeatJob(ports),
    publishingHealthJob(ports),
    monitoringEvaluateJob(ports),
  ]
}

export class RegistryIncomplete extends Error {
  constructor(missing: readonly string[], extra: readonly string[]) {
    super(`job registry mismatch; missing=[${missing.join(',')}] unexpected=[${extra.join(',')}]`)
    this.name = 'RegistryIncomplete'
  }
}

/** Called at startup. A job that exists but is not scheduled is a silent outage. */
export function assertRegistryComplete(jobs: readonly JobDefinition[]): void {
  const registered = new Set(jobs.map((j) => j.id))
  const missing = ALL_JOB_IDS.filter((id) => !registered.has(id))
  const extra = [...registered].filter((id) => !(ALL_JOB_IDS as readonly string[]).includes(id))
  if (missing.length > 0 || extra.length > 0) throw new RegistryIncomplete(missing, extra)
  if (registered.size !== jobs.length) {
    throw new RegistryIncomplete([], ['duplicate job id in the registry'])
  }

  // The operator CLI reads MONEY_MOVING_JOB_IDS to decide which retries need an
  // explicit override. If it drifted from the definitions, the guard rail would
  // silently stop covering a job that moves money.
  const declared: string[] = [...MONEY_MOVING_JOB_IDS].sort()
  const actual: string[] = jobs.filter((j) => j.movesMoney).map((j) => String(j.id)).sort()
  if (declared.join(',') !== actual.join(',')) {
    throw new RegistryIncomplete(
      actual.filter((id) => !declared.includes(id)),
      declared.filter((id) => !actual.includes(id)),
    )
  }
}

/**
 * Startup sanity on the job definitions themselves. Cheap, and it catches the
 * configuration mistakes that only show up as a production incident: a lease
 * shorter than the timeout (two workers run concurrently), a money-moving job
 * with a generous retry budget (a retried claim is a second claim).
 */
export function assertJobConfigSane(jobs: readonly JobDefinition[]): void {
  for (const job of jobs) {
    if (job.triggers.length === 0) throw new Error(`${job.id}: no triggers`)
    if (job.leaseSeconds <= job.timeoutSeconds) {
      throw new Error(`${job.id}: leaseSeconds (${job.leaseSeconds}) must exceed timeoutSeconds (${job.timeoutSeconds})`)
    }
    if (job.maxAttempts < 1) throw new Error(`${job.id}: maxAttempts must be at least 1`)
    if (job.movesMoney && job.maxAttempts > 3) {
      throw new Error(`${job.id}: a money-moving job may not retry more than 3 times`)
    }
    if (job.retryBaseSeconds <= 0) throw new Error(`${job.id}: retryBaseSeconds must be positive`)
  }
}
