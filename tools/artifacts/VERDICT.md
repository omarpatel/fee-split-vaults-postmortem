# VERDICT

**Dated 2026-09-08. Chain 4663.
Population and capture read LIVE at 2026-09-08T08:32Z, head block 57,549,796.
Tenure and standing stock from the full V2 history: 36 UTC days, 2026-08-03 → 2026-09-07,
blocks 26,314,511 → 57,245,348.
Endpoints `https://rpc.mainnet.chain.robinhood.com` (primary) and `https://rpc.ordofi.network`
(verification).**

**This supersedes the 2026-09-07 verdict (GO at 1.18), which is not included
in this repository.**

---

## 0. THE VERDICT CHANGED. IT IS NOW STOP.

The 2026-09-07 document returned **GO at a feasibility ratio of 1.18**. That is
withdrawn.

```
node tools/reprice.ts --tenure-days 11.59 --operator-bps 500 --clients-above-gate 73

!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
! VERDICT: STOP                                                                !
! 6.53 signings/week are needed but only 4.41/week are winnable at a 10.0% win !
! rate. The market does not produce enough qualifying coins to hold the book.  !
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

  PASS  client contribution is positive                    $37.00/day after $13.00/day COGS
  PASS  lifetime value per client is positive              $428.83 over a 11.59-day life
  PASS  break-even inside the 20-40 durable client band    10.8 concurrent clients
  PASS  client clears the qualification floor              $6,000/mo vs the $1,500 floor
  FAIL  required acquisition rate is physically available  6.53/wk needed vs 4.41/wk winnable
```

**Feasibility ratio 0.68. The flip point is 109; we measure 73 genuinely winnable.
That is a 36-coin shortfall against a margin the previous verdict claimed was 19.**

**What is remarkable is how it flipped.** Two of the three corrections landed in
the *favourable* direction and neither rescued it:

- the standing population went **up**, 128 → **146** (+14%), once the window was
  extended from 7 days to V2's entire 36-day life;
- mean tenure went **up**, 3.01 d → **11.59 d** (+285%), once the truncation bias
  of a 7-day window was removed. LTV nearly quadrupled, $111.37 → **$428.83**.

**Neither moved the STOP/GO, because neither was ever the binding constraint.**
Tenure cancels exactly out of the feasibility ratio — confirmed again here at
3.01 d, 8.59 d, 11.59 d and 32 d, all giving **0.6753**. What flipped the verdict
is a fact about the market that no amount of window length would have revealed,
because it is not in the credit stream at all: **44% of the gate-clearing
population no longer controls its own creator-fee recipiency.** Those coins point
at per-coin distributor contracts operated by a single sanctioned partner
launchpad, and **95% of them contain no code path out**. They are not slow to
win. They cannot be won.

**The verdict is STOP on the same question the GO was issued on — market supply.
It is not a verdict on the other four gates, which remain open and unaddressed.**

---

## 1. The verdict, on every defensible population

Every row below was **run**, not derived. Tenure is held at the corrected
11.59 d; the ratio is invariant in it.

| `--clients-above-gate` | basis | verdict | ratio | winnable/wk vs 6.53 needed |
|---|---|---|---:|---|
| 146 | 36-day standing recipients, **no capture correction** — *the number the previous method would have produced* | GO | **1.35** | 8.82 |
| 125 | true creator-leg T1 coins, 7-day window to 2026-09-06, no capture correction | GO | 1.16 | 7.55 |
| **109 / 108** | **the flip point, re-run** | **GO / STOP** | **1.01 / 1.00** | — |
| **85** | 146 standing × the measured 58.4% winnable share | **STOP** | **0.79** | 5.13 |
| **81** | 146 scaled to coins (×125/131), × 58.4% | **STOP** | **0.77** | 5.01 |
| **73** | **directly measured winnable, no chaining — THE HEADLINE** | **STOP** | **0.68** | 4.41 |
| 70 | EOA-only, the conservative floor | STOP | 0.65 | 4.23 |

**73 is the headline because it is the only figure in the table that chains
nothing.** It is 125 T1 coins classified one at a time by a live `eth_getCode`
against each coin's live `hook.launches(poolId).creatorFeeRecipient`, with no
ratio carried from one window to another. 81 and 85 apply the measured winnable
*share* to the larger, later, better-measured population; they are the generous
readings, and they are STOP too.

**The whole plausible range is 70–85 against a flip point of 109. There is no
defensible population in this data that returns GO.**

### What it would take to get back to GO

- **The winnable share would have to be 74.7%, not the measured 58.4%** — i.e.
  capture would have to be less than half what it is.
- **Or the standing population would have to reach ~187 coins** (≈196 recipients)
  at today's capture rate. **This is not far away, and that matters.** Standing
  T1 recipients went 60 → 146 in the last eight days of the window, +18 on the
  final day alone. At the final-day rate that threshold is ~3 days out; at the
  eight-day average, ~5 days.

  **Do not read that as a GO deferred by a week.** That growth curve was measured
  entirely inside the gas subsidy that expires 2026-09-29, it is the single
  behaviour most likely to be a subsidy artefact, and Little's Law says the book
  is nowhere near steady state (consistency ratio **0.428**; `reprice.ts`'s own
  method limits say that is when its figures "describe a market that does not
  exist"). **The honest statement is that market supply is insufficient today and
  the question of whether it stays insufficient is decided on 29 September, not
  by any further analysis of this dataset.**

---

## 2. What changed since the 2026-09-07 verdict, and why

| | 2026-09-07 | 2026-09-08 | Why it moved |
|---|---|---|---|
| **Verdict** | **GO, ratio 1.18** | **STOP, ratio 0.68** | capture, below |
| Window | 7 days (08-31 → 09-06) | **36 days, all of V2 (08-03 → 09-07)** | V2 genesis measured, not assumed |
| Standing T1 | 128 coins | **146 recipients / 73 winnable** | +1 day of a growing book, then −42% for capture |
| Mean tenure | 3.01 d (RMST, τ=7) | **11.59 d (RMST, τ=32)** | the 7-day figure was truncation bias: 3.85× too low |
| LTV per client | $111.37 | **$428.83** | follows tenure; the only place the tenure correction lands |
| Pricing | one as-of close (09-06) | **each day at its own close**, 36 ETH closes + per-token daily OHLCV | see below |
| Total credited value | ≥ $50.68M (7 d) | **≥ $77.36M (36 d)** | longer window, per-day prices |
| Cross-endpoint check | AGREE, one 40-window sample | **AGREE, two independent 40-window samples + logsBloom** | §6 |
| The aggregator `0xfdde5a1e…` | "**unidentified — the largest single risk in the file**" | **identified structurally** as the operator of a whitelisted partner launchpad running per-coin merkle distributors | §4 |
| T1 base count | 128 | **125** on the true creator leg | 128 included protocol-leg contamination |
| V2 genesis | assumed 2026-08-04T00:00:00Z | **measured 2026-08-03T14:41:19Z**, block 26,841,846 | 9h18m41s earlier than the toolkit default |

**The single decisive change is the aggregator row.** The 2026-09-07 verdict named
`0xfdde5a1e…cc36` as its largest unpriced risk, said it was worth more than
everything else in the document, and said: *identify that address before acting on
the GO.* That instruction was followed. The address is now identified, the
mechanism it operates is read off the chain, and **the answer flips the verdict.**

It flips it in a different way than that section anticipated. §4 of the old
document modelled the risk as *"if those 32 coins are one negotiation rather than
32, the signable population is ~96 and the ratio is 0.90."* The reality is worse
in kind, not only in degree: the coins are not one hard negotiation, they are
**not a negotiation at all**, because the contract holding the recipiency has no
function that can give it up.

### On per-day pricing, quantified rather than asserted

ETH daily closes over the 36 days ranged **$1,858.81 (08-03) to $2,515.72
(08-21)**. Pricing the whole window at the single 2026-09-06 close overstates the
window low by **35.3%**. Its effect on the *total* is small — **+1.65%**
($78,643,519 as-of vs $77,364,862 per-day) because the final week carries most of
the value — but it is **+28.8% over the first 14 days and +31.8% on the worst
single day**, and it moves T1 standing 146 → 148 and the KM restricted mean
11.59 → 11.80 d. **Per-day pricing was done, not assumed away**, and both bases
are carried in `full-history.json`.

---

## 3. Every input, labelled

| Input | Value | Label | Provenance |
|---|---|---|---|
| **Winnable T1 population** | **73 coins** | **MEASURED** (live, both endpoints) | 125 T1 coins × live `eth_getCode` classification; independently recomputed in this session — see §9 |
| Standing T1 population, no capture correction | 146 recipients (fully-priced subset) / **150** priced-only floor / **149** addressable | **MEASURED**, lower bound | `full-history.mjs` + `tenure.ts` on the merged 36-day series, 2,877,162 credits |
| Winnable **share** | **58.4%** (73/125) | **MEASURED** | live, 2026-09-08 |
| Mean tenure above T1 | **11.59 d** KM restricted mean, τ = 32 d | **MEASURED**, **still a lower bound** | 250 spells, 104 completed, 146 right-censored (58.4%). S(32) = 0.1413 unresolved |
| V2 genesis | block 26,841,846, **2026-08-03T14:41:19Z** | **MEASURED** | 208-call `eth_getLogs` bisect; factory and vault txs are contract creations with matching `contractAddress` |
| ETH/USD, per day | 36 daily closes, **$1,858.81 (08-03) → $2,515.72 (08-21)** | **MEASURED** | median of Kraken / Coinbase / Bitstamp daily closes; re-verified live to within $0.48 |
| ERC-20 prices | each token's own daily close on chain 4663, 54 assets | **MEASURED** | GeckoTerminal per address; 257 day-closes recovered by enumerating all of a token's pools |
| Total credited value, 36 d | **≥ $77,364,862** | **MEASURED**, lower bound | 1,986 of 2,040 assets unpriced; nothing zero-filled, nothing carried |
| Fee split | hook 100 bps; protocol share 3000 bps → **30 bps protocol / 70 bps creator** | **MEASURED** (live getters, uniform across all 125) | `hook.hookFeeBps()` = 100, `hook.protocolFeeShareBps()` = 3000 |
| Buyback-on rate | 1.9% by volume; blended creator rate **69.35 bps** vs 70.00 used | **MEASURED** | `pool-fees-index.ts`; the 0.65 bps gap cannot move a conclusion |
| Reassignment timelock | **3.00 days** + a 3.00-day execution window | **MEASURED** (live, both endpoints) | `factory.CREATOR_FEE_RECIPIENT_TIMELOCK()` = 259,200 s |
| Distributor upgrade timelock | **2.00 days**, operator holds PROPOSER + EXECUTOR + CANCELLER | **MEASURED** (live) | `getMinDelay()` = 172,800 s; three `hasRole` probes all true |
| Cross-endpoint agreement | **AGREE**, 0 mismatches on 80 windows / 400,000 blocks | **MEASURED** | §6 |
| Residual index-defect risk, 7-day window | **≤ 3.68% of window-slots** | **BOUNDED**, not measured | rule of three at k = 0, n = 80 |
| Residual, the 36-day scan | **≤ 22.1% of comparable slices** | **BOUNDED, and weakly** | only 12 boundary slices (24,000 blocks, 0.078%) were cross-checked over 36 days |
| Operator take | 500 bps | **PROTOCOL** | `config/protocol.ts`; inside the CREATE2 salt preimage |
| T1 gate | $1,000/day QF, 7 sustained days | **PROTOCOL** | `config/protocol.ts` |
| QF per client per day | $1,000 | **ASSUMED**, conservative | assumes every client sits exactly at the gate; measured mean QF of the standing stock is **$5,113.73/day** |
| **Win rate** | **10%** | **ASSUMED — ZERO OBSERVATIONS** | no client has ever been signed |
| **Fixed cost** | **$12,000/month** | **ASSUMED — ZERO OBSERVATIONS** | break-even scales linearly in it |
| **COGS** | **$13.00/day** | **ASSUMED** — a model | `TIERS.T1.cogsPerDay`; $10 of it is the FTE ratio the unrun pilot exists to test |
| Acquisition latency | **3.00 days, measured** — but **not in the ratio** | **MEASURED input, UNMODELLED** | `reprice.ts` has no flag for it; §5 |
| The 1,986-asset unpriced tail | **UNPRICED** | **EXPLICIT UNKNOWN** | counted (2,439 asset-day pairs), reported, never zeroed |
| Coin basis over 36 days | **NOT DERIVED** | **EXPLICIT UNKNOWN** | needs the hook's `PoolFeesSwept` join over ~53M logs; not feasible on this endpoint |

**The two most load-bearing assumptions in the model — win rate and fixed cost —
still have zero observations, exactly as they did yesterday. Nothing in this round
of work touched them.**

### One caveat on the tenure artifact that must not be lost

`full/tenure-full-median7.json` reports `pricing.complete: true`, `assetsSeen: 1`,
`assetsUnpriced: 0`. **That is an artefact of the merge, not a finding.** The
merged document hands `tenure.ts` a single synthetic USD asset (`0x…0001`, 6 dp)
with the per-day pricing already applied upstream, so the toolkit's own
unpriced-tail refusal cannot fire and it exits 0 where the 7-day document
correctly exited 3. **The 1,986 unpriced assets are still unpriced.** The
protection against them is the **priced-only floor basis** (150 standing), which
excludes nobody and is a genuine lower bound: a recipient whose priced-only
trailing median already clears a gate clears it whatever its unpriced credits turn
out to be worth.

### The fully-priced subset excludes the two largest addresses on the chain

2,245 recipients touch a dust asset with no price on some day and fall out of the
146. The two biggest are the **protocol fee recipient** `0x263ed295…19dd`
($12.24M carried) — which is Venue's own house and should not be counted as a
client anyway — and the **aggregator** `0xfdde5a1e…cc36` ($1.76M, 497,340
credits), which is the incumbent operator of §4 and is likewise not a client.
The priced-only floor of **150** includes both; **149** is the addressable lower
bound. Use 149 if you want a bound rather than a subset. It does not change the
verdict: 149 × 58.4% = 87, still STOP.

---

## 4. The incumbent: 44% of the population is contract-routed, and 95% of that is locked

### The premise that was being tested was false

The claim under investigation was that ~98.2% of Venue fee redirects point at a
router at `0xb2a748f6…`. **Refuted outright.** That address appears in **zero of
1,312,335 escrow credits**, holds a zero balance, and answers no getter (it does
carry 11,453 bytes of code — re-confirmed live this session — it simply is not a
fee recipient). The most concentrated single creator-leg recipient on the whole
chain holds **1,058 of 144,500 coin memberships — 0.73%, not 98.2%**, across
117,514 distinct recipients. **There is no single router.**

### What is actually there

A real incumbent exists and was found in a different leg. **It has no public name
and one is not guessed here** (see §8.7).

- Operator EOA **`0x3a3e6be1e8be67a4e2e7e2e815a66ba03a27f5d4`** — the address the
  previous verdict called its largest unidentified risk.
- It **deployed and owns** a distributor factory `0x70e95cc5…` (ERC1967Proxy,
  Sourcify `runtimeMatch: "match"`; `deployer` and `owner()` both `0xfdde5a1e`).
- Per-coin recipients are **beacon proxies** over beacon `0xa125492a…`, whose
  `implementation()` is `0x53c2eae568c4095c6972817f5fcb6141b723d920` — a
  **per-coin, epoch-based merkle revenue distributor**
  (`claim(epoch,acct,amt,_,proof)`, `harvest()`, `rollOver`, `hasClaimed`,
  `isExcluded`, `CLAIM_WINDOW` 90 days; one live instance at epoch 196).
- The beacon is owned by an OpenZeppelin **TimelockController** `0x0f963968…`
  with a **2.00-day** minimum delay, on which `0xfdde5a1e` holds **PROPOSER +
  EXECUTOR + CANCELLER**. One key can upgrade every distributor.
- `factory.whitelistedLaunchers(0xfdde5a1e) = true`. **A sanctioned partner
  launchpad, not a squatter.**

### Capture, over all 125 T1 coins, 125/125 live coverage

| live creator-fee recipient class | coins | share | 7-day creator-leg USD | share |
|---|---:|---:|---:|---:|
| EOA | 66 | 52.8% | — | — |
| EOA under EIP-7702 (MetaMask `EIP7702StatelessDeleGator`, Sourcify exact match) | 4 | 3.2% | — | — |
| **signable subtotal** | **70** | **56.0%** | **$4,588,524** | **57.7%** |
| INCUMBENT_DISTRIBUTOR (beacon proxy over `0x3b09f732`) | 37 | 29.6% | $2,440,333 | 30.7% |
| CLONE_1167 + OTHER_CONTRACT | 18 | 14.4% | $917,637 | 11.5% |
| **contract-routed subtotal** | **55** | **44.0%** | **$3,357,970** | **42.3%** |
| total | **125** | 100% | **$7,946,494** | 100% |

**Capture by the incumbent specifically is 30%, not the 98% the premise claimed.
The number that binds is the 44% that is contract-routed at all.**

The incumbent also holds the **per-pool `protocolFeeRecipient` slot** on 29 of the
125 (281 pools chain-wide). Overlap with its distributor-routed coins is only 3,
so **63 of 125 (50.4%) are touched by the incumbent in one leg or the other.**

### Why contract-routed means unwinnable

Reassignment is a closed set of three paths, each established live by simulated
`eth_call` with a varied `from` and decoding the returned custom-error selector
(read-only; no transaction was ever sent):

- `hook.setCreatorFeeRecipient` → `NotFactory()` (`0x32cc7236`) for every sender.
- `factory.setCreatorFeeRecipient(address,address)` → `OwnableUnauthorizedAccount`
  (`0x118cdaa7`); owner is Venue `0x263ed295…`, **confirmed live this session**.
- `factory.transferCreatorFeeRecipient(address,address)` succeeds **only from the
  current recipient**, else `NotCreatorFeeRecipient()` (`0xb9f93944`).

So the *current recipient* must call. **The incumbent's distributor implementation
contains none of the four possible exit selectors** — re-verified live this
session against the deployed bytecode at `0x3b09f732` (9,257 bytes). There is no
code path out. Of the 18 non-incumbent contract-routed coins, only **3** carry
`transferCreatorFeeRecipient` — also re-verified live, coin by coin, by an
independent script written for this reconciliation.

**52 of the 55 contract-routed T1 coins are technically locked. 73 of 125 are
winnable.**

The direction of travel is one-way and it is not close. Over the hook's **entire
life**, 361 `CreatorFeeRecipientUpdated` events (topic0 established by scanning
five candidate signatures and taking the one that returns logs, not by inference):
**141 EOA→distributor, 62 EOA_7702→distributor, 61 CONTRACT→CONTRACT, 57 EOA→EOA,
15 EOA→CONTRACT**, and smaller classes. **Moves off a distributor: zero.** (The
lone DISTRIBUTOR→DISTRIBUTOR event has `old == new`.)

### The incumbent takes 0 bps of the creator leg

Measured, not inferred: its revenue is the per-pool protocol-fee slot, not a rake
on the dev. Measured protocol share on its coins **16.72%** vs Venue's **15.64%** —
no extra take. Seven-day protocol-leg earnings **$236,758 across 281 coins**
(Venue: $6,140,035 across 3,759). Against Phase 0 competitor norms (venueFlow 0%,
Sinjoh 1%, Venue Bot 5%), it charges the creator **nothing**. Against
`config/protocol.ts` this is not like-for-like: our 500 bps is a take of the
creator's QF; the incumbent's is a 30% share of the 1% hook fee, earned only on
pools it launched.

**This is not a price war we are losing. It is a distribution position we do not
hold**, and the switching cost it imposes is not commercial — it is that the
function does not exist.

### Lock-in is asymmetric, and the asymmetry runs against us

"No code path out" is true of the *current* implementation. The distributors are
**beacon proxies**, so `0xfdde5a1e` can add an exit — or anything else — to all of
them at once through a 2-day timelock on which it holds proposer, executor **and**
canceller. **The incumbent can free its coins at will; we cannot.** Treat 73 as an
*upper* bound on winnable and a *lower* bound on incumbent optionality. (The same
fact means depositor funds across 281 pools sit behind a single upgrade key with
no independent check — a diligence finding in its own right, not a market one.)

### The comparison that is NOT evidence

Median trailing-7-day-median QF: signable **$2,838** (n=70) vs contract-routed
**$2,838** (n=55) — identical to the dollar. Means $4,918 vs $5,976, the gap
driven by one distributor outlier at $82,654 (EOA max $38,980). **This supports
"no measured lift from the incumbent's service", not "the service does not
work."** Selection is entirely unmodelled — devs who hand fees to a
holder-distribution product plausibly differ in ambition, backing and token design
— and the incumbent's coins differ by *design* as well as by outcome (median
`creatorTaxBps` 50 vs 200; buyback-on 37.8% vs 8.6%). **Do not cite this as
causal.**

### The decode control that could have failed, and did not

`hook.launches(poolId)[2]` (launched token) equals the independently-joined coin for
**125 of 125**. `launches()[4]` (creator-fee recipient) equals the independently
measured 7-day dominant creator-leg recipient for **115 of 125 (92.0%)**; all 10
disagreements are recipients that **changed after the window** (8 of the 10 are
clone-vault moves) — the expected direction, and the reason the live read rather
than the artifact is the right basis for a forward-looking commercial question.

---

## 5. A 3.00-day acquisition latency that the model cannot express

Both sides of this are measured, and it is not in the 0.68.

`CREATOR_FEE_RECIPIENT_TIMELOCK` is **259,200 s = 3.00 days**, with a further
3.00-day execution window that can lapse and a cancel path. **Every signing has a
hard three-day floor from proposal to first fee redirected.**

`reprice.ts` has no input for acquisition latency, so its ratio implicitly assumes
zero. The corrected arithmetic — clearly marked **ARITHMETIC**, no CLI flag,
`config/protocol.ts` untouched:

```
required weekly signings   = breakEven x 7 / (tenure - latency) = 10.81 x 7 / 8.59  = 8.81/wk
available weekly crossings = population x 7 / tenure            = 73    x 7 / 11.59 = 44.09/wk
winnable at a 10% win rate                                                          =  4.41/wk
ratio = 4.41 / 8.81                                                                 = 0.50
```

**Ratio 0.50, not 0.68.** The same arithmetic at the generous population of 85
gives **0.58**. And the population needed for ratio 1.00 **with** the latency
modelled is **146 winnable coins** — which is, by coincidence, the entire
uncorrected standing recipient count.

**One correction to how this was framed on arrival.** This collision was reported
as *"3.00-day timelock versus 3.01-day mean tenure — a coin becomes yours at almost
exactly the moment its gate-clearing life ends."* On the corrected 11.59-day tenure
**that framing is too strong and is withdrawn**: the timelock burns 25.9% of a
client life, not ~100%. It is a serious, unmodelled ~26% haircut to LTV and to the
required acquisition rate. It is not an existential collision. **This is the one
place where the tenure correction genuinely rescued something — it just rescued
the wrong number to save the verdict.**

---

## 6. Cross-endpoint verification, and the bound it actually supports

**Finding: AGREE.** The previous document's §6 item 6 is **closed for the 7-day
window and only partly closed for the 36-day scan.** Both must be stated, because
the headline population and tenure come from the 36-day scan.

### The 7-day window (blocks 50,419,076 → 56,389,048) — well covered

- **Chain identity.** Both endpoints serve chain 4663. The window's first and last
  **25 blocks — 50 blocks exhaustively, not sampled —** agree on all 9 header
  fields including `receiptsRoot` and `logsBloom`. **0 mismatches.**
- **Two independent seeded samples** (`venue-cross-verify-1`, `-2`) drawing **80
  distinct 5,000-block windows**, stratified by UTC day with a per-day floor:
  **400,000 blocks = 6.70% of the period.** Escrow **94,215** logs and hook
  **14,957** logs compared as ordered tuples plus full topics, address and tx
  hash. **Byte-identical. Zero mismatches, both targets.**
- **Negative controls, which a comparison must have to mean anything.** Shifting
  the secondary's range by one block, and querying a different contract over the
  same range, both **diverged** as required. The comparison can fail.
- **Representativeness.** The sample's stratified estimate of the credit
  population is ~1.37M against the full scan's actual **1,312,335** (+4.4%), and
  ~233k sweeps against the actual 208,604 (+11.8%). Drawing from the right
  population.

**The bound to quote is the clustered one: at 95% confidence a range-shaped defect
could still affect ≤ 3.68% of the period's 1,194 window-slots — a contiguous gap
up to ~219,000 blocks wide would have escaped both samples.** The per-log
(≤ 0.00318%) and per-block (≤ 0.000749%) bounds are tighter *only because they
assume a defect shape nobody has characterised.* All three were recomputed by hand
in this session and agree with the tool (rule of three at k = 0).

### The 36-day scan — the bound is much weaker, and this must not be glossed

The population of **146** and the tenure of **11.59 d** come from the **36-day**
merge, which the 80-window sampling never touched. Its cross-endpoint evidence is
**12 two-thousand-block boundary slices**, two per window: 12 of 12 answered by
both, **12 of 12 agree** on log count and on a sha256 digest over
`(blockNumber, logIndex, txHash, topics, data)`, 0 disagree. That is **24,000 of
30,930,838 blocks — 0.078% coverage**, and the rule of three at n = 12 bounds a
range-shaped defect at **≤ 22.1% of comparable slices**.

**So: the 7-day window is cross-verified to a tight bound; the 36-day window is
cross-verified at its seams only, to a bound that permits a great deal.** The
36-day scan's *internal* controls are strong — every window's streamed recipient
count equals its declared count, owned-day credits sum to the merged total
exactly (2,877,162 of 2,877,164 scanned; the 2-log difference is a boundary sliver
correctly assigned to the neighbouring window), all six boundary block headers land
exactly on 23:59:59Z of their dates, and `tenure.ts` reproduces `full-history.mjs`
to the digit on an independent code path — **but internal consistency is not
cross-endpoint verification.** The secondary answers roughly one `eth_getLogs` in
five and takes ~25 s when it does, which is why it was used for verification and
not for scanning, and why a full second scan is impractical at this scale.

**One genuine cross-window control does exist.** The 36-day merge, on a different
window, a different pipeline and a different price book, reproduces the published
7-day figures on 2026-09-06: **T1 128** per-day / 130 as-of (VERDICT reported 128
/ 130), **T2 71** (71), **T3 6** (6), mean QF of the T1 standing stock **$5,276**
vs $5,268 (0.15%). That is not a substitute for endpoint agreement, but it is a
strong independent check on the merge.

### Two findings that were not previously known

- **The "single node" was never one node.** `rpc.mainnet.chain.robinhood.com` is a
  **load-balanced pool**: 8 probes drew the same nitro build
  (`v3.11.4-rc.3-7d5ac27`) on both `linux-amd64` and `linux-arm64`. This *weakens*
  the single-node worry and does **nothing** for common mode: identical code on
  different silicon fails identically. The tool previously reported one draw from
  that pool as definitive; it now probes N times and states both halves.
- **`logsBloom` verification — the only control here that reaches common mode.**
  Every log in 20 boundary blocks refetched unfiltered, folded into a bloom, and
  compared to the header's `logsBloom`, which is committed inside the block hash by
  **consensus** rather than asserted by the other node. **40/40 block-endpoint
  pairs matched across 3,072 logs.** Its power depends on the shape of an omission,
  and was **measured** rather than claimed: one dropped log caught only
  **22.9–34.1%** of the time; a dropped run of five, **70.1–88.2%**; every log of
  one contract, in all 5 contract-cases tested (that last figure rests on 5 cases
  and **should not be quoted as a rate**). **Strong against a systematically short
  index. Weak against a lone lost log. Do not sell it as completeness
  verification.**

### What remains open

Both endpoints run the **same client family (nitro)**. A defect in that client's
log index would sit on both sides, agree perfectly, and be invisible at any sample
size. The bloom check is the only control that bites, and it ran on 20 boundary
blocks, not the interior. Closing this properly needs a **second client
implementation** or an independent indexer, neither known to exist for chain 4663.
**Extending the bloom check across the sampled windows is the cheapest real
improvement available and it was not done** — it is the first thing to add before
the October re-run.

**And neither endpoint is ground truth.** Agreement says they do not differ. It
does not say either is right, and it says nothing about whether the events mean
what this project reads them to mean — that rests on the earlier topic census, not
on this work.

---

## 7. What would flip it, quantified

Each row moves one input with the rest held at measured or stated values.

| Move this | To this | Result |
|---|---|---|
| Winnable population | **109 → GO**, 108 → STOP | today: **73**. Needs **+36 (+49%)** |
| Winnable *share* at 146 standing | **74.7% → GO** | today: **58.4% measured**. Capture must more than halve |
| Standing population at today's capture | **~187 coins (≈196 recipients) → GO** | today: 146 recipients. **Reachable in days at the observed growth rate — see §1** |
| Acquisition latency modelled | 3.00 d → **ratio 0.68 → 0.50** | measured, and *not* in the tool's number |
| Win rate at 73 winnable | **≥ 14.8% → GO** *(arithmetic: 6.53 / 44.09)* | today: 10%, **assumed, zero observations** |
| Fixed cost at 73 winnable | **≤ ~$8,100/mo → GO** *(arithmetic: break-even must fall to ~7.3)* | today: $12,000/mo, **assumed** |
| Tenure | **nothing** | ratio is **0.6753** at 3.01, 8.59, 11.59 and 32 days alike |

**The verdict is now robust to the two inputs the previous one worried about most
(ETH price, tenure) and fragile to one it did not model at all (capture).**

There is also a rendering defect worth knowing, inherited and still present: at a
population of 108 the tool prints `feasibility ratio : 1.00 (NOT ACHIEVABLE)`. The
verdict is correct; the rounded display makes a STOP look like a tie. **Near the
boundary, read the verdict, not the ratio.**

---

## 8. What remains genuinely unmeasurable, and the reason each is unmeasurable rather than merely unmeasured

**These are gaps in reality, not gaps in the work. Each entry states why no window
length, endpoint or method closes it today.**

1. **A 56-day tenure cannot exist yet, for anyone, by construction.** V2 is
   **35.4 days old**. At **T3 the plan's assumption is falsified outright**:
   S(7) = 0, every T3 spell ended inside the window, mean = RMST = **5.00 d
   exactly**, no unobserved tail to appeal to, zero of 11 T3 spells reached even
   14 days. At **T1 and T2 it is bounded rather than falsified**: using
   `mean = RMST(τ) + S(τ)·E[residual]`, for T1's mean to be 56 d the 14.13% of
   spells still above the gate at day 32 would each have to run a further **314
   days on average — roughly nine times the entire life of the chain** (T2: 198
   further days). The longest anyone has **ever** held T1 is **32 days**, exactly
   one recipient did it, and 9 of 250 spells reached 14 days.
   *Unmeasurable because the chain is younger than the claim.*

2. **Every figure here was measured inside a gas subsidy that expires
   2026-09-29.** No post-subsidy dataset exists anywhere and none can be collected
   before that date. This now cuts harder than it did: the 5× population growth in
   the final nine days, and the migration rate onto the incumbent's distributors
   (203 EOA→distributor moves in 34 days), are the two most decision-relevant
   series in this document and both have ~34 days of history on a chain that has
   never traded at true cost. *Unmeasurable because the date has not arrived.* See
   `OCTOBER-RERUN.md`.

3. **The win rate has zero observations.** No client has ever been signed. 10% is a
   number someone chose, and the verdict needs 14.8%. *Unmeasurable because the
   instrument is a signed client and there are none.*

4. **COGS is a model, not an instrument.** $10 of T1's $13/day is human ops at one
   FTE per 50 coins — precisely what the **unrun Section 9 pilot** tests.
   *Unmeasurable because the pilot has never been run against a real coin.*

5. **The book is not in steady state, and this is now much worse than the 7-day run
   suggested.** Little's Law consistency ratio **0.428** at T1 over 36 days
   (L = 34.33, λ = 6.92/d, implied W = 4.96 d against 11.59 d from the curve),
   versus 0.829 over 7 days. Standing went 1 → 10 → 60 → **146**, +18 on the final
   day. `reprice.ts` says in its own method limits that when this ratio is far from
   1.0 its figures "describe a market that does not exist". **Read both the STOP
   and the growth curve as statements about a market in violent expansion, not a
   stationary one.** *Unmeasurable because a steady state you are not in cannot be
   observed; it can only be waited for.*

6. **The coin basis was not re-derived over 36 days.** Everything from the
   full-history scan is the **recipient** basis. The coin attribution needs the
   hook's `PoolFeesSwept` join; the hook runs ~1.84 logs/block, so 30.93M blocks is
   ~53M logs. *Unmeasurable in this session because the endpoint cannot serve it at
   0.8 rps* — not because the method is unknown. The 139/143 coin-scaled figures in
   §1 apply the 7-day-measured coin:recipient ratio and are **assumptions**; the
   previous verdict's own finding that the unit mismatch moves the number by three
   makes this a small one, but it is one.

7. **The incumbent has no name, and one is not guessed.** It is **not**
   VenuePad / VenueVault / Venue Bot / Sinjoh / venueFlow / Multi Agent Fund on any
   evidence available. Every route was tried and each failed for a stated reason:
   the implementation is unverified on Sourcify; hoodscan.co returned
   `{"error":"Out of credits"}` on all three attempts; the bytecode carries no name
   strings (custom errors only, no revert strings); the embedded IPFS metadata CID
   `QmTXKYGoYqz2Jft8kUQwN3EA24nWfradpkjWo1F3txTyb4` is **not pinned** on ipfs.io,
   dweb.link, cloudflare, pinata, 4everland or w3s.link; a web search on the
   operator address returns nothing. Recorded as an **EXPLICIT UNKNOWN** per the
   fail-closed rule. The structural fingerprint above is enough to recognise it on
   sight. *Unmeasurable from the chain because a name is off-chain metadata nobody
   has published.* **One funded block-explorer API key or one pinned CID finishes
   this in minutes, and it should be done before any commercial conversation.**

8. **What the distributors actually pay out is unverified.** The merkle/epoch
   machinery is confirmed and one live instance reads epoch 196 with a 90-day claim
   window, but **whether claims are actually being made, and whether unclaimed
   funds roll to holders or to the operator, was not established.** *Unmeasured
   rather than unmeasurable* — it needs a claim-event scan that was not run. **It
   is a diligence question with teeth and it is the one item on this list that a
   keyboard could close.**

9. **The curve path contributes zero standing clients.** Not one of the 141,653
   pre-graduation coins holds a 7-day median above even T1 — a bonding curve does
   not live seven days. The entire gate-clearing population is post-graduation,
   capping the funnel at the **5,485 pools ever registered**, not the 309,984 coins
   launched. **A 56× smaller funnel than a launch count suggests, and nothing in
   the plan reflects it.**

10. **The tiers above T1 have almost no qualifying market, over V2's entire life
    and not merely over a 7-day window.** T2: 79 standing, 127 ever above, 26 with
    a ≥7-day run, and **exactly 3 recipients have ever met T2's 14-day sustained
    requirement.** T3: 6 standing, 11 ever above, 1 with a ≥7-day run, and **ZERO
    have ever met T3's.** The previous verdict said T3 was thinner than any count
    suggests; 36 days of data says it is thinner than that.

11. **Tenure is measured on RECIPIENTS, not coins.** `tenure.ts` inherits its
    subject from `escrow-index` and its own method limits say so. This does not
    touch the STOP/GO (tenure cancels), but LTV is quoted per client-life and
    inherits it. *Unmeasured, and blocked by the same 53M-log join as item 6.*

12. **58.4% of T1 spells were still running when the window closed, and KM puts
    14.13% of the survival mass beyond day 32.** 11.59 d remains a **lower bound**
    and will keep rising as the chain ages. It is a far tighter bound than 3.01 d —
    41.6% of spells have already ended by day 7 and 86% of the survival mass is
    resolved by day 32 — but it is not a final answer. `tenure.ts` prints its own
    `measurabilityCeilingDays: 35`. **Most of that censoring is entry, not
    longevity**: the standing population went 60 → 146 in the final nine days, so
    recent arrivals cannot yet have long spells.

13. **The toolkit's V2 genesis default is 9h18m41s late.** `tools/lib/env.ts:67`
    sets `DEFAULT_V2_GENESIS_UNIX` to `2026-08-04T00:00:00Z`; the measured genesis
    is **2026-08-03T14:41:19Z** (block 26,841,846), and the first escrow credit is
    block 27,027,321 at 19:50:47Z, 5h09m after deployment. **Reported, not
    changed** — it is toolkit source and moving a default silently changes
    `measurabilityCeilingDays` for every past artifact. `eth_getCode` at a
    historical block is unavailable on this endpoint (`"metadata is not found, N"`
    — no archive state, confirmed at heights from block 1 to 57M), so a
    code-presence bisect is impossible; the genesis is established by bisecting
    `eth_getLogs` for each contract's first event, and the factory and buyback-vault
    transactions in that block are confirmed contract creations (`to == null`,
    `contractAddress` matching).

---

## 9. Live validation performed for THIS document

Not inherited. Run in this session, 2026-09-08, against head block 57,549,796.

**The decision-flipping claim was re-derived from scratch on an independent code
path**, because a STOP that rests on one script is not a STOP:

- `factory.CREATOR_FEE_RECIPIENT_TIMELOCK()` → `0x3f480` = **259,200 s = 3.00 d**;
  `CREATOR_FEE_RECIPIENT_EXECUTION_WINDOW()` → identical.
- `factory.owner()` → `0x263ed295…19dd` (Venue).
  `factory.whitelistedLaunchers(0xfdde5a1e)` → **true**.
- `hook.hookFeeBps()` → 100. `hook.protocolFeeShareBps()` → 3000.
  `hook.protocolFeeRecipient()` → `0x263ed295…19dd`.
- EIP-1967 beacon slot on a live distributor → beacon `0xa125492a…`;
  `implementation()` → **`0x53c2eae568c4095c6972817f5fcb6141b723d920`**;
  `owner()` → timelock `0x0f963968…`; `getMinDelay()` → `0x2a300` = **172,800 s =
  2.00 d**; `hasRole` **true** for `0xfdde5a1e` on PROPOSER, EXECUTOR and CANCELLER.
- Distributor implementation bytecode (9,257 bytes) scanned for all four possible
  exit selectors: **none present.**
- The 18 non-incumbent contract-routed T1 coins re-classified one at a time,
  following each EIP-1167 clone to its implementation: **exactly 3 carry
  `transferCreatorFeeRecipient(address,address)`.**
- **Independent recomputation: 70 signable + 3 contract-with-exit = 73 of 125.**
  Matches `incumbent-capture.json` exactly.
- `0xb2a748f6…` (the refuted router): 11,453 bytes of code, **balance zero.**
- **Cross-endpoint:** the three decision-critical reads
  (`CREATOR_FEE_RECIPIENT_TIMELOCK`, beacon `implementation()`, timelock
  `getMinDelay()`) re-run against `rpc.ordofi.network` return **byte-identical**
  values. Both endpoints report `eth_chainId` `0x1237` = 4663.

**Repository state, this machine, 2026-09-08:**

| Check | Command | Result |
|---|---|---|
| Build | `npx tsc --build --force` | **exit 0** |
| Coherence | `node tools/check-coherence.mjs` | **OK — 14 projects, 499 source files** |
| Root tests | `npx vitest run` | **89 files / 1,686 tests passed** |
| `tools/` tests | `npx vitest run --config tools/vitest.config.ts` | **18 files / 457 tests passed** |
| `ops/` tests | `npx vitest run` from `ops/` | **9 files / 228 tests passed** |
| Contracts | `forge test --root contracts` | **9 suites / 137 tests passed, 0 failed** |
| Test typecheck | `node tools/typecheck-tests.mjs` | **all test configs clean** |
| Rate guard | `node ops/ci/no-hardcoded-rates.js` | **clean, 541 files, exit 0** |
| Secret scan | `node ops/ci/secret-scan.js` | **clean, 731 files, 1 placeholder ignored, exit 0** |
| Import lint | `node ops/ci/lint-imports.js` | **exit 0** (warnings only) |

**117 test files / 2,412 TypeScript tests and 137 Foundry tests green. Nothing
red, nothing skipped, no test weakened. `config/protocol.ts` was not edited and no
toolkit source was changed for this reconciliation.**

**And a green suite is not a validated business. It is why this document exists.**

---

## 10. Reproduce

```bash
export VENUE_RPC_URL=https://rpc.mainnet.chain.robinhood.com
export VENUE_BLOCK_TIME_SECONDS=0.101
export VENUE_HTTP_RPS=0.8
export VENUE_LOG_CHUNK_BLOCKS=10000

# (1) THE VERDICT
node tools/reprice.ts --tenure-days 11.59 --operator-bps 500 --clients-above-gate 73

# (2) the uncorrected comparison, and the flip point
node tools/reprice.ts --tenure-days 11.59 --operator-bps 500 --clients-above-gate 146
node tools/reprice.ts --tenure-days 11.59 --operator-bps 500 --clients-above-gate 109
node tools/reprice.ts --tenure-days 11.59 --operator-bps 500 --clients-above-gate 108

# (3) the capture measurement that produces the 73 (live; ~10 min)
node tools/artifacts/incumbent-capture.mjs
node tools/artifacts/reassign-flow.mjs

# (4) the 36-day tenure and standing population
bash tools/artifacts/full/run-analysis.sh          # windows -> merge -> tenure -> verdict
node tools/tenure.ts --input tools/artifacts/full/full-history-reduced-doc.json \
  --qf-definition median7 --out tools/artifacts/full/tenure-full-median7.json

# (5) cross-endpoint verification
npm run cross-verify --prefix tools -- --seed venue-cross-verify-2
```

**For the full re-measurement after the subsidy expires, execute
`tools/artifacts/OCTOBER-RERUN.md` instead of this section. It is written to be
run without reading anything else.**

Artifacts: `full/full-history.json`, `full/tenure-full-median7.json`,
`full/reprice-full-history.json`, `full/genesis.json`,
`full/endpoint-crosscheck.json`, `incumbent-capture.json`, `reassign-flow.json`,
`cross-verify-7d.json`, `cross-verify-7d-seed2.json`, `cross-verify-bloom.json`.
Method and background: `MEASUREMENT.md`.

---

## 11. The one-paragraph version

**On the best inputs that exist — V2's entire 36-day life, every day priced at its
own close, tenure corrected from 3.01 to 11.59 days, and every one of the 125
gate-clearing coins classified by a live read of who controls its fee recipiency —
`reprice.ts` returns STOP at a feasibility ratio of 0.68, and 0.50 once the
measured 3-day reassignment timelock is modelled.** The market produces enough
qualifying coins; **44% of them are contract-routed to a single whitelisted
partner launchpad's per-coin distributors, 95% of those contain no function that
can hand the recipiency back, and zero coins have ever moved off one.** Only 73 of
125 are winnable against a break-even requirement of 109. The population is
growing fast enough to cross that threshold within days — **and it is growing
inside a gas subsidy that lapses on 29 September, which is precisely why that
extrapolation must not be made.** The previous GO rested on a market-supply figure
that never counted whether the supply could be bought; this STOP rests on
measuring that, live, coin by coin, on two endpoints. **It still rests on a 10%
win rate nobody has observed, a $12k/month fixed cost nobody has incurred, a
$13/day COGS the unrun pilot exists to test, and an incumbent whose name nobody
has established.** Do not ship. **Name the incumbent, run the pilot, and re-measure
in October.**
