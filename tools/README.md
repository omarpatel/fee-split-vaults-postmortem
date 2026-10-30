# tools/ — the Phase 0 measurement pass

Seven CLIs that settle the numbers the plan was built on but never measured.
They are diligence instruments, not product code: nothing here writes to a
chain, signs anything, or touches a client. Every one of them prints what it
cannot know alongside what it found.

**The three weakest numbers in the plan, and who settles them:**

| Weak number | Current status | Settled by |
| --- | --- | --- |
| Tenure — how long a coin stays above a gate | Assumed 8 weeks. Measured mean age of standing stock: **2.14 days**. ~20x gap. | `escrow-index.ts` → `tenure.ts` |
| Buyback-on rate — is the creator rate 0.70% or 0.35%? | Unmeasured. **2x swing on the entire addressable market.** | `pool-fees-index.ts` |
| Addressable population above each gate | "200+" is very likely the API's 200-per-dex page cap reporting itself. | `addressable-market.ts` |

Three more close the loop: `fee-bps-probe.ts` checks whether the 1%/70% split
that `config/protocol.ts` calls "verified" is actually true for V2 (Phase 0
verified it for V1 and *inferred* it for V2), `token-metadata.ts` reads the
ERC-20 asset set off the chain and states how much of it can honestly be priced,
and `reprice.ts` turns the measurements into a mechanical STOP/GO.

---

## Running them

Node 22.18+ or 24. **No install step, no bundler, no loader** — these files are
executed as TypeScript source by Node's built-in type stripping:

```bash
node tools/escrow-index.ts --help
```

Every tool has `--help`, `--dry-run`, `--json`, `--no-cache`, `--out <file>` and
`-v/--verbose`. `--dry-run` performs **no network I/O at all**: it resolves the
config, prints the exact endpoints and block ranges it would hit, and gives a
request budget. Run it first, every time.

```bash
npx tsc --noEmit -p tools/tsconfig.json        # typecheck
npx vitest run --config tools/vitest.config.ts # tests (fixtures only, never live)
```

## Configuration

All via environment. Nothing has a network default that could silently point a
measurement at the wrong chain.

| Variable | Default | Meaning |
| --- | --- | --- |
| `VENUE_RPC_URL` | *(none — required)* | JSON-RPC endpoint for chain 4663. There is deliberately no public fallback. |
| `VENUE_RPC_URLS` | — | Extra endpoints, comma-separated. Requests round-robin across them. |
| `ESCROW_BACKEND` | `rpc` | `rpc` (direct `eth_getLogs`) or `bitquery` (GraphQL). |
| `BITQUERY_URL` | `https://streaming.bitquery.io/graphql` | GraphQL endpoint. |
| `BITQUERY_TOKEN` | — | Required when `ESCROW_BACKEND=bitquery`. Sent as a header, never in a URL. |
| `BITQUERY_NETWORK` | `robinhood` | Aggregator's network id for chain 4663. |
| `GECKOTERMINAL_BASE` | `https://api.geckoterminal.com/api/v2` | Market data base URL. |
| `GECKOTERMINAL_NETWORK` | `robinhood` | Network id. |
| `GECKOTERMINAL_DEX_IDS` | `venue-v2-dex,venue-v2,venue-dot-family` | Dexes to enumerate. |
| `VENUE_PRICE_USD_<SYMBOL>` | — | Pinned USD price, e.g. `VENUE_PRICE_USD_ETH=3200`. **Required for any USD figure.** |
| `VENUE_PRICE_USD_ETH` | — | Prices the **native** asset (`address(0)`), which is most of this escrow's value. `VENUE_PRICE_USD_WETH` is accepted as a documented fallback alias, with a warning — they are not the same asset. |
| `VENUE_PRICE_SOURCE` | `env:VENUE_PRICE_USD_*` | Provenance label attached to every USD number. |
| `VENUE_HTTP_RPS` | `4` | Global outbound ceiling in **sub-requests** per second. A JSON-RPC batch of 10 costs ten slots, not one, so turning batching on never silently multiplies the rate. Measured on this chain: ~1.3/s unbatched, ~3/s when batched. Use `0.8` unbatched, up to `~2` with `--rpc-batch 10`. Lower it to `0.5` for GeckoTerminal. |
| `VENUE_HTTP_MAX_RETRIES` | `5` | Retries before giving up. Backoff is exponential with jitter and honours `Retry-After`. |
| `VENUE_LOG_CHUNK_BLOCKS` | `5000` | Blocks per `eth_getLogs`. The scanner halves this automatically on any chunk error. **Measured on the fee escrow: use `10000`.** See the note below — the binding constraint is a query TIMEOUT, not the result cap. |
| `VENUE_CACHE_DIR` | `tools/.cache` | On-disk results cache. Re-runs are free; `--no-cache` bypasses it. |
| `VENUE_V2_GENESIS_UNIX` | 2026-08-04 | Assumed V2 deployment. Bounds every tenure claim; printed in every tenure report. |
| `VENUE_BLOCK_TIME_SECONDS` | `0.25` | **Dry-run budgeting only.** Real runs binary-search block↔time; this constant never touches a measurement. Measured on chain 4663: **0.101 s/block**, 856,582 blocks/day — the default is wrong by 2.5x and will mis-size a dry-run budget. |

Minimum viable env:

```bash
export VENUE_RPC_URL="https://<your-chain-4663-endpoint>"
export VENUE_PRICE_USD_ETH=3200      # the native asset; most of the escrow's value
export VENUE_HTTP_RPS=4
```

#### How big a chunk this endpoint actually serves (measured 7 Sep 2026)

Two different limits exist and they fail differently. Both were probed directly
against the fee escrow over the 7-day window `50419076..56389048`:

| Block span | Result |
|---|---|
| 10,000 | serves reliably; 1,500–4,000 logs |
| 12,000 | served 4/4 probes; max 3,900 logs |
| 15,000 | served 3/4; one `log query timed out` |
| 20,000 | served 1/4; three `log query timed out` |
| 25,000 | timed out on 10/10 probes |
| 50,000+ | `-32000 logs matched by query exceeds limit of 10000` |

So on a busy address the **query timeout binds long before the result cap
does**, and it is load-dependent rather than a clean threshold — the same
20,000-block span both succeeded and timed out in one probe run. The claim that
there is "no block-range cap up to ~5M blocks" holds only for addresses quiet
enough that the query finishes; it is false for this escrow.

The important safety property was verified separately: **the cap ERRORS, it does
not silently truncate.** A 50,000-block query returns `-32000 … exceeds limit of
10000` rather than a short result set, so `scanLogs`'s halving recovery sees a
failure and narrows, and a capped chunk can never enter a measurement as a
complete one. Had it truncated, every scan would have under-counted silently.

Use `VENUE_LOG_CHUNK_BLOCKS=10000` for the escrow. Larger values still terminate
correctly — the scanner halves on the timeout — but each timeout costs a full
request and its retry budget, so a "faster" chunk size is slower in practice.

---

## The sequence — run in this order

### 0. Confirm the escrow's credit events (5 minutes)

**The credit is TWO events, and a live topic census on
`0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` settled both.** They are the
defaults now; this step re-confirms them, and is mandatory against any other
escrow.

| event | topics | what it carries | the asset |
| --- | --- | --- | --- |
| `Credited(address indexed recipient, address indexed depositor, uint256 amount)` | 3 | **native** value, in `msg.value` | **none in the log** — it is the native asset, `address(0)` |
| `CreditedToken(address indexed recipient, address indexed token, address indexed depositor, uint256 amount)` | 4 | ERC-20 value | indexed param **1** |

```bash
node tools/escrow-index.ts --discover-topics --discover-blocks 200000 -v
```

Prints a `topic0` census of what the escrow actually emits, with topic counts
and data-word counts, and names any candidate signature it recognises.

**Read the native row twice.** Its second indexed parameter is the
**depositor**, not a currency. Decoding it as one produces per-asset buckets
headed by depositor addresses — a live run listed the V2 Meme Hook
`0xe5e7…e044` as if it were a currency — while per-recipient totals still summed
correctly, so the headline numbers looked right and only the breakdown was
nonsense. The decoder now decides asset-ness from the event **shape**: an event
with no token parameter credits the native asset, and a `--event` override whose
indexed count or types do not match its `--mode` is a hard error naming both
shapes, never a positional guess.

### 1. Index the escrow — the single highest-value query

```bash
node tools/escrow-index.ts --dry-run --days 30          # check the request budget first
node tools/escrow-index.ts \
  --days 30 --mode both \
  --out tools/artifacts/escrow-30d.json -v
```

`--mode both` is the default and the only mode whose totals are not a lower
bound: it scans both credit events over the same window (one `eth_getLogs`
filter with a topic0 OR-set, so merging costs no extra requests) and emits ONE
per-recipient daily series, with a per-asset breakdown in which native and
ERC-20 are distinguishable (`assetKinds`, `assetTotals[].kind`). `--mode native`
and `--mode token` scan one event alone, for debugging a single decoder; both
say in their warnings that they undercount.

Measured over 2026-09-06 UTC: 110,216 native credits worth 1,949.33 ETH
(~$6.24M at $3,200) across 9,095 recipients, plus 139,217 ERC-20 credits across
248 distinct assets and 12,020 recipients, no WETH among them. The merged
document holds all 249,433 credits and 20,865 recipients.

Per-recipient daily credit series in minor units and USD. **One scan settles
the true T1 population, the tenure distribution and the durable-cohort size.**

**What it changes:** if the count of recipients holding `TIERS.T1.gateQfPerDay`
($1,000/day as this is written) for `TIERS.T1.sustainedDays` consecutive days is
under ~20, the T1 tier has no market and the tier ladder needs redesigning
before anything is built. Pass the gate from `config/protocol.ts` rather than
typing a number: raising it thins the qualifying population, which is exactly
what this count is for.

⚠️ This counts **recipients, not coins.** Escrow credits key by
`(recipient, quoteAsset)` and carry no coin identifier, so one recipient serving
several coins appears once. Per-coin attribution needs step 3.

**Surviving a long scan.** The definitive 30-day run is ~25.7M blocks, ~5,100
`eth_getLogs` chunks and ~12,800 timestamp anchors — more than an hour of
requests. Three things make that survivable, all on by default:

- **Checkpointing.** Every completed chunk is written to
  `tools/.checkpoints/<scanId>/`; a run that dies at 90% resumes from 90%. The
  checkpoint is keyed by the exact scan parameters, so changing the window or
  the topic set starts over rather than merging two windows. `--no-checkpoint`,
  `--no-resume` and `--keep-checkpoint` control it.
  *A resumed scan is byte-identical to an uninterrupted one* — asserted in
  `__tests__/checkpoint-scan.spec.ts` and verified live by SIGKILLing a scan
  midway and comparing sha256 (`artifacts/live-resume-check.mjs`).
- **Batch JSON-RPC.** `--rpc-batch 10` (the measured optimum; 25+ gets 429ed)
  sends ten `eth_getLogs` per HTTP request, and the block-time anchor ladder is
  batched the same way — unbatched, the ladder costs 25x more requests than the
  logs it describes.
- **Adaptive backoff.** A 429 lowers the sustained rate rather than only
  retrying at the same speed, and a clean run climbs back towards the
  configured ceiling — never above it.

Progress goes to stderr unconditionally: blocks done, percentage, credits so
far, elapsed and an ETA. A scan that prints nothing for an hour is
indistinguishable from a hung one.

### 1b. Resolve the ERC-20 assets — and decide whether they matter

```bash
node tools/token-metadata.ts --days 1 --with-native \
  --out-assets tools/artifacts/assets.json -v      # census, resolve, rank
# fill in priceUsd for the head of the ranking in assets.json, then:
node tools/escrow-index.ts --days 30 --assets tools/artifacts/assets.json
```

The ERC-20 side was unmeasurable before this: a live run reported every symbol
as `UNKNOWN` and defaulted decimals to 18. The defaulting was visible in the
output — one asset with 4,450 recipients summed to `1.19e-6` while another with
186 recipients summed to `1.31e+4`. It was a 6-decimal stablecoin scaled by
`10**18`.

`token-metadata.ts` reads `decimals()`, `symbol()` and `name()` in batches of 10
`eth_call`s, caches them on disk forever, decodes both the ABI-string and the
bytes32 symbol conventions, and treats a field it cannot read as **UNKNOWN**,
never 18. An asset with unknown decimals is *unpriceable* and is reported as
excluded, not as zero. `--addresses-file` resolves a known asset set without
scanning.

**Measured 2026-09-07: all 263 assets from the live 2-day ERC-20 run resolved —
263/263 decimals, symbols and names, zero failures.**

The tail is not what it looked like. It is **tokenized equities and ETFs** —
NVDA, TSLA, SPY, QQQ, GLD, AAPL, MSFT, "… • Robinhood Token" — plus the USDG
stablecoin (6dp) and cbBTC (8dp), with a genuine memecoin tail underneath in
which symbols collide and impersonate (VLAD ×6, TRUMP ×5). **Prices are pinned
to addresses, never to symbols**, for exactly that reason.

Pricing 263 assets by hand is not realistic, so the tool ranks them — priced
assets by USD value, unpriced ones by recipient count, because those are the
only two orderings the data supports — and reports coverage on three bases:
assets, credits, and recipients *fully* priced. A recipient holding one priced
and one unpriced asset has an **understated** total, which can silently drop it
below a tier gate; that count is reported separately rather than folded in.

**Is the ERC-20 tail material? YES — and the answer is a bound, not an
estimate.** Over the complete UTC day 2026-09-06, USDG alone — one stablecoin,
priced at its $1.00 peg — is **$1,533,010**, which is **24.6% of the native
$6.24M** over the same window. That is a *lower bound*: 247 further assets are
still unpriced and can only add to it. **Native-only is therefore not a
defensible measurement basis**, and the QF definition has to say what it does
with ERC-20 credits.

### 2. Tenure — the survival analysis

```bash
node tools/tenure.ts --input tools/artifacts/escrow-30d.json --out tools/artifacts/tenure.json
node tools/tenure.ts --input tools/artifacts/escrow-30d.json --qf-definition median7   # the tier-grant reading
```

Cuts each series into **spells** (maximal runs above a gate), fits a
Kaplan-Meier survival curve — because a plain average over a 33-day window is
wrong in a known direction — and cross-checks with Little's Law.

Read three numbers: the `>=7d run` and `>=14d run` cohort sizes, the **KM
restricted mean** (feed it to step 6), and the Little's Law **ratio**. A ratio
far from 1.0 means the population is not in steady state and *no* tenure figure
here may be extrapolated.

**What it changes:** the acquisition rate, which is the whole business at short
tenure. At 2.14 days the book turns over every two days; at 56 days it doesn't.
Same revenue per client, 26x different sales problem.

⚠️ Venue V2 is ~33 days old. **Nothing beyond that horizon is measurable, by any
method, at any sample size.** A 60-day retention figure does not exist and will
not until December.

### 3. Pool fees — the 0.35% vs 0.70% question

```bash
node tools/pool-fees-index.ts --days 30 --out tools/artifacts/pool-fees-30d.json -v
```

Indexes `PoolFeesSwept`, classifies each pool buyback-on/off, and backs the
per-token `creatorTax` out of the fee residual. Reports the **distribution**,
unweighted *and* volume-weighted — a population that is 90% off and 10% on is a
completely different business from a uniform 50/50, and both have the same mean.

**What it changes:** the volume a coin needs to clear a gate, by a factor of
two, and therefore the addressable market by a factor of two. **Use the
volume-weighted figure** for anything downstream: if the six coins with the fees
behave differently from the 200 without them, the count-weighted rate is a lie.

Also watch the model-violation flag: it fires when a pool's sweeps cannot be
explained by `hookFeeBps=100 / protocolFeeShareBps=3000 / buybackBurnBps=5000`.
If it fires widely, the verified parameters do not describe V2 and step 4 is
now the most urgent thing in the repo.

### 4. Fee rate — verify the number everything divides by

```bash
node tools/fee-bps-probe.ts --days 7 --targets 0x<pool>,0x<curve> -v
```

Two independent readings: `eth_call` on the fee getters (**declared**), and
`CurveBuy.fee ÷ quote amount` across many trades (**empirical**). Returns an
explicit `AGREE` / `DISAGREE` / `INSUFFICIENT_DATA`.

**What it changes:** `config/protocol.ts` calls `hookFeeBps=100` "verified
on-chain". Phase 0 verified it for **V1** and inferred it for **V2**. If the two
readings disagree, every QF↔volume conversion in the repo is wrong by the ratio,
and the empirical reading is the one a creator actually earns.

### 5. Addressable market

```bash
VENUE_HTTP_RPS=0.5 node tools/addressable-market.ts \
  --buyback-on-rate <volume-weighted share from step 3> \
  --venue-share-sample 25 \
  --out tools/artifacts/market.json -v
```

Enumerates Venue pools past the ~200-per-dex page cap by unioning several sort
orders, counts coins above each gate for **both** buyback branches, and computes
each coin's Venue-pool share of total observed volume.

**What it changes:** whether a market exists at all at T1/T2, and by how much
headline volume overstates fee-bearing volume. Phase 0 saw a **122x** gap on
CASHCAT — that gap is the normal state of a winner, not an anomaly.

⚠️ Every count is a **lower bound**, and the report says which dexes hit the
page cap. Volume here is a rolling 24h snapshot, not the trailing 7-day median
the protocol gates on, so counts are an *upper* bound on coins that would
actually qualify. Both biases are stated in the output; do not quote a count
without them.

### 6. Reprice — the mechanical verdict

```bash
node tools/reprice.ts \
  --tenure-days <KM restricted mean from step 2> \
  --buyback-on-rate <from step 3> \
  --clients-above-gate <blended count from step 5> \
  --operator-bps 1000 \
  --fixed-cost-monthly-usd 12000
```

Break-even concurrent clients, required weekly signings (Little's Law run
forwards), and the **"if 20–40 durable clients do not clear break-even, stop"**
test as a pure function — `stopOrGoVerdict()`, unit-tested, so the answer cannot
be relitigated after the fact by whoever most wants to continue.

Also sweeps operator bps × tenure, so the pricing decision is a table rather
than an argument. It is what set `TERMS.operatorBps` to 500 and
`TIERS.T1.gateQfPerDay` to $1,000/day: at 1000bps the book needed 109
signings/week against 65 winnable, and at the old $250 gate a T1 client returned
$12.50/day against $13.00/day of COGS. Re-run it before moving either.

**What it changes:** whether to build the thing.

⚠️ `reprice.ts` measures nothing. Feed it defaults and it returns a confident,
meaningless verdict. The output labels every input `measured` / `assumption` /
`protocol` — check that column before believing the headline.

### 7. Cross-verify — the only EXTERNAL integrity control

```bash
node tools/cross-verify.ts \
  --secondary https://rpc.ordofi.network \
  --windows 40 --window-blocks 5000 --min-per-stratum 2 \
  --secondary-chunk 1000 --secondary-rps 0.8 \
  --out tools/artifacts/cross-verify.json -v
```

Every other control in this toolkit is **internal**: merged scan against native
scan, streamed totals against declared totals, sweep transactions against hook
transactions. All of them pass, identically and silently, if the single RPC node
is dropping logs — a short series is self-consistent. Only a second, independently
operated endpoint can settle it, and `escrow-index`'s own method limit has asked
for exactly this since the first run.

It does four things and reports the fifth:

1. **Chain identity.** `eth_chainId` on both, and `web3_clientVersion` probed
   `--version-probes` times *per endpoint* rather than once. A hostname is not a
   node: the primary measurably fronts a **load-balanced pool** — the same nitro
   build on `linux-amd64` and `linux-arm64` — and one probe reports a single draw
   from that pool as if it were "the endpoint's version". The pool cuts both
   ways, and the report says both halves: it weakens the *single-node* worry
   (a defect on one machine would affect only the share of traffic routed to it),
   and it does nothing at all for the *common-mode* worry (identical code on
   different silicon fails identically).
2. **A seeded, stratified sample** of block windows across the period — one
   stratum per UTC day, a guaranteed floor per day so the quietest is never
   skipped, and the remainder allocated by *measured* logs-per-block. Escrow
   logs from both endpoints, compared as `(blockNumber, logIndex, topic0, data)`
   plus the full topic array, emitting address and transaction hash.
3. **The window's first and last blocks, exhaustively** — every header field
   including `receiptsRoot` and `logsBloom`, which are cryptographic commitments
   to the complete log set of the block, *and* the boundary blocks' logs directly.
4. **The same sample for the Meme Hook's `PoolFeesSwept`**, since the per-coin
   attribution join depends on those logs and they were single-sourced too.
5. **The residual risk**, under each of the three shapes a log defect can take.

Plus one check that is **not** a two-node comparison, and is the only thing here
with any power against a defect the two nodes *share* (`--bloom-blocks`):

> **`logsBloom` verification.** Every log in a boundary block is refetched
> unfiltered and folded back into a bloom, which is compared to the `logsBloom`
> in the block header — a value committed inside the block hash, and so supplied
> by *consensus* rather than by the other node. A node serving a short log set
> cannot also produce a matching header.
>
> A bloom is a superset filter, so it **bounds** completeness rather than proving
> it, and its power depends entirely on the shape of the omission. Measured on
> chain 4663 (blocks 50419076 / 55532250 / 56389048, 85–188 logs each):
>
> | omission | caught |
> |---|---|
> | one random log | **22.9% – 34.1%** |
> | a contiguous run of five | 70.1% – 88.2% |
> | every log of one contract | every case tested |
>
> Quote the weak figure for a lone lost log and the strong ones for a
> systematically short index. Redundant bits — and so the miss rate — **rise**
> with the number of logs in the block.

Exit `0` agree, `3` incomplete, **`4` mismatch**, `2` bad flags.

**What it changes:** whether any single-endpoint number in `VERDICT.md` may be
called verified at all.

⚠️ A clean sample **bounds** the disagreement rate; it never proves identity. The
report prints three bounds because they are orders of magnitude apart —
per-log (tightest, least likely shape), per-block, and **clustered-by-range,
which is the weakest and the one to quote**. And if both endpoints run the same
client, a defect in that client is **common mode**: present on both sides,
perfectly agreed, and undetectable here at *any* sample size. The tool prints
both client versions and says so.

⚠️ Nothing in this tool is cached, deliberately. The `logscan` cache key is
`(address, topics, range)` and omits the endpoint, so a shared cache would answer
the secondary with the primary's own logs and every comparison would pass
unconditionally. `assertNoSharedCache()` enforces it.

---

## One-liner: the whole chain

```bash
node tools/escrow-index.ts --days 30 --mode both --out tools/artifacts/escrow-30d.json &&
node tools/tenure.ts --input tools/artifacts/escrow-30d.json --out tools/artifacts/tenure.json &&
node tools/pool-fees-index.ts --days 30 --out tools/artifacts/pool-fees-30d.json &&
node tools/fee-bps-probe.ts --days 7 --out tools/artifacts/fee-probe.json &&
node tools/addressable-market.ts --out tools/artifacts/market.json &&
node tools/reprice.ts --tenure-days 2.14 --buyback-on-rate 0.5 --clients-above-gate 200
```

`escrow-index → tenure` also works over a pipe: `... --json | node tools/tenure.ts`.

---

## Design notes

**Money.** Amounts are `bigint` minor units end to end. They cross files and
pipes as decimal **strings** (`lib/json.ts`), and `toMinor()` *rejects* a JSON
number rather than laundering a float that has already lost precision. Every USD
figure carries its price, source and pin time. A day containing an unpriced
asset is `null`, never a partial sum — a partial sum silently understates a gate
test.

**Fail closed.** A decode that does not match its signature throws instead of
returning shifted fields. A missing price is an error unless you pass
`--allow-missing-prices`, and even then no USD conclusion is printed (below). An
unknown CLI flag is a hard error, because a typo'd `--min-usd` that silently
does nothing is how a wrong number gets published with confidence. The fee-rate
verdict returns `INSUFFICIENT_DATA` rather than a quiet `AGREE`.

**A missing input is never a zero.** This is the rule the toolkit was most
recently caught breaking. A live escrow run whose assets had no USD price
printed a tier table of `0 / 0 / 0`, and the same window once priced was
`140 / 83 / 14`. Everything below now holds:

* **One marker.** A USD figure that could not be derived renders as `UNPRICED`
  (`lib/format.ts`), never as `0` or `$0.00`. `usd()` takes `number | null |
  undefined` so no caller has to write `?? 0` to get a string. `"n/a"` is a
  different word for a different fact — *not applicable* (a Kaplan-Meier median
  the curve never reached, a mean over an empty set), never *unvalued*.
* **Counts are refused, not shrunk.** A gate population computed over a group
  containing any unpriced member is a lower bound, and a lower bound under a
  heading like `ever >= gate` gets quoted as a measurement. `countAtGate()`
  excludes unpriced recipients, returns `refused: true`, and the human table
  prints the marker. The priced-subset figures stay in the JSON.
* **A loud banner**, before any table, with the size of the failure: unpriced
  assets, affected recipients, share of raw credit events, and the sentence that
  the gate counts are not a measurement of the market.
* **`--allow-missing-prices` buys the artifact, not the answer.** The run
  completes and `--out` is written — the raw amounts are worth keeping, and
  repricing them later costs one re-run of `tenure.ts` rather than a re-scan —
  but the derived USD conclusions stay refused and the exit code stays non-zero.
* **Unknown days stay visible.** A sparkline draws them `?`, not blank; an
  escrow-wide daily total containing one is `null`, not a partial sum; `--min-usd`
  never filters out a recipient whose total is unknown.

**Exit codes.** `0` success. `1` unexpected error. `2` bad config, bad flags, or
a refusal to start (an unpriced population without `--allow-missing-prices`).
`3` — `EXIT_INCOMPLETE_MEASUREMENT` — the run completed and wrote its artifact
but could not compute the thing it exists to compute: an unpriced population in
`escrow-index`/`tenure`, no eligible pool in `pool-fees-index`, an empty
enumeration in `addressable-market`. Any tool setting `meta.measurementComplete:
false` exits `3` and prints why. Chain runs with `&&` and a `3` stops the chain,
which is the point.

**Warnings are load-bearing.** Every report carries `warnings` and
`methodLimits` in both JSON and human output. They exist so a number keeps its
caveats attached when someone copies it into a spreadsheet.

**Dependencies.** None beyond the repo's existing devDependencies. Keccak-256
and the ABI decoder are vendored (`lib/keccak.ts`, `lib/abi.ts`) and pinned by
known-answer vectors; they are ~250 lines and the alternative was a wallet
library for two functions. External services sit behind narrow interfaces
(`HttpClient`, `ChainReader`, `EscrowBackend`, `Cache`) each with an in-memory
fake, and **every test runs against recorded fixtures** — a red test always means
our decoding broke, never that someone else's service moved.

**Unverified ABIs are parameters, not constants.** The escrow credit event, the
`PoolFeesSwept` indexed markers, `TokenLaunched` and `CurveBuy` were all
inferred, not read from verified source. Each is a `--flag` with a documented
default, each report states which signature it used, and `--discover-topics`
exists to settle the important one cheaply.

**Four of those were settled on 2026-09-07**, by a topic0 census of what each
contract actually emits cross-checked against Sourcify-verified source (both the
hook and the factory are verified on chain 4663). The results are pinned in
`__tests__/fixtures/verified-event-signatures.json` and asserted by
`__tests__/event-signatures.spec.ts`:

| Signature | Verdict |
|---|---|
| `Credited` / `CreditedToken` on the escrow | **confirmed** |
| `PoolFeesSwept(bytes32 indexed, uint256, uint256, uint256, uint256)` | **confirmed** — the guess had the right shape, so it decoded correctly by luck |
| `PoolRegistered(bytes32 indexed poolId, address memecoin, address quoteToken, address creator)` | **found** — this, not `TokenLaunched`, is the poolId → coin binding |
| `TokenLaunched(address indexed token, bytes32 indexed poolId, address indexed creator)` | **REFUTED** — does not exist |
| `CurveBuy` | **REFUTED** — does not exist |

The refutation of `TokenLaunched` matters beyond the hash. The factory *does*
emit a `TokenLaunched`, but it is
`TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)`
and it **carries no poolId at all**, so no correction of the indexed markers
could ever have made it serve the pool → coin join. What it does carry is
`curve`, and the curve is the escrow depositor for every pre-graduation credit —
which turns out to be the join that matters. The per-coin reconciliation built
on it lands in `artifacts/coins-above-gates.json`; the scripts that produce it
are `artifacts/topic0-census.mjs`, `artifacts/scan-join-events.mjs`,
`artifacts/extract-depositors-from-cache.mjs` and `artifacts/attribute-coins.mjs`.
