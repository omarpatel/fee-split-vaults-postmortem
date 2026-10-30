# The 7-day escrow measurement

**Measured 2026-09-07 against the live chain. Window: the 7 complete UTC days
2026-08-31 → 2026-09-06.**

> ## ⚠ SUPERSEDED TWICE — read `VERDICT.md` first
>
> **This document is the 2026-09-07 7-day measurement. It has been superseded
> twice. The current decision document is `VERDICT.md` (2026-09-08), which
> returns STOP; the intermediate 2026-09-07 GO is summarised there.**
>
> | | This document (7 d) | 2026-09-07 GO | **`VERDICT.md` (2026-09-08, current)** |
> |---|---|---|---|
> | Window | 7 days | 7 days | **36 days — all of V2** |
> | ETH/USD | $3,200 pinned, unverified | $2,460.02, four venues | **36 per-day closes, $1,858.81–$2,515.72** |
> | Priced assets | 2 of 1,699 (56% of credits) | 54 of 1,699 (99.4%) | **54, per day, 36 days** |
> | Unit | recipients | coins | **coins, classified by who controls recipiency** |
> | T1 standing | 99 | 128 | **146 recipients / 125 coins / 73 WINNABLE** |
> | Mean tenure | 3.01 d | 3.01 d | **11.59 d** (RMST, τ = 32) |
> | Total credit value | ≥ $41.55M | ≥ $50.68M | **≥ $77.36M** |
> | Verdict | **STOP**, ratio 0.92 | **GO**, ratio 1.18 | **STOP, ratio 0.68** |
>
> **What the 2026-09-08 work added that neither earlier document had: 44% of the
> gate-clearing population is contract-routed to a single whitelisted partner
> launchpad's per-coin distributors, 95% of those contain no code path out, and
> zero coins have ever moved off one.** Population and tenure both moved
> *favourably* and neither rescued the verdict.
>
> §0 below corrects the ETH price only, and so lands on 80 and a *stronger*
> STOP. **That intermediate figure is also superseded**: it was computed
> native-only, before the ERC-20 head was priced. **Do not quote 99, 80, or any
> dollar figure from §1–§8 of this document.** Everything about *method* here
> still stands, and the measurement itself was never re-scanned — only re-priced
> and re-keyed.

The headline, with its uncertainty attached:

> Over the seven days the Venue V2 fee escrow credited **10,161.25 ETH**
> (**$32.52M** at the pinned and unverified $3,200/ETH) in native value, plus at
> least **$9.03M** of ERC-20 value — **≥ $41.55M in total**. But the population
> that clears the T1 gate under the protocol's *own* QF definition is **99
> recipients**, of whom **27** held the gate every one of the seven days. The
> business plan assumed ~200 above T1 and 174 above T2; the measurement finds
> **99** and **51**. Mean tenure above T1 is **2.01–3.02 days**, confirming the
> Phase 0 figure of 2.14 days and refuting the planned 8 weeks — which is not
> merely wrong but *unmeasurable*, since V2 is 33 days old.
>
> `reprice.ts` returns **STOP**, and it returns it by a margin of 8%.

---

## 0. PRICE CORRECTION — the $3,200 was wrong, and the verdict got stronger

**Added 2026-09-07, after the sections below were written.** Everything from §1
onward still reads at the pinned $3,200/ETH; this section supersedes it wherever
a dollar figure or a gate count appears. Nothing was re-scanned — the correction
is arithmetic over the same exact bigint wei, re-derived by
`tools/artifacts/reprice-eth.mjs`.

### The verified price

ETH/USD for the measurement window, from four independent venues, all retrieved
2026-09-07:

| Source | Endpoint | 2026-09-06 UTC close |
|---|---|---:|
| Kraken | `api.kraken.com/0/public/OHLC?pair=ETHUSD&interval=1440` | **$2,514.35** |
| Coinbase Exchange | `api.exchange.coinbase.com/products/ETH-USD/candles` | **$2,514.31** |
| Bitstamp | `bitstamp.net/api/v2/ohlc/ethusd/?step=86400` | **$2,514.52** |
| CoinGecko | `api.coingecko.com/api/v3/coins/ethereum` | **$2,514.01** |

The four agree within **$0.51 (0.02%)**, so there is no meaningful range to
report at the close. Across the seven days there is:

| Basis | Value |
|---|---:|
| Daily closes, 2026-08-31 … 2026-09-06 | **$2,390.83 – $2,514.31** |
| Intraday low → high over the window | **$2,355.20 – $2,546.54** |
| Mean of daily VWAP | $2,455.89 |
| Mean of daily close | $2,462.05 |
| **ETH-weighted price of the window** | **$2,460.02** |

The last row is the single number that reprices the window total exactly, and it
is the one to quote. **The pinned $3,200 was 30% high.** It is outside the
window's entire intraday range — not at its edge, outside it — so no reading of
the market supports it.

### What changes

| | At the pinned $3,200 | At the verified price | Change |
|---|---:|---:|---|
| Native value, 7 days | $32,515,992 | **$24,996,906** | **−$7.52M** |
| Total escrow credit value | ≥ $41.55M | **≥ $34.03M** | native + the unchanged $9.03M of USDG |
| **T1 standing (median7)** | **99** | **80** | **−19** |
| T2 standing (median7) | 51 | **40** | −11 |
| T3 standing (median7) | 6 | **5** | −1 |
| T1 held all 7 days | 27 | **23** | −4 |
| T1 ever ≥ gate | 2,119 | **1,704** | −415 |
| Tenure, KM restricted mean (T1) | 3.02 d | **2.90 d** | −0.12 d |

The USDG figure does not move: it is a 6-decimal stablecoin priced at its peg,
not in ETH.

Gate counts were recomputed two independent ways that agree exactly: by
rescaling from the artifact's wei (`reprice-eth.mjs`), and by running the
toolkit's own `tenure.ts` against the equivalent rescaled gates
(`--gates 1300.81,3252.03,26016.2`). Both return **80 / 40 / 5**.

Per-day pricing was used for the headline figures — each UTC day valued at that
day's own VWAP — because a credit banked on 2026-09-02 was worth 2026-09-02
dollars and the QF gate is a test on a daily figure. Valuing the whole window at
any single price in the verified range gives 79–82 for T1, so the conclusion does
not depend on that choice.

### The verdict

```
reprice.ts --tenure-days 2.90 --operator-bps 500 --clients-above-gate 80

! VERDICT: STOP
! 26.10 signings/week are needed but only 19.31/week are winnable at a 10.0%
! win rate.
```

**STOP survives, and the margin roughly triples: the feasibility ratio falls
from 0.92 to 0.74.** The earlier "8% from flipping" is now **26% from flipping**.

This cuts against the hope in §5. Native value alone would need **≈$3,725/ETH**
— 51% above the verified price — to put 108 recipients above T1 and flip the
verdict. **The STOP is no longer inside the ETH-price uncertainty band.** What
remains open is gap (a), the unpriced ERC-20 tail, and it now has more work to
do than it did at $3,200, not less.

### A native price oracle exists on this chain

The toolkit no longer has to depend on a hand-entered number. Chain 4663 carries
WETH/USDG pools at all four standard Uniswap-V3 fee tiers, plus a V2 pair:

| Pool | Fee | Depth | 30-min TWAP |
|---|---:|---|---:|
| `0x52e65b17…71ca` | 100 | **6,037.8 WETH + 16,851,401 USDG** | **$2,490.29** |
| `0x69bfaf19…8d9a` | 500 | 1,066.1 WETH + 3,564,608 USDG | $2,487.86 (spot) |
| `0xa9188730…0334` | 3000 | 94.0 WETH + 1,687,475 USDG | $2,489.43 (spot) |
| `0x8803c117…1c4d` | V2 | 237.0 WETH + 589,921 USDG | $2,489.43 (spot) |

All four agree within **$1.65 (0.07%)**, and the deepest pool's 30-minute TWAP
of **$2,490.29** sits within **$0.86** of what Coinbase, Kraken and Bitstamp were
printing at the same moment. That is a genuine, independent corroboration of the
off-chain figure from inside the system being measured.

It is wired in as an **optional** source (`tools/lib/onchain-price.ts`, off
unless `VENUE_ONCHAIN_PRICE_POOL` names a pool). Three caveats ride in the
provenance string and in every run's warnings, because it is a cross-check and
not an authority:

1. it prices **WETH, not native ETH**;
2. it prices in **USDG, not dollars**, so USD conversion inherits the peg
   assumption;
3. it is **one pool on one chain** — a venue price, not a market price.

It reads the **TWAP via `observe()`, never `slot0` spot**, and refuses rather
than degrading to spot if the pool's observation cardinality cannot serve the
window. When `VENUE_PRICE_USD_ETH` is set, the pinned value still wins and the
on-chain reading is reported beside it with the discrepancy — which is the use
that matters, since it is what would have caught this error the day it was made.

---

## 1. What was measured

| | |
|---|---|
| Chain | 4663, endpoint `https://rpc.mainnet.chain.robinhood.com` |
| Contract | Venue V2 fee escrow `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` |
| Window | 7 complete UTC days, **2026-08-31 … 2026-09-06** |
| Blocks | `50419076 … 56389048` (5,969,973 blocks) |
| Measured on | 2026-09-07 |
| ETH price | Scanned at **$3,200**, pinned via `VENUE_PRICE_USD_ETH`. **THAT INPUT WAS WRONG — see §0.** The verified window price is $2,460.02; every figure below that carries a dollar sign is 30% high unless §0 restates it. |
| V2 age | Deployed 2026-08-04 ⇒ 33 days old; the window is days 27–33 of its life |
| Merged scan | 1,312,335 credits, 117,951 recipients, 1,699 distinct assets |
| Native scan | 514,152 credits, 52,451 recipients, 1 asset |

Both credit events were scanned in one filter:

| Event | topic0 | Carries |
|---|---|---|
| `Credited(address,address,uint256)` | `0x4e45da44…12967d5` | **Native** value in `msg.value`; no token parameter |
| `CreditedToken(address,address,address,uint256)` | `0x5d104c62…3e1ffdf` | **ERC-20** value; 2nd indexed parameter is the asset |

An event with no token parameter credits `address(0)` — the sentinel
`contracts/src/lib/SafeTransferLib.sol` already declares.

**CORRECTION (2026-09-07): the earlier claim here that `CurveBuy` "does not
exist on this chain" was WRONG, and wrong in an instructive way.** The
*signature* searched for did not exist; the event does. A topic0 census found
`CurveBuy` at `0xec36bf57…` (1,175 logs across 79 curves in 1,000 blocks) and
`CurveSell` at `0x8113d738…` (851 logs, 122 emitters), both with a different
arity from the 4-parameter form that was tried. **Searching for a wrong
signature returns nothing, and nothing reads exactly like absence.** Neither
event is used by this measurement, so no figure here moves — but the reasoning
that produced the claim was unsound and the same reasoning refuted all six Venue
event definitions in `packages/indexer/src/abi.ts`. See
`tools/__tests__/fixtures/verified-event-signatures.json`.

### Integrity: two independent scans agree exactly

The merged scan and the native-only scan were run separately, through different
topic filters, finishing ~3 hours apart. Projecting the native side out of the
merged document reproduces the independent native scan **exactly**:

```
  native-only recipients: 52,451   projected: 52,451
  recipients in the native scan missing from the projection: 0
  recipients in the projection absent from the native scan  : 0
  per-(recipient,day) cells compared: 419,608
  wei mismatches: 0    usd mismatches (>1c): 0
VALIDATED: the native side projected from the merged document is IDENTICAL
           to the independent native-only scan.
```

Every wei is accounted for, including the excluded boundary bucket:

```
  native-only total wei, 7 analysed days : 10161247489129381028378
  + excluded boundary bucket(s)          :    13540760691102187 wei ($43.33)
  = native-only total, all buckets       : 10161261029890072130565
  merged native row wei                  : 10161261029890072130565
  EXACT MATCH: YES
```

---

## 2. Method, and why each choice was made

### Window alignment — the sliver problem

`escrow-index` derives the window start as `to − days×86400` and buckets by UTC
day, so a 7-day window always yields **eight** buckets: seven complete days plus
a sliver holding the boundary second.

Which end that sliver lands on is decided by how `--to` is pinned, and it is not
cosmetic. Pinned to `2026-09-07T00:00:00Z` the sliver lands at the **end** —
*inside* the trailing-7-day window, which is the protocol's own QF definition.
It would have depressed the single number the tier grant depends on.

Pinning to `2026-09-06T23:59:59Z` moves the sliver to the **front**, so the
trailing seven buckets are exactly the seven complete UTC days. That is what was
run. The measured sliver holds **2 credits worth $43.33** — confirming it is the
boundary artefact it was predicted to be. The analysis re-derives this rather
than trusting it: it trims a boundary bucket only when that bucket holds under 1%
of the mean daily credit count, and refuses outright if trimming does not leave
exactly seven days.

### Chunk size — measured, not assumed

Two limits exist on this endpoint and they fail differently. Both were probed
directly against the escrow over this window:

| Block span | Result |
|---|---|
| 10,000 | serves reliably, 1,500–4,000 logs |
| 12,000 | served 4/4 probes |
| 15,000 | served 3/4; one `log query timed out` |
| 20,000 | served 1/4; three `log query timed out` |
| 25,000 | timed out 10/10 |
| 50,000+ | `-32000 logs matched by query exceeds limit of 10000` |

On a busy address the **query timeout binds long before the result cap does**,
and it is load-dependent rather than a clean threshold. The documented claim that
there is "no block-range cap up to ~5M blocks" is **false for this escrow**.

The safety property that matters was verified separately: **the result cap
ERRORS, it does not silently truncate.** A 50,000-block query returns
`-32000 … exceeds limit of 10000` rather than a short result set, so `scanLogs`'s
halving recovery sees a failure and narrows. Had it truncated instead, every scan
in this toolkit would have under-counted silently.

### Timestamps

Day bucketing interpolates between anchors 10,000 blocks apart. Measured drift at
an interval midpoint: **0.0 s at 10,000 blocks, 0.5 s at 2,000, 1.0 s at
20,000**, with block time steady at 0.1009–0.1015 s. A credit can only be
misfiled across a day boundary if it lands within ~1 s of midnight — a few
credits a day out of ~100,000.

### Pricing, and what is deliberately left unpriced

- **Native** is priced at the pinned $3,200/ETH. Every native USD figure is
  `(exact bigint wei) × 3200 / 1e18`.
- **Decimals are READ from the chain, never assumed.** This is not a detail: the
  largest ERC-20 asset by recipients is **USDG, a 6-decimal stablecoin**. Under
  the assumed-18 default it rendered as `9.033e-6`; read correctly it is
  **9,033,382.77 units = $9.03M**. A factor of 10¹².
- **Only pegged stablecoins are priced**, and only when the on-chain resolver
  confirms symbol and decimals. USDG at $1.00 is an **assumption**, defensible
  only because it establishes a *lower bound*.
- The rest of the tail is **tokenized equities and ETFs** — NVDA, SPCX, SPY, DJT,
  GME, QQQ, GLD, RDDT, TSLA, AAPL, cbBTC — plus a memecoin tail. These are left
  **UNPRICED on purpose**: this repo has no verified quote feed for them, and
  inventing one would convert an honest refusal into a confident wrong total.
- Prices pin to **addresses, never symbols**. The live asset set contains
  `🅿️`×10, VLAD×6, TRUMP×5 — and, importantly, collisions among the *equities*
  too (AMC×3, GME×2, QQQ×2, COIN×2). An equity price feed joined on symbol would
  mis-price.

### Why the native-only figures are a LOWER BOUND, not an estimate

Every ERC-20 credit adds non-negative value, so for every recipient and day,
`true merged USD ≥ native USD`. Threshold counts are monotone in each day's
value: if a recipient is above a gate on the native series it is above it on the
true merged series; a pointwise-larger series has a pointwise-larger trailing
median; and a run of N consecutive days can only lengthen. So every native gate
count below is a **lower bound on the true population**. This is a bounding
argument, not an approximation.

---

## 3. Results

### 3.1 Escrow-wide daily credit totals (native, at $3,200/ETH)

| Date (UTC) | ETH (exact, from wei) | USD @ pinned rate | Recipients | Credits |
|---|---:|---:|---:|---:|
| 2026-08-31 | 1,157.4693 | $3,703,901.82 | 7,852 | 93,944 |
| 2026-09-01 | 1,358.9295 | $4,348,574.28 | 8,964 | 52,070 |
| 2026-09-02 | 1,101.9221 | $3,526,150.87 | 9,169 | 52,816 |
| 2026-09-03 | 1,348.8469 | $4,316,309.95 | 8,351 | 48,798 |
| 2026-09-04 | 1,029.4844 | $3,294,350.06 | 7,040 | 52,918 |
| 2026-09-05 | 2,215.2720 | $7,088,870.39 | 9,748 | 103,390 |
| 2026-09-06 | 1,949.3233 | $6,237,834.59 | 9,095 | 110,214 |
| **TOTAL** | **10,161.2475** | **$32,515,991.97** | 52,451 distinct | 514,152 |

Mean **1,451.61 ETH = $4,645,142/day**. Exact total: `10161247489129381028378` wei.

**The week is not uniform, and this matters.** The two days the earlier
two-day study sampled (Sep 5–6) are the two *busiest* of the seven — $7.09M and
$6.24M against a $3.29M trough on Sep 4. Any figure extrapolated from those two
days overstates the week by roughly 40%. The 2026-09-06 figure of $6.24M
reproduces the earlier independent measurement of ~$6.24M exactly, which is a
genuine corroboration of the pipeline — but not a licence to treat that day as
typical.

### 3.2 Population at each gate

Native-only, fully priced. **Every count is a lower bound** (§2).

| Gate | ever ≥ gate | trailing-7d-median ≥ gate | all 7 consecutive days |
|---|---:|---:|---:|
| T1 $1,000/day | 2,119 | **99** | **27** |
| T2 $2,500/day | 1,101 | **51** | **8** |
| T3 $20,000/day | 192 | **6** | **2** |

The middle column is the protocol's own QF definition and is the one that grants
a tier. The gap between 2,119 and 99 is the whole story: **twenty-one times as
many recipients touch $1,000/day at some point in a week as hold it as a
trailing-7-day median.** Quoting "ever ≥ gate" as the addressable population
overstates it by 21×.

#### How much of this rests on the $3,200 ETH input

USD totals scale linearly in the ETH price. Gate *counts* do not — they are
threshold counts over a distribution:

| ETH price | T1 ever | T1 median7 | T2 ever | T2 median7 | T3 ever | T3 median7 |
|---:|---:|---:|---:|---:|---:|---:|
| $1,600 | 1,268 | 56 | 650 | 24 | 86 | 2 |
| $2,355 *(window intraday low)* | 1,646 | 79 | 884 | 38 | 133 | 2 |
| **$2,460 — THE VERIFIED PRICE (§0)** | **1,705** | **80** | **906** | **40** | **143** | **5** |
| $2,514 *(window close)* | 1,746 | 82 | 920 | 41 | 145 | 5 |
| $2,547 *(window intraday high)* | 1,760 | 82 | 928 | 42 | 148 | 5 |
| $3,200 *(the pinned input — WRONG)* | 2,119 | 99 | 1,101 | 51 | 192 | 6 |
| $4,000 | 2,514 | 119 | 1,268 | 56 | 247 | 6 |
| $6,400 | 3,595 | 141 | 1,769 | 82 | 373 | 11 |

Halving ETH to $1,600 cuts the T1 QF population from 99 to 56 (−43%); doubling to
$6,400 raises it to 141 (+42%). **The population figure is materially sensitive
to the price input — and the input this measurement used was 30% too high.**

The whole verified range, intraday low to intraday high, spans **79 to 82** on
T1. That is the useful thing about the sensitivity: the answer is not merely
"lower than 99", it is *tightly* 80, because the ETH price is now known to 0.02%
at the close rather than assumed. **The remaining uncertainty in the population
is no longer the ETH price. It is the unpriced ERC-20 tail.**

### 3.3 The tenure signal

Of the recipients above a gate on **day 1 (2026-08-31)**, how many are still
above it on **day 7 (2026-09-06)**:

| Gate | above on day 1 | still above on day 7 | retention | held it ALL 7 days |
|---|---:|---:|---:|---:|
| $1,000/day | 403 | 38 | **9.4%** | 27 |
| $2,500/day | 226 | 20 | 8.8% | 8 |
| $20,000/day | 28 | 3 | 10.7% | 2 |

Among the 2,119 recipients ever above $1,000/day, days-above-gate is **mean
1.35 d, median 1 d, max 7 d** (censored by the window).

**Roughly nine in ten of the day-1 T1 cohort are gone by day 7.** This is a
one-week book turning over almost completely.

### 3.4 The distribution

Per-recipient **mean daily USD** over the seven days, native:

| Rank | Mean USD/day | Window total |
|---|---:|---:|
| 1 | $679,909.78 | $4,759,368.48 |
| 10 | $34,124.76 | $238,873.35 |
| 100 | $6,714.25 | $46,999.73 |
| 500 | $1,244.62 | $8,712.32 |
| 1,000 | $463.22 | $3,242.56 |
| 2,000 | $159.37 | $1,115.62 |
| 5,000 | $48.59 | $340.12 |
| **median** | **$3.73** | across 52,451 recipients |

The top 100 recipients hold **49.9%** of all native credit value in the window,
and rank 1 alone holds 14.6%. The median recipient earns $3.73/day — three orders
of magnitude below the T1 gate. **This is not a market of many similar
participants; it is a handful of large ones and a very long tail of dust.**

### 3.5 Unpriced share, and whether the ERC-20 tail is material

Over the merged window, with USDG priced and all other assets left unpriced:

| | |
|---|---:|
| Distinct assets | 1,699 (1 native + 1,698 ERC-20) |
| Assets unpriced | 1,697 of 1,699 |
| Credits unpriced | **577,051 of 1,312,335 (44.0%)** |
| Recipients holding ≥1 unpriced credit | **42,847 of 117,951 (36.3%)** |
| Native value | $32,516,035 |
| **Priced** ERC-20 value (USDG alone) | **$9,033,383** |
| Priced ERC-20 as a share of native | **27.8% — A LOWER BOUND** |

**The ERC-20 tail is MATERIAL, and this is a bound rather than an estimate.** One
stablecoin, at its peg, is already 27.8% of the entire native side. The other
1,697 assets can only add. Total escrow credit value over the seven days is
therefore **at least $41.55M**, and native-only is **not** a defensible
measurement basis.

The head of the unpriced remainder, ranked by recipients — the only ranking an
unpriced asset supports:

| Asset | Symbol | Decimals | Recipients | Credits |
|---|---|---:|---:|---:|
| `0x5fc536…d168` | USDG | 6 | 25,683 | 221,132 (**priced**, $9.03M) |
| `0xd0601c…9eec` | NVDA | 18 | 7,163 | 54,768 |
| `0x4a0e65…5eea` | SPCX | 18 | 5,114 | 55,989 |
| `0x117cc2…4c0c` | SPY | 18 | 3,139 | 38,238 |
| `0x1d11f0…4516` | DJT | 18 | 3,047 | 26,276 |
| `0x1b0e31…153e` | GME | 18 | 2,626 | 32,580 |
| `0xd5f387…de68` | QQQ | 18 | 1,918 | 24,966 |
| `0xc9a981…fc4e` | GLD | 18 | 1,790 | 35,308 |
| `0x05b37f…6f4c` | RDDT | 18 | 1,734 | 14,980 |
| `0x322f09…3b2d` | TSLA | 18 | 1,503 | 18,430 |
| `0xaf3d76…93f9` | AAPL | 18 | 1,320 | 16,548 |
| `0xcec185…0be4` | cbBTC | 8 | 1,134 | 15,667 |

These are **publicly quoted instruments**. The "long tail of unpriceable
memecoins" framing is wrong: the head of what remains unpriced is tokenized
equities and ETFs, and an operator with an equity feed could price it in an
afternoon. That is the single highest-value next step.

#### How much can be hiding in the unresolved remainder: 0.5%

On-chain metadata (decimals/symbol) was resolved for 248 of the 1,698 ERC-20
assets. That sounds like thin coverage and is not:

| | Assets | ERC-20 credits |
|---|---:|---:|
| decimals READ on chain | 248 | 794,168 (**99.5%**) |
| decimals unresolved | 1,450 | 4,015 (0.5%) |

The largest single unresolved asset has **98 credits across 2 recipients**; none
has more than 2,000. So no material asset — and in particular no second
stablecoin large enough to move the lower bound — can be hiding in the
unresolved remainder. Those 1,450 assets stay `decimals: unknown` and therefore
unpriceable, which is the correct outcome rather than a gap: an asset whose
decimals were never read must never be assumed to have 18.

(Resolution of the remaining 1,450 was attempted and abandoned: the endpoint
throttled `eth_call` batches to a standstill — no successful resolution in 46
minutes. Given the 0.5% share, it changes nothing.)

---

## 4. Against the business plan

| Assumption | Plan | Measured | Verdict |
|---|---|---|---|
| Coins above T1 gate | ~200 | **99** recipients by the QF definition (27 durable) | **≈ half**, and the units differ (below) |
| Coins above T2 gate | 174 | **51** by the QF definition (8 durable) | **≈ 3.4× short** |
| Mean tenure | 8 weeks (56 d) | **2.01 d** (daily) / **3.02 d** (median7) | Plan refuted; Phase 0's 2.14 d confirmed |

Three qualifications, all of which cut in different directions:

1. **Recipients are not coins.** `escrow-index` says so itself: credits key by
   (recipient, asset) and carry no coin identifier, so one recipient serving
   several coins appears once. The measured 99 and the planned 200 are not the
   same unit, and per-coin attribution needs the `PoolFeesSwept → TokenLaunched`
   join, which this measurement does not perform.
2. **99 and 51 are LOWER BOUNDS.** Pricing the ERC-20 tail can only raise them,
   and 36.3% of recipients hold at least one unpriced credit. The true figures
   are higher by an unknown margin — plausibly enough to close part of the gap to
   200, and this is the main reason the STOP verdict below is not robust.
3. **They rest on $3,200/ETH.** At $2,400 the T1 figure is 80; at $4,000 it is
   119 (§3.2).

**On tenure the plan is not merely wrong, it is unmeasurable.** V2 is 33 days
old. An 8-week tenure could not be observed by anyone yet, at any window length,
and the measured 2–3 days is a different order of magnitude — the book turns over
roughly twenty times inside the period the plan assumed for a single client.
`tenure.ts` prints this ceiling as a banner before any number.

---

## 5. What the tools returned

Reported as returned, not as hoped.

### `tenure.ts --qf-definition median7` (the protocol's own QF definition)

```
! VENUE V2 IS ~33 DAYS OLD.  NOTHING BEYOND 8 DAYS OF TENURE IS MEASURABLE.

  gate         $/day  ever above  >=7d run  >=14d run  tier grant  standing at end  mean QF standing
  T1 Desk       1000         327        48          0      48 (7d)               99            $10.9k
  T2 Campaign   2500         173        20          0       0 (14d)               51            $19.7k
  T3 Flagship  20000          14         2          0       0 (14d)                6           $127.2k

  gate         spells  censored  KM median  KM restricted mean  naive mean  p90  max
  T1 Desk         339  99 (29%)        1.0                3.02        2.53  7.0    7
  T2 Campaign     182  51 (28%)        1.0                2.85        2.35  7.0    7
  T3 Flagship      15   6 (40%)        3.0                3.44        2.47  6.2    7

  Little's Law   L standing  lambda/day  W implied  W from curve  ratio  mean age
  T1 Desk            107.38      42.375       2.53          3.02   0.84      4.90
  T2 Campaign         53.38      22.750       2.35          2.85   0.82      4.61
  T3 Flagship          4.63       1.875       2.47          3.44   0.72      3.00

  Survival, T1: S(1)=49.3%  S(2)=40.7%  S(3)=31.2%  S(5)=25.4%  S(7)=25.4%
```

Under the daily definition the KM restricted mean is **2.01 d** (T1), which
corroborates the Phase 0 figure of 2.14 d closely.

**T2 and T3 show `0 (14d)` tier grants because they require 14 sustained days and
the window is 8.** That is a measurability limit, not a market finding, and it
must not be read as "nobody qualifies for T2".

Little's Law ratios of 0.72–0.84 say the two independent tenure estimates roughly
agree but the population is **not in steady state** — so a steady-state break-even
figure describes it only approximately.

### `reprice.ts --tenure-days 3.02 --operator-bps 500 --clients-above-gate 99`

```
! VERDICT: STOP
! 25.06 signings/week are needed but only 22.95/week are winnable at a 10.0%
! win rate. The market does not produce enough qualifying coins to hold the book.

  PASS  client contribution is positive          $37.00/day after $13.00/day COGS
  PASS  lifetime value per client is positive    $111.74 over a 3.02-day life
  PASS  break-even inside the 20-40 band         10.8 concurrent clients
  PASS  client clears the qualification floor    $6000/month vs $1500 floor
  FAIL  required acquisition rate is available   25.06 needed vs 22.95 winnable

  feasibility ratio: 0.92  (NOT ACHIEVABLE)
```

**The verdict is STOP, and it is 8% from flipping.** Its sensitivity to the one
input the measurement bounds rather than fixes:

| `--clients-above-gate` | What that number is | Verdict | Winnable/wk |
|---|---|---|---|
| 48 | durable cohort (≥7-day run, median7) | **STOP** | 11.13 |
| **99** | **standing population, QF definition** | **STOP** | **22.95** |
| 192 | T3 "ever ≥ gate" — *not a standing population* | GO | 44.50 |
| 2,119 | T1 "ever ≥ gate" — *not a standing population* | GO | 491.16 |

The defensible input is 99, and it returns STOP. But 99 is a **lower bound**: it
counts only native value, and 36.3% of recipients hold unpriced ERC-20 credits.
A true population of 108 or more flips this to GO. **The honest statement is that
the STOP/GO decision currently sits inside the measurement's uncertainty band,
and pricing the ERC-20 head — roughly thirty publicly quoted equities — is what
would resolve it.** Choosing the "ever ≥ gate" number instead would manufacture a
GO out of a definition change; that is number-shopping, not evidence.

---

## 6. What this measurement CANNOT say

1. **A 7-day window cannot measure a 30-day tenure, let alone an 8-week one.**
   Every spell still running on the last day is right-censored at 7 days (29% of
   T1 spells are). V2 is 33 days old, so no tenure beyond ~33 days is measurable
   by anyone yet.
2. ~~**The ETH price is an input, not a measurement.**~~ **RESOLVED — see §0.**
   The price is now measured: four independent venues agree to 0.02% at the
   window close, and an on-chain WETH/USDG TWAP on chain 4663 corroborates them
   to within $0.86. The pinned $3,200 was 30% high, the native total falls to
   $25.00M, and T1 standing falls from 99 to 80. Every dollar figure elsewhere in
   this document still rests on $3,200 and should be read through §0.
3. **The ERC-20 tail is 44.0% of credits and remains unpriced.** Every merged USD
   conclusion is refused by the toolkit rather than estimated, and every native
   figure is a lower bound.
4. **USDG at $1.00 is a peg assumption**, not a market quote. It is used only to
   establish a lower bound, where a small depeg cannot change the conclusion.
5. **These are RECIPIENTS, not coins.** Any comparison with a coin-denominated
   plan figure is apples-to-oranges (§4).
6. **One endpoint — since cross-checked against a second, and it AGREES.**
   `escrow-index`'s method limits ask for the window's first and last block to be
   cross-checked against a second endpoint before publishing. At the time of this
   measurement that **was not done**; it has since been done by
   `tools/cross-verify.ts` against `rpc.ordofi.network`. The window's first and
   last 25 blocks agree exhaustively on all 9 header fields, and two independent
   seeded samples — 80 distinct windows, 400,000 blocks, 6.70% of the period —
   found the escrow's 94,215 logs and the hook's 14,957 logs **byte-identical
   with zero mismatches**. See `VERDICT.md` §6 item 6 for the bound this supports
   (the one to quote: a range-shaped defect ≤3.68% of window-slots, i.e. a gap up
   to ~220,000 blocks could still hide) and for the two things it turned up — the
   primary is a load-balanced pool rather than one node, and a `logsBloom` check
   that verified 40/40 block-endpoint pairs against consensus. The internal
   cross-check quoted here (two independent scans agreeing on 419,608 cells)
   remains unable, on its own, to detect a defect shared by both scans; the
   residual after the external check is a defect in the **nitro client itself**,
   which both endpoints run.
7. **Day bucketing is interpolated**, accurate to ~1 s at a UTC-day boundary.
8. **Nothing here measures COGS, win rate, or fixed cost.** `reprice.ts` consumes
   those as explicit assumptions and labels them; its verdict is exactly as good
   as they are. In particular the 10% win rate and the $12k/month fixed cost are
   assumptions, and break-even scales linearly in the latter.
9. **The buyback-on rate was not measured** (defaulted to 0), so the blended
   creator rate of 70 bps is the no-buyback case.

---

## 7. A defect this measurement found and fixed

The 808 MB checkpoint written by the merged scan exposed a bug in
`tools/lib/checkpoint.ts`. `loadLogs()` read the whole NDJSON file into one
string; Node's `MAX_STRING_LENGTH` is 536,870,888, so the read threw — and a bare
`catch { return [] }` turned that into "no logs".

The consequence was the worst available: `scanLogs` saw a checkpoint whose every
chunk was complete, queued no work, took the empty array as the result, and
`escrow-index` reported **zero credits as a success** — a tidy table of zeros
that reads as "there is no market", produced from a complete and perfectly good
checkpoint. That is exactly the unknown-becomes-zero failure the rest of the
toolkit refuses, reintroduced in the resume path, and it only appears at the
scale where checkpointing is the reason you turned it on.

`loadLogs()` now streams line by line, bounds the read by the byte length the
state file accepted, reconciles the deserialized log count against the state, and
lets a genuine read failure throw. Four regression tests pin it; one was verified
to fail without the fix.

---

## 8. How to reproduce

```bash
cd fee-split-vaults

export VENUE_RPC_URL=https://rpc.mainnet.chain.robinhood.com
export VENUE_BLOCK_TIME_SECONDS=0.101     # measured; the 0.25 default is wrong by 2.5x
export VENUE_HTTP_RPS=0.8                 # sub-requests/sec, not HTTP requests
export VENUE_PRICE_USD_ETH=3200           # AN INPUT. Every USD figure scales in it.
export VENUE_LOG_CHUNK_BLOCKS=10000       # larger chunks time out server-side

# (a) merged: both credit events in one filter. Exits 3 - the ERC-20 tail is not
#     fully priced, so its USD conclusions are REFUSED by design. ~3 hours.
node --max-old-space-size=12288 tools/escrow-index.ts \
  --days 7 --to 2026-09-06T23:59:59Z --mode both \
  --anchor-spacing 10000 --rpc-batch 10 --allow-missing-prices \
  --keep-checkpoint --top 30 --out tools/artifacts/live-7d-both.json

# (b) native only: fully priced, so its gate counts are real counts - and they
#     are lower bounds on the merged population (see §2). ~2.5 hours.
node --max-old-space-size=8192 tools/escrow-index.ts \
  --days 7 --to 2026-09-06T23:59:59Z --mode native \
  --anchor-spacing 10000 --rpc-batch 10 \
  --keep-checkpoint --top 30 --out tools/artifacts/live-7d-native.json

# (c) read decimals and symbols on chain for the ERC-20 asset set. The 248
#     assets already cached cover 99.5% of ERC-20 credits, so this can be
#     interrupted once the head is resolved - the tail stays unpriceable, which
#     is correct. Expect the endpoint to throttle eth_call batches hard.
node tools/token-metadata.ts \
  --addresses-file tools/artifacts/erc20-assets-7d.json \
  --batch 10 --out tools/artifacts/metadata-7d.json

# (d) attach real decimals, and a price ONLY to confirmed pegged stablecoins
node tools/artifacts/build-assets-file.mjs \
  tools/artifacts/live-7d-both.json tools/artifacts/metadata-all.json \
  tools/artifacts/assets-7d-priced.json

# (e) re-run the merge with those decimals/prices. Costs NO network: the
#     eth_getLogs results are already cached. This is the run that shows USDG.
node --max-old-space-size=16384 tools/escrow-index.ts \
  --days 7 --to 2026-09-06T23:59:59Z --mode both \
  --anchor-spacing 10000 --rpc-batch 10 \
  --assets tools/artifacts/assets-7d-priced.json --allow-missing-prices \
  --keep-checkpoint --top 12 --out tools/artifacts/live-7d-both-priced.json

# (f) prove the native side of the merged scan equals the independent native scan
node --max-old-space-size=16384 tools/artifacts/native-from-merged.mjs \
  tools/artifacts/live-7d-both.json tools/artifacts/live-7d-native.json

# (g) the derived figures the CLIs do not print (daily table, gates, ETH
#     sensitivity, day1->day7 retention, rank distribution, coverage)
node --max-old-space-size=16384 tools/artifacts/analyze-7d.mjs \
  tools/artifacts/live-7d-native.json tools/artifacts/live-7d-both-priced.json 7

# (h) survival analysis against the protocol's own QF definition
node --max-old-space-size=16384 tools/tenure.ts \
  --input tools/artifacts/live-7d-native.json --qf-definition median7 \
  --out tools/artifacts/tenure-7d-median7.json

# (i) the stop/go arithmetic, fed the measured tenure and standing population
node tools/reprice.ts --tenure-days 3.02 --operator-bps 500 --clients-above-gate 99

# (j) THE PRICE CORRECTION (§0). Re-counts the gates at the verified ETH price
#     straight from the artifact's exact wei. No network, no re-scan; the
#     $3,200 the document was scanned with never enters the arithmetic.
node --max-old-space-size=10240 tools/artifacts/reprice-eth.mjs \
  tools/artifacts/live-7d-native.json 7

# (k) the same counts through the toolkit's OWN tenure tool, as a cross-check.
#     Gates are rescaled by 3200/2460.02, which is exact for a native-only
#     document: 1000 -> 1300.81, 2500 -> 3252.03, 20000 -> 26016.2.
node --max-old-space-size=10240 tools/tenure.ts \
  --input tools/artifacts/live-7d-native.json --qf-definition median7 \
  --gates 1300.81,3252.03,26016.2 --tiers T1

# (l) the corrected verdict
node tools/reprice.ts --tenure-days 2.90 --operator-bps 500 --clients-above-gate 80

# (m) is there an on-chain price oracle on this chain? (reconnaissance)
node tools/artifacts/probe-usdg-pool.mjs      # are there DEX pools at all
node tools/artifacts/probe-usdg-pool2.mjs     # ask the factories for WETH/USDG
```

Scans are checkpointed under `tools/.checkpoints/`; a killed run resumes from its
last completed chunk, and a changed window starts over rather than merging two
measurements. `eth_getLogs` results are cached under `tools/.cache/`, so step (e)
costs no network at all.

**Operational note.** The endpoint throttles hard over a multi-hour scan: the
adaptive limiter was observed oscillating between 0.18 and 0.62 req/s and
settling near 0.2 during contention. After a long throttled scan it stays low, so
the post-scan anchor ladder (597 sub-requests, comparable to the log scan itself)
crawls. Restarting the run gives a fresh limiter and resumes from the checkpoint
in seconds — that is a legitimate and much faster recovery than waiting. Run with
`--verbose`, or a silent hour is indistinguishable from a hang.

### Artifacts

| File | Size | What |
|---|---:|---|
| `live-7d-native.json` | 97 MB | native-only, fully priced — the gate/tenure source |
| `live-7d-both.json` | 218 MB | merged, ETH priced only |
| `live-7d-both-priced.json` | 218 MB | merged, with read decimals and USDG priced |
| `tenure-7d-median7.json`, `tenure-7d-daily.json` | | survival analyses |
| `reprice-7d.json` | | the STOP verdict |
| `erc20-assets-7d.json`, `metadata-all.json`, `assets-7d-priced.json` | | asset set, resolved metadata, pricing input |

These are large derived data, not source. `tools/.gitignore` excludes
`artifacts/*` (the ~760 MB of JSON) and re-includes `!artifacts/*.mjs` and
`!artifacts/*.md`, so the analysis scripts and the write-ups stay checked in —
they are the method and the conclusion, not the data. **The `*.md` re-inclusion
was added 2026-09-07; before it, this paragraph's own claim that
`MEASUREMENT.md` "stays checked in" was false, under both this rule and the
`artifacts/` rule it replaced.** `ops/ci/no-hardcoded-rates.ts` also skips `tools/artifacts` explicitly:
`reprice-7d.json` was tripping the qualification-floor rule by quoting the floor
correctly in the tool's own output, which made the gate's verdict depend on what
the person running it happened to have measured.
