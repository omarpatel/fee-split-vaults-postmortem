/**
 * PUBLISHING HEALTH - learn a suspension from a probe, not from a failed post.
 *
 * Every X account we post from is asked for its own standing (GET /2/users/me
 * under its token) every PUBLISHING_HEALTH.probeEverySeconds, and the verdict
 * is APPENDED to publisher_account_health. Two readers depend on that log:
 * the publisher refuses to post from an account whose newest row is not a
 * fresh `ok` (packages/publisher/src/health.ts), and the monitoring collector
 * turns a non-ok newest row into `publishing_channel_suspended`, which pages.
 *
 * ONE SCOPE PER ACCOUNT. A suspended account is that account's incident; a
 * probe that cannot reach X for one account must not stop the others from
 * being recorded, and the status page should say which account is which.
 *
 * `unreachable` IS NOT RECORDED. It is the network's answer, not X's; the run
 * fails so the scheduler retries, and the previous conclusive row stands
 * until the publisher's freshness bound ages it out. Everything else -
 * including `unauthorized`, which is a token that can no longer post either -
 * is a verdict and is written.
 */

import type { ChannelHealthProbe } from '@fee-split-vaults/publisher'
import { PUBLISHING_HEALTH } from '../config.js'
import type { OpsPorts, PublishingAccountRef } from '../ports.js'
import { staggeredIntervalDue } from '../triggers.js'
import type { DueScopeInput, JobContext, JobDefinition, JobOutcome, ScheduledRun } from '../types.js'

/** `<channel>:<accountId>`; the account id is opaque and may not contain ':' - X ids are numeric. */
export function healthScope(account: Pick<PublishingAccountRef, 'channel' | 'accountId'>): string {
  return `${account.channel}:${account.accountId}`
}

export function publishingHealthJob(ports: OpsPorts): JobDefinition {
  return {
    id: 'publishing.health',
    description: 'Probes every bound X account for suspension or lock and appends the verdict the publisher gate and the suspension alert read.',
    triggers: [{ kind: 'interval', everySeconds: PUBLISHING_HEALTH.probeEverySeconds }],
    maxAttempts: 3,
    leaseSeconds: 5 * 60,
    timeoutSeconds: 120,
    retryBaseSeconds: 300,
    movesMoney: false,

    async dueScopes(input: DueScopeInput): Promise<ScheduledRun[]> {
      const accounts = await ports.publishingHealth.listAccounts()
      const out: ScheduledRun[] = []
      for (const account of accounts) {
        const scope = healthScope(account)
        const last = await input.lastSuccessUnix(scope)
        const due = staggeredIntervalDue(input.nowUnix, scope, last, PUBLISHING_HEALTH.probeEverySeconds)
        if (!due.due) continue
        out.push({
          jobId: 'publishing.health',
          scope,
          period: due.period,
          reason: { kind: 'interval', sinceLastSeconds: due.sinceLastSeconds },
        })
      }
      return out
    },

    async run(ctx: JobContext): Promise<JobOutcome> {
      // Resolved from the registry on every run, not parsed out of the scope:
      // an account unbound between dueScopes and run has nothing to probe.
      const account = (await ports.publishingHealth.listAccounts()).find((a) => healthScope(a) === ctx.scope)
      if (account === undefined) return { ok: true, code: 'account_unbound', facts: { scope: ctx.scope } }

      const probe: ChannelHealthProbe = await ports.publishingHealth.probe(account)
      const facts: Record<string, string | number | boolean> = {
        channel: account.channel,
        account_id: account.accountId,
        vault: account.vault,
        status: probe.status,
        observed_at_unix: probe.observedAtUnix,
        detail: probe.detail,
      }
      if (probe.status === 'unreachable') {
        ctx.log.warn('publishing.health.unreachable', facts)
        return { ok: false, code: 'probe_unreachable', facts }
      }

      await ports.publishingHealth.record({ channel: account.channel, accountId: account.accountId, ...probe })
      if (probe.status !== 'ok') ctx.log.warn('publishing.health.not_ok', facts)
      return { ok: true, code: `recorded_${probe.status}`, facts }
    },
  }
}
