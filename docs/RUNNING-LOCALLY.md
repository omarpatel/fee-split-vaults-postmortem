# Running locally

From a clean checkout to a working control plane and a working web app.

Before this document existed, `node apps/api/dist/main.js` on a clean checkout produced:

```
ConfigError: config: VENUE_VAULT_INIT_CODE_HASH is required and has no safe default
```

and nothing in the repository said where such a value comes from. The refusal was correct — it
is still there, unchanged — but there was no path past it, so **the service could not be started
by anybody**. `tools/bootstrap-env.ts` is that path: it derives the two values that are
derivable, fills the rest with defaults that cannot point at the wrong chain, and writes
`.env.local`.

---

## The short version

```bash
npm install
npm run contracts:build          # needs forge; see "Prerequisites" if you do not have it
npm run build
npm run dev
```

`npm run dev` writes `.env.local` if there is none, rebuilds `apps/api` if `dist/` is stale,
then starts both processes:

```
dev: .env.local is missing; generating one with DEV-ONLY values.
dev: apps/api  -> http://127.0.0.1:8080   (env: .env.local)
dev: apps/web  -> http://127.0.0.1:5273
dev: apps/web is on its IN-MEMORY FIXTURE backend, which is the mode that works today.
dev: apps/api serves no /v1/* routes yet, so --web-api would render errors on every page.
```

Ctrl-C stops both. If either dies, the other is stopped too.

To do it by hand instead:

```bash
npm run bootstrap -- --dev-identity     # writes .env.local
npm run start:api                       # node --env-file-if-exists=.env.local apps/api/dist/main.js
npm run dev -w @fee-split-vaults/web          # vite, port 5273
```

Check it:

```bash
$ curl -s localhost:8080/health
{"status":"ok","atUnix":1788896098}

$ curl -s -H 'Authorization: Bearer dev-only-token-published-in-git-not-a-secret' \
       localhost:8080/routes | head -c 120
{"routes":["GET /health - Liveness. Says nothing about whether the chain or the ledger is healthy.", ...
```

---

## Prerequisites

| Thing | Version | Needed for |
| --- | --- | --- |
| Node | >= 22 (`engines`); developed on 24.18.1 | everything. `tools/*.ts` run directly under type stripping, so 22.18+ is the real floor for the tools. |
| npm | 9+ (workspaces) | `npm install` at the root installs every workspace. |
| Foundry (`forge`) | 1.8+ | `contracts/out/` — **the bootstrap reads the CoinVault artifact from there.** |
| Docker | any | only for Postgres, and only for the ops CLIs. |

`contracts/out/` is gitignored, so a clean checkout has no artifacts and `npm run bootstrap`
will refuse with:

```
bootstrap-env: no CoinVault artifact at .../contracts/out/CoinVault.sol/CoinVault.json.
contracts/out/ is gitignored, so a clean checkout has none. Build them first:
  npm run contracts:build   (forge must be on PATH)
```

If `forge` is installed but not on PATH (it lives at `~/.foundry/bin/forge` by default):

```bash
export PATH="$HOME/.foundry/bin:$PATH"
npm run contracts:build
```

---

## What `npm run bootstrap` actually does

Two values are **derived**. They are real, and they stay correct.

**`VENUE_VAULT_INIT_CODE_HASH`** — `keccak256` of CoinVault's compiled creation code, read from
`contracts/out/CoinVault.sol/CoinVault.json`. This works because CoinVault takes no constructor
arguments (it reads its terms back from `VaultDeployer.pendingConsent()` during construction), so
the init code is the artifact bytecode with nothing appended. `contracts/foundry.toml` sets
`bytecode_hash = "none"` and `cbor_metadata = false`, so the bytes do not depend on the compiler's
view of file paths and two machines derive the same hash. The bootstrap refuses if either of those
settings changes.

**`VENUE_VAULT_DEPLOYER`** — `CREATE(factory, 1)`. **This is the CREATE2 base, not the factory.**
VaultFactory embedding CoinVault's init code exceeded EIP-170, so it delegates to a `VaultDeployer`
its constructor creates, and a contract's first `CREATE` uses nonce 1. Using the factory address
here yields wrong vault addresses silently, and a wrong vault address is a dev pointing their fee
revenue at a contract that does not exist.

Both relationships are asserted in Solidity, not assumed:
`contracts/test/unit/DerivedDeployment.t.sol`. The TypeScript mirrors are in
`tools/lib/deployment-derivation.ts`, and their test vectors were taken from Foundry and
re-confirmed with `cast compute-address` / `cast keccak`.

Regenerate the ground truth with:

```bash
forge test --root contracts --match-test test_logDerivationGroundTruth -vv
```

**Re-run `npm run bootstrap -- --force` after any change to `contracts/src/CoinVault.sol`.** The
hash moves, and with it every vault address the service predicts.

---

## What could NOT be derived, and what was written instead

There is **no VaultFactory deployed on chain 4663**. `config/protocol.ts` lists Venue' own V2
contracts (`v2Factory`, `v2MemeHook`, `v2FeeEscrow`, …) and none of ours. So `VENUE_VAULT_FACTORY`
has no real value to write, and a plausible-looking one is precisely the failure the fail-closed
loader exists to prevent.

The bootstrap writes the published sentinels from `config/dev-only.ts` instead:

| Variable | DEV-ONLY value | Why it is safe to publish |
| --- | --- | --- |
| `VENUE_VAULT_FACTORY` | `0x00000000000000000000000000000000deadbeef` | 32 leading zero nibbles. No `CREATE` or `CREATE2` reaches it — that would be a ~2^128 search — so no real deployment can collide with it, and it is obviously fake in any log line. |
| `VENUE_VAULT_DEPLOYER` | `0xa97d2be8afcfcff4b5726fe707ccc6785ac4d51c` | `CREATE(sentinel factory, 1)`. Derived, so the triple stays self-consistent. |
| `VENUE_OPERATOR_API_TOKEN` | `dev-only-token-published-in-git-not-a-secret` | It is committed. It protects nothing and it says so. |
| `VENUE_RECEIPTS_BASE_URL` | `https://receipts.localhost.invalid` | RFC 2606 reserves `.invalid` to never resolve. |
| `VENUE_OPERATOR_NAME` | `DEV ONLY local bootstrap, not a legal entity` | Names no legal entity. Only written under `--dev-identity`. |

### These are refused in production

`apps/api/src/config.ts` refuses to boot when `NODE_ENV=production` and any of the following holds.
Two independent guards, because there are two ways for a laptop's configuration to become a
deployment's:

1. **The marker.** `VENUE_DEV_ONLY_CONFIG` is set. Catches shipping the generated file as-is.
2. **The values and their shape.** Any of the five sentinels appears, or `VENUE_VAULT_FACTORY` /
   `VENUE_VAULT_DEPLOYER` is an address with 24+ leading zero nibbles. Catches copying addresses or
   the token out of `.env.local` into a real secret store, where the marker line would not follow.

Verified:

```
$ NODE_ENV=production node --env-file=.env.local apps/api/dist/main.js
config: VENUE_DEV_ONLY_CONFIG is set and NODE_ENV=production. That variable marks an environment
generated by tools/bootstrap-env.ts, which fills values that cannot be derived with sentinels
published in config/dev-only.ts. Replace every line tagged [DEV-ONLY] with real values and remove
VENUE_DEV_ONLY_CONFIG.

$ grep -v VENUE_DEV_ONLY_CONFIG .env.local > no-marker.env
$ NODE_ENV=production node --env-file=no-marker.env apps/api/dist/main.js
config: VENUE_VAULT_FACTORY is the DEV-ONLY value published in config/dev-only.ts and
NODE_ENV=production. ...
```

Anything other than `NODE_ENV=production` — including unset — is treated as a laptop and the
sentinels are accepted. Refusing there would undo the change that made the service startable.

### Once a factory exists

```bash
npm run bootstrap -- --factory 0x<the deployed VaultFactory> --force
```

The deployer is re-derived from it, both are tagged as real rather than DEV-ONLY, and the marker
is dropped. Then supply the operator identity yourself and delete the remaining DEV-ONLY lines.

---

## The two things `--dev-identity` fills that a real operator must not take

Without `--dev-identity`, `npm run bootstrap` leaves the operator identity **empty on purpose** and
the API refuses to boot, naming the variable. That is the intended production-shaped output. Fill
these three yourself:

```bash
VENUE_OPERATOR_NAME=<the legal operating entity>
VENUE_RECEIPTS_BASE_URL=https://<your receipts host>
VENUE_OPERATOR_API_TOKEN=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")
```

`VENUE_OPERATOR_NAME` goes through `requireOperatorName()` in `packages/core`, which rejects
`SET_ME_BEFORE_LAUNCH`, `TBD`, `TODO`, `CHANGEME`, `n/a`, anything containing `placeholder`, and
anything starting `your_`. The API, the publisher and the desk all refuse to construct while it is
a placeholder, because a disclosure that names nobody is a legal exposure under three regimes.

---

## Full environment audit

Every variable read by `apps/`, `packages/`, `ops/` or `tools/`. `.env.example` is the reference for
what each one *means*; this table is the answer to "who has to supply it, and can anything derive
it".

Legend for **Source**:
**derived** = computed from repository artifacts ·
**default** = a safe value the code already uses ·
**dev-only** = fake, refused in production ·
**human** = only a person can supply it ·
**optional** = unset is a supported state.

### apps/api — the control plane (`apps/api/src/config.ts`)

| Variable | Required | Source | Notes |
| --- | --- | --- | --- |
| `VENUE_VAULT_INIT_CODE_HASH` | yes | **derived** | `keccak256(CoinVault creation code)` from `contracts/out/`. Real value. |
| `VENUE_VAULT_DEPLOYER` | yes | **derived** from the factory | `CREATE(factory, 1)`. Not the factory. |
| `VENUE_VAULT_FACTORY` | yes | dev-only until deployed | None exists on chain 4663. |
| `VENUE_RPC_URLS` (or `VENUE_RPC_URL`) | yes | default | Two keyless public endpoints for 4663. **Two is the minimum**: the indexer requires a quorum and has no single-provider fallback. |
| `VENUE_OPERATOR_NAME` | yes | **human** | Falls back to `DISCLOSURE.operatorName`, which ships as `SET_ME_BEFORE_LAUNCH` and is rejected. |
| `VENUE_RECEIPTS_BASE_URL` | yes | **human** | Must be `https`. Disclosure footers are built from it. |
| `VENUE_OPERATOR_API_TOKEN` | yes | **human (secret)** | >= 32 chars, compared in constant time. |
| `VENUE_CHAIN_ID` | no | default `4663` | Any other value is refused: wrong chain = wrong EIP-712 domain. |
| `PORT` | no | default `8080` | |
| `VENUE_SCREENING_MAX_AGE_SECONDS` | no | default `604800` | |
| `VENUE_ANTI_SNIPE_HOLD_SECONDS` | no | default `900` | |
| `SCREENING_LEXICON_FILE` | no | **human** | JSON slur list in the `parseLexiconJson` shape; never checked in. Unset: the builtin list only, recorded as a fake, and no CLEAR verdict can issue. Set but unreadable/empty/malformed: startup refusal. |
| `OFAC_SDN_URL` / `OFAC_SDN_FILE` | no | default `https://www.treasury.gov/ofac/downloads/sdn.csv` | The official SDN list (`sdn.csv` or `sdn.xml`), loaded once at boot. Authoritative only when dated (XML `Publish_Date` or HTTP `Last-Modified`). A named source that fails is a startup refusal; the unnamed default failing is a recorded fake. |
| `NODE_ENV` | no | — | Only `production` changes behaviour: it turns on the DEV-ONLY refusals. |
| `VENUE_DEV_ONLY_CONFIG` | no | dev-only marker | Written by the bootstrap. Refused in production. |

### ops — the operations plane

| Variable | Required | Source | Read by |
| --- | --- | --- | --- |
| `OPS_PORTS_MODULE` | yes, unless the next one is `1` | human | `ops/scheduler/main.ts:51`. Without adapters the scheduler would tick and do nothing, which is refused. |
| `OPS_ALLOW_FAKE_PORTS` | no | dev-only (`1`) | `ops/scheduler/main.ts:53`. In-memory fakes. |
| `DATABASE_URL` | for `migrate` and `status` only | human / local Postgres | `ops/lib/pg.ts:47`, `ops/migrations/cli.ts:88`. |
| `OPS_WORKER_ID` | no | default `hostname:pid` | Set it explicitly in a container so lease ownership survives a restart. |
| `OPS_TICK_SECONDS` | no | default `30` | |
| `OPS_LOG_LEVEL` | no | default `info` | |

### packages

| Variable | Required | Source | Read by |
| --- | --- | --- | --- |
| `VENUE_DATA_DIR` | no | default | `packages/catalog/src/paths.ts:16`. Defaults to the checked-in `data/`, which is correct. |
| `ANTHROPIC_API_KEY` | no | human (secret) | Read by the Anthropic SDK inside `createAnthropicModelClient()` (`packages/runtime/src/model/anthropic.ts:204`). **Nothing in this repository calls that factory yet**, so today it is unread in practice. Unset means no model runs at all; T0 is deterministic by design and needs none. |

### apps/web

| Variable | Required | Source | Read by |
| --- | --- | --- | --- |
| `VITE_API_BASE_URL` | no | — | `apps/web/src/env.ts:21`. **Unset is the working mode** — see the next section. |

### tools/ — measurement CLIs, not the service

`tools/lib/env.ts` reads `VENUE_RPC_URL`, `VENUE_RPC_URLS`, `VENUE_CHAIN_ID`, `ESCROW_BACKEND`,
`BITQUERY_URL`, `BITQUERY_TOKEN`, `BITQUERY_NETWORK`, `GECKOTERMINAL_BASE`,
`GECKOTERMINAL_NETWORK`, `GECKOTERMINAL_DEX_IDS`, `VENUE_CACHE_DIR`, `VENUE_HTTP_RPS`,
`VENUE_HTTP_MAX_RETRIES`, `VENUE_HTTP_TIMEOUT_MS`, `VENUE_LOG_CHUNK_BLOCKS`,
`VENUE_PRICE_USD_<SYMBOL>` (any suffix), `VENUE_PRICE_SOURCE`, `VENUE_V2_GENESIS_UNIX`,
`VENUE_BLOCK_TIME_SECONDS`. `tools/lib/onchain-price.ts` reads the seven `VENUE_ONCHAIN_PRICE_*`
variables; `tools/cross-verify.ts:525` reads `VENUE_RPC_URL_SECONDARY`; the scripts under
`tools/artifacts/` read `VENUE_ASSETS_FILE`, `VENUE_COINS_OUT`, `VENUE_OUT`, `OUT`, `CENSUS_OUT` and
`VENUE_RPC_BATCH`.

All of these have defaults except the prices. **A missing price is a refusal, never a zero** — QF
cannot be measured, no tier can be granted, no spend can be authorised. `.env.example` carries the
full explanation, including why the `3200` in it is the shape of the variable and not a rate.

### Documented but NOT read by any code

`.env.example` marks five variables as "NOT YET READ": `TELEGRAM_AUDIT_CHAT_ID`, `X_API_KEY`,
`X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`. Setting any of them today has no effect.
The former `VENUE_USER_ID_SALT` / `VENUE_POLICY_SIGNING_KEY` / `VENUE_POLICY_KEY_ID` are gone: the
fleet reads `FLEET_USER_ID_SALT` (refused absent beside any real dependency) and
`POLICY_SIGNING_KEY` + `POLICY_SIGNING_KEY_ID` (refused absent beside `FLEET_SETTLEMENT=live` or
`FLEET_CATALOG=data`), and `packages/fleet/src/adapters.ts` builds the broker's `PolicyKeyring` from
them.

**`TELEGRAM_BOT_TOKEN` belongs in that list and is currently mis-documented.** `.env.example` says
it is "genuinely read (packages/desk/src/telegram/client.ts)". The only occurrence of the name in
the entire repository is inside a JSDoc example at `packages/desk/src/telegram/client.ts:80`:

```
 *   const client = new BotApiTelegramClient(process.env.TELEGRAM_BOT_TOKEN!, http)
```

That is an illustration in a comment, not a read. `BotApiTelegramClient` takes the token as a
constructor argument and nothing constructs it from the environment. Setting `TELEGRAM_BOT_TOKEN`
configures nothing.

---

## apps/web and apps/api share a route contract

`apps/web/src/api/routes.ts` is the contract and `apps/api/src/v1/routes.ts` serves it verbatim,
mounted by `buildRouter` beside the operator routes. Every path is classified by
`authScopeOf` (`apps/api/src/routes.ts`) before the router sees it:

| scope | paths | credential |
|---|---|---|
| public | `/health`, `/v1/protocol`, `/v1/coins`, `/v1/coins/:vault{,/receipts,/vendors}`, `/coins/:vault/agent{,/runs,/roles}`, `/v1/auth/nonce`, `/v1/auth/verify`, `/v1/onboarding/quote`, `/v1/onboarding/submit`, `/v1/onboarding/retrofit/:token`, `/accounts/x/callback` | none |
| dev | `/v1/dev/**` | `Authorization: Bearer <session>` from `/v1/auth/nonce` + `/v1/auth/verify` (EIP-191 `personal_sign` over a single-use server nonce; never an address alone) |
| operator | everything else, including anything unlisted | `Authorization: Bearer $VENUE_OPERATOR_API_TOKEN` |

```
$ curl -s localhost:8080/v1/coins
[]
$ curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/v1/dev/vaults
401
```

What each `/v1` route needs to answer with real data, beyond the boot minimum:

- `/v1/protocol` and `/v1/onboarding/quote` — `VENUE_ADAPTER`, `VENUE_TERMS_HASH`, `VENUE_TERMS_URL`
  (all three; `VENUE_REFERRER_SHARE_BPS` for a quote naming a referrer). Unset: 503 `terms_unconfigured`.
- USD figures on `/v1/coins/:vault` and the dev reports — `FLEET_PRICES=coingecko` + `COINGECKO_IDS`.
  A coin with credits and no pinned price answers 503 `price_unavailable`; a coin with no credits
  reports zero without a price.
- Escalations, delivery checks, QF measurement, operated accounts, dev sessions that survive a
  restart — `DATABASE_URL` (migration `0022_dev_sessions.sql` adds `dev_auth_challenge`,
  `dev_session`, `onboarding_quote` and the ack columns on `ops_escalation`).
- `/v1/dev/vaults/:vault` (dial, clocks, claimable), `/v1/onboarding/submit` (ERC-20 name/symbol)
  and the retrofit preflight (escrow credit) read the chain over the same settled quorum pin.
- `/v1/onboarding/submit` records a signed consent as `signed` and returns the factory `deploy`
  call for the dev's own wallet; a greenfield consent (token `0x0`) answers 501 `not_supported`.

- **Default (`npm run dev`)** — apps/web runs on `FixtureApiClient`, a real in-memory
  implementation of the same `ApiClient` interface: same lag, same tier gating, same split
  arithmetic. It labels itself as demo data in the chrome.
- **`npm run dev -- --web-api`** — sets `VITE_API_BASE_URL=http://127.0.0.1:8080`. The directory
  and every coin page render from apps/api (empty until a coin is onboarded); the agent page answers
  503 `agent_not_wired` from this process, as the boot banner says.

---

## What the API can and cannot do locally

It prints this itself at boot, and it is not a limitation of the local setup — the same is true in
production today:

```
NOT WIRED: recipient reader, vault deployer, reporting price book, real lexicon,
authoritative OFAC list. Every one of them fails CLOSED, so this process can
draft and verify consents and serve receipts, and it cannot activate a client.
```

Works locally: `/health`, `/routes`, `/consent/draft` (returns the exact EIP-712 payload and the
predicted vault address), `/consent/verify`, reading an onboarding, reading receipts and reports.

Refuses locally and in production: deploying a vault (no signer), confirming fee-recipiency
pointing (no recipient reader), activating a client (the screening engine cannot issue a CLEAR
verdict: `DEFAULT_LEXICON_SOURCE` ships no slur list and `SampleSdnSource.authoritative()` is
false, both deliberately).

---

## The operations plane

```bash
npm run status -- --help                       # the command list; needs no database
npm run scheduler:local -w @fee-split-vaults/ops     # ticks the whole pipeline against in-memory fakes
```

`scheduler:local` is the fastest way to see the operations plane work: due-scope computation,
locking, idempotency, the split, the three-way match and the dead-letter path, with no chain, no
database and no vendor.

The `status` CLI talks to Postgres directly — during an incident the application may be exactly
what is broken, so it deliberately has no in-memory mode. For a database:

```bash
docker compose up -d db
export DATABASE_URL=postgres://venue:local-development-placeholder@127.0.0.1:5432/fee_split_vaults
npm install pg          # loaded at the point of use, not a build-time dependency of ops
npm run migrate -w @fee-split-vaults/ops -- --database-url "$DATABASE_URL"
npm run status -- jobs
```

`npm run migrate -w @fee-split-vaults/ops -- list` works offline and needs no database.

---

## Verifying the whole tree

```bash
npm run build                                  # tsc --build, 14 projects
npx vitest run                                 # packages/ and apps/
npx vitest run --config tools/vitest.config.ts # tools/
npm test -w @fee-split-vaults/ops                    # ops/
npm run check                                  # cross-package coherence
npm run ci:rates   -w @fee-split-vaults/ops
npm run ci:secrets -w @fee-split-vaults/ops
npm run ci:imports -w @fee-split-vaults/ops
npm run contracts:test                         # forge
npm run build -w @fee-split-vaults/web
```

The root `vitest.config.ts` covers `packages/**` and `apps/**` only; `tools/` and `ops/` each have
their own config. All four have to be run to cover the repository.

---

## Troubleshooting

**`ConfigError: config: <VAR> is required and has no safe default`**
Run `npm run bootstrap -- --dev-identity`. The API now prints this guidance itself instead of a
stack trace.

**`bootstrap-env: no CoinVault artifact at ...`**
`npm run contracts:build`. `contracts/out/` is gitignored.

**`.env.local already exists and was left alone`**
Pass `--force`, or `--dry-run` to see what would be written without touching the file.

**`node: .env.local: not found`, exit code 9**
Something passed `--env-file` to Node with a path that does not exist. Note that **Node intercepts
`--env-file` anywhere in `argv`, including after the script path** — it is not forwarded to your
script. That is why `bootstrap-env` names its flag `--env-out` and `dev` names its `--env`.
Verified on Node v24.18.1.

**`VENUE_OPERATOR_NAME is unset and operatorName is unset or still a placeholder`**
Working as intended. Set a real entity name, or use `--dev-identity` for a local demo.

**Vite says "Port 5273 is in use, trying another one"**
Harmless; it prints the port it settled on. `npm run dev -- --web-port 5300` to pin one.

**The web app shows errors on every page**
You are running with `--web-api` or with `VITE_API_BASE_URL` set. See the route-contract section
above.

---

## Files

| Path | What it is |
| --- | --- |
| `tools/bootstrap-env.ts` | The bootstrap. `--help` for options. |
| `tools/dev.ts` | The `npm run dev` runner. |
| `tools/lib/deployment-derivation.ts` | The derivations, and the artifact and RLP arithmetic behind them. |
| `config/dev-only.ts` | The published sentinels and the predicates the production guard uses. |
| `contracts/test/unit/DerivedDeployment.t.sol` | The Solidity proofs the derivations rest on. |
| `.env.example` | Every variable, with the reasoning behind each. The reference. |
| `.env.local` | Generated, gitignored, per-line provenance tags in the file itself. |
