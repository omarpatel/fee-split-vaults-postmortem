/**
 * Publishing account health over Postgres and the X API.
 *
 * The accounts come from publisher_account_binding (the same rows
 * PgAccountRegistry serves; only the two X channels have a standing to probe).
 * The probe is the publisher's own X transport - the same credential store,
 * the same refresh - asking GET /2/users/me under the account's token, so an
 * account that cannot be probed cannot be posted from either. The verdict is
 * appended to publisher_account_health through the publisher's store.
 */

import type { Address } from '@fee-split-vaults/core'
import { probeXAccount, type ChannelHealthProbe, type ChannelHealthRecord, type ChannelHealthStore, type XTransport } from '@fee-split-vaults/publisher'
import type { Clock } from '../../lib/time.js'
import type { SqlDriver } from '../../migrations/driver.js'
import type { PublishingAccountRef, PublishingHealth } from '../ports.js'
import { strOf } from './errors.js'

export interface PgPublishingHealthDeps {
  driver: SqlDriver
  transport: Pick<XTransport, 'probeAccount'>
  store: ChannelHealthStore
  clock: Clock
}

const X_CHANNELS: readonly PublishingAccountRef['channel'][] = ['x_operator', 'x_client_delegated']

export class PgPublishingHealth implements PublishingHealth {
  constructor(private readonly deps: PgPublishingHealthDeps) {}

  async listAccounts(): Promise<readonly PublishingAccountRef[]> {
    const rows = await this.deps.driver.query<{ channel: string; account_id: string; vault: string }>(
      `SELECT channel, account_id, vault FROM publisher_account_binding
        WHERE channel IN ($1, $2) ORDER BY channel, account_id`,
      [...X_CHANNELS],
    )
    return rows.map((row) => {
      const channel = strOf(row.channel, 'publisher_account_binding.channel')
      if (!(X_CHANNELS as readonly string[]).includes(channel)) {
        throw new TypeError(`publisher_account_binding.channel ${channel} is not an X channel`)
      }
      return {
        channel: channel as PublishingAccountRef['channel'],
        accountId: strOf(row.account_id, 'publisher_account_binding.account_id'),
        vault: strOf(row.vault, 'publisher_account_binding.vault') as Address,
      }
    })
  }

  probe(account: PublishingAccountRef): Promise<ChannelHealthProbe> {
    return probeXAccount(this.deps.transport, account.accountId, () => this.deps.clock.nowUnix())
  }

  record(record: ChannelHealthRecord): Promise<void> {
    return this.deps.store.put(record)
  }
}
