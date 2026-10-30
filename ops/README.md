# `@fee-split-vaults/ops` — the operations plane

Everything needed to actually run this: the recurring jobs, the alerts that
watch them, the runbooks the alerts point at, the database migrations, the
container images, and the CI gates that keep the economics honest.

It holds no keys, signs nothing and spends nothing. Every side effect goes
through a narrow port in [`scheduler/ports.ts`](scheduler/ports.ts) that an
adapter elsewhere implements.

```
ops/
  lib/          clock, structured logging, deterministic ids, the single import of config/protocol.ts
  scheduler/    job definitions, the dispatcher, locks, idempotency, dead letters, the operator CLI
  monitoring/   alert definitions as code, with severities, auto-actions and runbook links
  runbooks/     eight incident runbooks; the alert tests fail if one is missing
  migrations/   forward-only SQL DDL and its runner
  ci/           the gates: hardcoded creator rates, secrets, ESM import hygiene
  docker/       the api and orchestrator images
```

## The four properties the scheduler gives every job

A job author gets these from the pipeline or not at all — they are not left to
each job to remember.

- **Idempotent.** Every run is keyed on `(jobId, scope, period)`, and the key is
  a pure function. A crash between doing the work and recording it is
  recoverable, and a retry is a no-op. For the escrow sweep, "not a no-op" means
  a second on-chain claim.
- **Singleton.** A lease-based lock keyed on `(jobId, scope)`. Two schedulers on
  two boxes do not both sweep the same escrow.
- **Dead-lettered.** A job that exhausts its attempts is parked with its full
  context, never dropped and never retried forever.
- **Fail closed.** If the lock backend or the run store cannot be reached, the
  job **does not run**. Uncertainty is not permission.

The pipeline is one readable function in
[`scheduler/scheduler.ts`](scheduler/scheduler.ts): freeze gate → run record →
lock → execute with a timeout → settle. The order matters and the comment there
says why.

## The jobs

| Job | Trigger | Moves money |
| --- | --- | --- |
| `escrow.sweep` | escrow value over threshold, **plus** a forced 24h interval, **plus** the executor outbox | yes |
| `escrow.settle` | a completed sweep, with a 6h safety net | yes |
| `recon.structural` | every 5 minutes | no |
| `recon.sweep_match` | every 2 minutes and on each sweep | no |
| `recon.trial_balance` | daily, 02:00 UTC | no |
| `recon.clean_room` | weekly, Sunday 03:00 UTC — a 5% sample **plus** 100% of top-tier coins | no |
| `tier.reevaluate` | daily per vault, staggered, on the trailing 7-day median | no |
| `delivery.predicates` | every 15 minutes, draining each SKU's offsets including T+24h and T+7d | no |
| `report.weekly_dev` | weekly, Monday 09:00 UTC, one per client per ISO week | no |
| `screening.rescreen` | on a metadata-change event, with a 30-minute sweep as the safety net | no |
| `vault.heartbeat` | every 6h per vault; sends `CoinVault.heartbeat()` when the operator has been silent for a quarter of the dead-man window | no |
| `publishing.health` | every 6h per bound X account; `GET /2/users/me` under the account's own token, verdict appended to `publisher_account_health` (the publisher refuses an account without a fresh `ok`; `unreachable` fails the run and is retried, never recorded) | no |
| `monitoring.evaluate` | every minute: collects the signal snapshot from Postgres and the escrow, evaluates the alert catalog, logs and pages what fires, clears what stopped | no |

Reconciliation is deliberately **exempt from the authorization freeze**. A freeze
that stopped the checks could never be lifted, because lifting it requires
knowing the books are right.

The escrow sweep has a third trigger that is easy to miss and load-bearing: the
executor's **outbox**. A claim that was broadcast and then lost before the ledger
write has already drained the escrow, so neither the value threshold nor the
forced interval can ever see it again. Draining the outbox is how that money gets
onto the books.

## Running it

```bash
# Build. ops compiles IN PLACE - see the comment in tsconfig.json for why.
npm run build            # from the repository root, walks the project references
npx tsc --build ops/tsconfig.json

# The whole plane, end to end, against in-memory adapters. No chain, no
# database, no vendor. Ten seconds.
node ops/scheduler/run-local.js

# Tests.
npx vitest run --root ops
```

Local stack with Postgres. The orchestrator runs the real composition root
(`OPS_PORTS_MODULE=@fee-split-vaults/fleet/ports`); which dependencies are live is
decided by the `FLEET_*` variables passed through from `.env.local`, and
`.env.example` documents every one and the refusal a malformed value produces.

```bash
docker compose up -d db
docker compose run --rm migrate
docker compose --env-file .env.local up api orchestrator
```

## The scheduler process

`node ops/scheduler/main.js` is what the orchestrator container runs. It refuses
to start in three situations, all deliberate:

1. **No `DATABASE_URL`.** There is no in-memory production mode.
2. **Pending migrations.** Starting against a schema this build does not match is
   how a job writes to a column that is not there, at 3am, once.
3. **No port adapter.** `OPS_PORTS_MODULE` must name a module exporting
   `createPorts({ driver, nowUnix })`. Without it the scheduler would tick
   happily while doing nothing, which is the worst failure this component has.
   `OPS_ALLOW_FAKE_PORTS=1` overrides it for development only.

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | required |
| `OPS_PORTS_MODULE` | required unless `OPS_ALLOW_FAKE_PORTS=1` |
| `OPS_WORKER_ID` | lock ownership; defaults to `hostname:pid` |
| `OPS_TICK_SECONDS` | the **longest** sleep between ticks, default 30; must be ≥ 1 |
| `OPS_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |

The loop does not sleep a fixed interval. After each tick it asks the fleet
port for the earliest `nextDueUnix` any coin last reported
(`FleetRunner.earliestDueUnix()`) and sleeps
`min(OPS_TICK_SECONDS, max(1, earliest - now))`: a coin due in three seconds is
not kept waiting for a thirty-second timer, and the non-fleet jobs keep their
cadence regardless of what the fleet reports. Lease and idempotency semantics
are untouched by this; only the wake-up time moves.

### The ports, and which are real

Every job is constructed with an `OpsPorts` bundle
([`scheduler/ports.ts`](scheduler/ports.ts)). Under the fleet ports module
([`packages/fleet/src/ports.ts`](../packages/fleet/src/ports.ts)) every port
is a real implementation from [`scheduler/adapters/`](scheduler/adapters/)
whenever its inputs exist; a port stays the in-memory fake from
[`scheduler/fakes.ts`](scheduler/fakes.ts) only for an ABSENT INPUT, named in
the substitution banner and refused under `FLEET_REFUSE_FAKES=1`. Every
adapter refuses with a typed `OpsAdapterError` (`adapters/errors.ts`) on an
unreachable dependency, a missing row or an unknown enum - never a default.

| Port | Adapter | Data source | Stays fake when |
| --- | --- | --- | --- |
| `vaults` | `PgVaultDirectory` | `vault_record` via the vault repository (consent terms projected, signature never leaves the row) | never (a database is required) |
| `assets` | `ChainAssetRegistry` | `symbol()/decimals()` at head cross-checked against `quote_asset` (kill switch, `max_transfer_minor`) | no `FLEET_CHAIN=live` |
| `escrow` / `sweeper` / `settlement` / `enforcement` / `heartbeat` | `ChainEscrowReader`, `ChainSweepExecutor`, `ChainSettlementExecutor`, `ChainEnforcementActions`, `ChainVaultHeartbeat` | Venue escrow credits and `CoinVault` claim/settle/suspend/heartbeat signed by `OPERATOR_SIGNER_KEY`; outboxes in migration 0019 | no live chain; no `OPERATOR_SIGNER_KEY` for the four that sign |
| `ledger` | `SqlLedgerOps` | `ledger_*` via the ledger facade; receipts in `ops_sweep_match` / `ops_settlement_record` (0015); three-way match legs from the chain scan (`received`, `ledger_recognized`) and the fee postings (`escrow_credited`), offered after `RECONCILIATION.sweepMatchGraceSeconds`; clean room recomputes income from postings under the precedence rule | no live chain or price feed |
| `qf` | `IndexerQfSource` | `computeQf` over the fee indexer's postings and the pinned price book; signals from the holder index (`FLEET_HOLDERS=index`) or a typed `signals_unavailable` refusal | no live chain or price feed |
| `tiers` | `PgTierRegistry` | `vault_record.tier` (written through the repository) + `ops_tier_history`, `ops_qf_observation` | never |
| `reports` | `LedgerReportBuilder` | period flows from `ledger_entry` priced at period end, `receipt`, refusals/declines from `ops_agent_run`, withholds from `ops_predicate_withhold` | no asset registry or price feed |
| `reportDelivery` | `TelegramReportDelivery` | `sendMessage` to the coin's bound `telegram` account (chat id) from the coin directory; disclosure composed by code from `DISCLOSURE.operatorName`; one row per period in `ops_report_delivery` | no `OPS_REPORT_TELEGRAM_BOT_TOKEN`/`TELEGRAM_BOT_TOKEN` or `PUBLISHER_RECEIPTS_BASE_URL` |
| `metadata` | `ChainMetadataWatcher` | ERC-20 `name()/symbol()` at head for every observed vault (the launch token has no on-chain URI, so those are the only fields), hashed into `token_metadata_observation`; the ref is `chain:<token>@<blockHash>` | no live chain |
| `screening` | `PgScreeningService` | `ScreeningEngine` with the same lexicon/SDN sources as onboarding (`SCREENING_LEXICON_FILE`, `OFAC_SDN_FILE`/`OFAC_SDN_URL`), adjudicator with `ANTHROPIC_API_KEY`; verdicts through `PgScreeningStore.put`, hashes in `ops_screening_hash` | no live chain (the adjudicator alone is a recorded fake: every verdict RESTRICTED) |
| `alerts` | `LoggedAlertSink` = `PgAlertLog` + `WebhookAlertSink` | `ops_alert_firing`, then a JSON POST to `OPS_ALERT_WEBHOOK_URL` (https; optional `OPS_ALERT_WEBHOOK_TOKEN` bearer); a non-2xx is a typed failure, not a swallowed page | no `OPS_ALERT_WEBHOOK_URL` |
| `monitoring` | `PgMonitoring` over `PgSignalCollector` ([`monitoring/collect.ts`](monitoring/collect.ts)) | `ledger_variance`/`ledger_freeze`, `ops_sweep_match`, halt notices, `indexer_pending_override`, `quote_asset`, `ops_agent_run`, `publication`, `publisher_account_health` (newest non-ok row per account → `publishing.suspendedChannels`), `ops_tier_history`, `ops_dead_letter`, `ops_job_run`, live escrow reads | no live chain or no webhook |
| `publishingHealth` | `PgPublishingHealth` ([`scheduler/adapters/publishing-health.ts`](scheduler/adapters/publishing-health.ts)) | X bindings from `publisher_account_binding`; probe through the publisher's X transport (sealed credentials, refresh); rows into `publisher_account_health` | no `PUBLISHER_TOKEN_KEY`, `X_CLIENT_ID` or `X_REDIRECT_URI` |

| Port | Implementation under `@fee-split-vaults/fleet/ports` |
| --- | --- |
| `fleet` | `Fleet` (packages/fleet): one agent team per coin, idempotent per run key |
| `predicates` | [`PgPredicateQueue`](scheduler/store/predicates.ts) over `ops_predicate_check` (migration 0013). The **same instance** is the orchestrator's `PredicateQueue`: `attemptSpend` enqueues a schedule after a reimbursement settles, and `delivery.predicates` drains it. Failures write `ops_predicate_withhold` / `ops_vendor_penalty`; nothing here moves money. |
| `predicateVerifier` | [`BrokerPredicateVerifier`](scheduler/verifier.ts) when `FLEET_EVIDENCE=dexscreener`: rebuilds the broker's `DeliveryRecord` from the queued row and asks `PredicateRegistry.verify` for a verdict at the row's offset. Fails closed on anything the registry refuses. Without a real evidence source it stays the fake, which passes nothing. |
| `receipts` | the orchestrator's `ReceiptStore` (Postgres with `DATABASE_URL`). The delivery job's only write to it is `publishDeliveredReceipt` on the first passing check; a pass with no receipt to re-issue raises `procurement_receipt_missing` rather than succeeding quietly. |

## Migrations

Forward-only. There is no `down`: rolling back a schema change that production
traffic has already written to is a data-loss operation dressed up as a
convenience, and the recovery path is a new forward migration, which is
reviewable.

```bash
node ops/migrations/cli.js list                      # offline, no database
node ops/migrations/cli.js plan  --database-url ...  # what would run
node ops/migrations/cli.js up    --database-url ...
node ops/migrations/cli.js status --database-url ...  # exits 1 if anything is pending
```

The runner refuses in four situations, each of which is a way a production schema
quietly stops matching the repository: an applied migration was **edited**, an
applied migration's **file is gone**, a pending migration is numbered **behind
the head**, or two files claim the **same version**. Each migration and its
bookkeeping row commit in one transaction, so a half-applied migration cannot be
recorded as done.

`0001_ledger.sql` is a verbatim copy of `packages/ledger/src/store/schema.sql`.
A migration is a historical record and must never be edited once applied, so a
drift test fails the build if the ledger package grows a table that no migration
creates — the signal to add a **new** migration, never to change 0001.

## The CI gates

```bash
node ops/ci/no-hardcoded-rates.js    # the important one
node ops/ci/secret-scan.js
node ops/ci/lint-imports.js --scope ops
```

**`no-hardcoded-rates`** is the gate this repository most needs. The creator's
net branches on one per-token setting — 0.70% of volume with buyback off, 0.35%
with it on — so anything that assumes a single rate is wrong for half the book,
in the direction that overstates what a client will earn. That is not a rounding
error; it is the difference between a projection and a misrepresentation.
`config/protocol.ts` exposes `creatorNetBps(buybackEnabled, creatorTaxBps)` and
every consumer must call it.

The same argument applies to **our own** published terms. The September
repricing moved `TERMS.operatorBps` from 1000 to 500 and `TIERS.T1.gateQfPerDay`
from 250 to 1,000/day, and this gate reported clean over every file that had
written one of those down — because it only ever looked for the creator rate.
Four more rules now cover the numbers `config/protocol.ts` owns.

Nine rules, and the design work is in making them quiet enough to be trusted:

| Rule | Fires on |
| --- | --- |
| `creator-rate-decimal` | a bare `0.007` / `0.0035` anywhere in code |
| `creator-bps-literal` | `creatorNetBps = 70` — the function collapsed into a constant |
| `creator-rate-percent` | `0.70%` / `35%` on a line about the creator fee rate |
| `creator-rate-decimal-in-fee-context` | a bare `0.7` / `0.35` on a line about the creator fee rate |
| `published-terms-literal` | `operatorBps = 1000`, `budgetBps = 2000` in **source** — read `TERMS.*` |
| `tier-gate-literal` | `gateQfPerDay: 250` anywhere, tests included; a zero gate is allowed |
| `qualification-floor-literal` | `1_500` on a line about the qualification floor |
| `dial-as-decimal` | the dial written as a float (`qf * 0.2 * 30`) on a line about the budget |
| `shared-window-literal` | `priceMaxAgeSeconds ?? 15 * 60` — restating what `money.ts` owns |

The last five are scoped so they do not cry wolf. `published-terms-literal`,
`dial-as-decimal` and `shared-window-literal` skip tests and fixtures, because a
vault's `operatorBps` is frozen in its CREATE2 salt and a fixture at 1,000 bps is
modelling a real client rather than restating a default. `tier-gate-literal`
applies everywhere, because a gate is never a per-vault fact and a test that
writes one down is the exact staleness this repricing had to clean up. Zero is
exempt from both bps rules and from the gate rule: "no fee", "no dial" and "no
gate" are arguments, not remembered numbers.

Comments are stripped before scanning, because prose explaining the branch is the
opposite of the problem. A line that names **both** branches is skipped for the
same reason — that is the correct disclosure. A backslash-escaped dot is skipped
too: `0\.007` inside a regex is a pattern that **detects** the rate, which is
what a test doing this same job looks like. Suppress with a typed entry in
[`ci/rates-allowlist.ts`](ci/rates-allowlist.ts) or an inline
`// no-hardcoded-rates: allow <rule-id> - <reason>`; both demand a reason.

## Alerts

Twenty-two definitions in [`monitoring/alerts.ts`](monitoring/alerts.ts), each
binding a predicate, a severity, an **auto-action** and a runbook. Every
auto-action is a **restriction** — freeze, halt, suspend, throttle, disable.
There is deliberately none that spends, publishes or unblocks: automation may
narrow the blast radius, never widen it. A test enforces that.

The catalog also carries `gas_subsidy_expiry_approaching`, because every
measurement behind the sweep thresholds was taken inside the Robinhood Chain gas
subsidy that ends around 29 September 2026. When it lapses, sweeping a dust
balance can cost more than it recovers, and the thresholds have to be re-derived
from a live gas quote. That is a scheduled piece of work rather than a surprise
in the ledger, and the alert is what makes it one.
