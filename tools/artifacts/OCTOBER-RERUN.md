# OCTOBER RE-RUN

**Reproduce the entire Venue market measurement after the gas subsidy expires on
2026-09-29.**

**This document is self-contained. You do not need to read `VERDICT.md`,
`MEASUREMENT.md` or any source file to execute it.** Run it top to bottom. Every
number you are checking against is in §8.

**Why this exists.** Every figure in this repository was measured between
2026-08-03 and 2026-09-08, entirely inside a gas subsidy that lapses on
2026-09-29. No post-subsidy dataset exists anywhere and none could be collected
before that date. The current verdict is **STOP** and the two series most likely
to move it — the standing population and the incumbent's capture rate — are also
the two most likely to be subsidy artefacts.

**Do not start before 2026-10-08.** You need at least seven *complete* UTC days
that are entirely post-subsidy, and 2026-09-29 is itself a transition day. The
first clean 7-day window is **2026-09-30 → 2026-10-06**; §2 uses
**2026-10-01 → 2026-10-07** so that no part of the transition day is in it.

Total wall clock: **6–8 hours**, most of it unattended scanning. Budget a full
working day.

---

## 0. Preflight — do this first, it takes 5 minutes and can save you six hours

```bash
cd /c/tech/intern/fee-split-vaults          # Git Bash. PowerShell works; adjust paths.

# 0.1  Environment. EVERY later step assumes these are exported.
export VENUE_RPC_URL=https://rpc.mainnet.chain.robinhood.com
export VENUE_HTTP_RPS=0.8
export VENUE_LOG_CHUNK_BLOCKS=10000
export VENUE_BLOCK_TIME_SECONDS=0.101      # RE-MEASURE THIS IN 0.4 BEFORE TRUSTING IT
export VENUE_V2_GENESIS_UNIX=1785768079    # measured: 2026-08-03T14:41:19Z, block 26,841,846

# 0.2  The tree is green before you measure anything, or you are debugging two
#      things at once.
npx tsc --build --force                                   # expect exit 0
node tools/check-coherence.mjs                            # expect: OK, 14 projects
npx vitest run                                            # expect 89 files / 1,686 tests
npx vitest run --config tools/vitest.config.ts            # expect 18 files / 457 tests
(cd ops && npx vitest run)                                # expect 9 files / 228 tests
forge test --root contracts                               # expect 9 suites / 137 tests

# 0.3  Both endpoints alive and on chain 4663 (0x1237).
for U in https://rpc.mainnet.chain.robinhood.com https://rpc.ordofi.network; do
  echo -n "$U -> "
  curl -s -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$U"
  echo
done
```

**0.4 — RE-MEASURE THE BLOCK TIME. Do not skip this.** `0.101 s/block` was
measured *inside the subsidy*. If block production changed, every window's
block range is wrong and every day boundary drifts.

```bash
node - <<'EOF'
const U='https://rpc.mainnet.chain.robinhood.com';
const rpc=async(m,p)=>(await(await fetch(U,{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})})).json()).result;
const head=parseInt(await rpc('eth_blockNumber',[]),16);
const a=await rpc('eth_getBlockByNumber',['0x'+(head-1_000_000).toString(16),false]);
const b=await rpc('eth_getBlockByNumber',['0x'+head.toString(16),false]);
const dt=(parseInt(b.timestamp,16)-parseInt(a.timestamp,16))/1_000_000;
console.log('head',head,'seconds/block over the last 1M blocks:',dt.toFixed(5));
console.log(dt>0.11||dt<0.092
  ? 'CHANGED. export VENUE_BLOCK_TIME_SECONDS='+dt.toFixed(4)+' and say so in the write-up.'
  : 'unchanged within tolerance; 0.101 stands.');
EOF
```

**0.5 — Re-measure the endpoint's span limits if anything in §2 times out.**
As of 2026-09-08: 12k-block spans serve 4/4, 15k serves 3/4, 20k+ times out on
the escrow. The **query timeout binds before the 10,000-result cap**, and the cap
**errors rather than silently truncating**, so `scanLogs`' halving recovery sees a
failure and narrows — verified. `VENUE_LOG_CHUNK_BLOCKS=10000` sits safely below
the limit. If the chain got busier, halve it.

---

## 1. What you are re-measuring, and what you are not

| Re-scan? | Item | Why |
|---|---|---|
| **No** | V2 genesis (block 26,841,846, 2026-08-03T14:41:19Z) | history does not change; 208 RPC calls already spent |
| **No** | Windows W1–W6 (2026-08-03 → 2026-09-07) | already scanned and checkpointed under `tools/artifacts/full/`. **Re-scanning them is ~3 hours for an identical answer** |
| **Yes** | Windows W7+ (2026-09-08 → your end date) | the new data. This is the point |
| **Yes** | The whole per-day price book | new days have no prices |
| **Yes** | Incumbent capture (`incumbent-capture.mjs`) | **a live read; it is only ever as fresh as the moment you run it** |
| **Yes** | Cross-endpoint verification, on the post-subsidy window | the previous bound covers 2026-08-31 → 09-06 only |

---

## 2. Scan the new escrow windows — 35–40 min each, unattended

Each command scans one 7-day window, ~6.0M blocks, and writes one document.
**They are checkpointed: if one dies, re-run the identical command and it resumes
rather than rescanning.** Run them one at a time — `VENUE_HTTP_RPS=0.8` is a
global budget and two concurrent scans just halve each other.

```bash
OUT=tools/artifacts/full

scan () {   # scan <name> <last-UTC-day-of-window>
  node --max-old-space-size=16384 tools/escrow-index.ts \
    --days 7 --to "$2T23:59:59Z" --mode both \
    --anchor-spacing 10000 --rpc-batch 10 \
    --allow-missing-prices --keep-checkpoint --top 12 \
    --out "$OUT/escrow-$1.json" -v \
    > "$OUT/$1.stdout.log" 2> "$OUT/$1.stderr.log"
  echo "$1 exit $?  $(grep -o 'elapsed [0-9hms]*' "$OUT/$1.stderr.log" | tail -1)"
}

scan W7  2026-09-14
scan W8  2026-09-21
scan W9  2026-09-28     # last pre-subsidy-expiry window
scan W10 2026-10-05     # STRADDLES the 09-29 transition. Keep it; label it.
scan W11 2026-10-12
scan W12 2026-10-19     # add W13 2026-10-26 etc. if you want a longer read
```

**Expect `exit 3`, not 0, and that is correct.** `--allow-missing-prices` makes
the toolkit refuse its own USD conclusions while still writing the artifact,
because the dust-asset tail is unpriced. The pricing happens in §3, per day.
A `PRICES ARE MISSING` banner in the stdout log is the tool working, not failing.

**If a scan dies with `giving up after 6 attempts (HTTP 429)`:** re-run the same
command with `--rpc-batch 1`. This is measured, not folklore — it is what took
window W4 from stalled to 0.255 chunks/s and let it complete. The limiter charges
**sub**-requests, so a batch of 10 at 0.8 rps and a batch of 1 at 0.8 rps deliver
the same chunk throughput; batching only multiplies the per-request cost when the
endpoint is under pressure. (The CLI help still recommends 10 as the measured
optimum under normal load. Both are true. Start at 10, fall back to 1.)

**The window arithmetic you must not get wrong.** `--days 7 --to <D>T23:59:59Z`
makes a window whose **first** calendar day is a one-second sliver belonging to
the *previous* window and whose **last** day is complete. Each UTC day is
therefore owned by exactly one document. `make-plan.mjs` in §4 **refuses to run**
unless the owned dates form a contiguous, non-overlapping partition — let it do
the checking, do not hand-verify.

---

## 3. Rebuild the per-day price book — 20–40 min

**Never price a multi-day window at one as-of price.** Measured cost of doing so
over 2026-08-03 → 09-07: only **+1.65%** on the window total (the last week
carries most of the value) but **+28.8% over the first 14 days** and **+31.8% on
the worst single day**, and it moves the T1 standing count by 2 and the KM
restricted mean by 0.21 d.

```bash
# 3.1  ETH daily closes: median of Kraken / Coinbase / Bitstamp, one per UTC day.
node tools/artifacts/fetch-eth-daily.mjs                # -> full/eth-daily.json

# 3.2  Per-token daily closes on chain 4663 for the head assets.
node tools/artifacts/fetch-daily-prices.mjs             # -> full/token-daily.json

# 3.3  REPAIR THE HOLES. Enumerates ALL of a token's pools (paged), prefers
#      USDG/USDC/WETH-quoted and deeper pools, takes that day's own daily bar and
#      falls back to the last hourly bar inside the same UTC day.
#      On the September run this recovered 257 day-closes and took assets with a
#      complete series from 24 to 29 of 53.
node tools/artifacts/full/fill-daily-gaps.mjs           # -> full/token-daily-filled.json
```

**Sanity-check before you go on:**

```bash
node -e "
const d=require('./tools/artifacts/full/eth-daily.json');
const v=Object.values(d).map(Number).filter(Number.isFinite);
console.log('ETH days:',v.length,' min',Math.min(...v).toFixed(2),' max',Math.max(...v).toFixed(2));
"
```

You need **one close per UTC day in your window, with no nulls.** A missing day is
an **explicit unknown** — it is never zero and it is never carried from the day
before. If you cannot price a day, say the day is unpriced and let the floor basis
(§4) carry the conclusion.

---

## 4. Merge, price per day, compute gates and tenure — 10–20 min, no network

```bash
# 4.1  Add your new windows to CANDIDATES in tools/artifacts/full/make-plan.mjs,
#      in date order, each with its ownFrom/ownTo. Then:
node tools/artifacts/full/make-plan.mjs
#   It EXITS 2 rather than silently leaving a hole if the owned dates are not a
#   contiguous, non-overlapping partition of the window. Trust that refusal.

# 4.2  Merge + per-day pricing + gate cohorts + spells. ~15 min, memory-hungry.
node --max-old-space-size=16384 tools/artifacts/full-history.mjs \
  tools/artifacts/full/plan.json 2>&1 | tee tools/artifacts/full/full-history.log

# 4.3  The toolkit's OWN survival estimator on the merged series, as an
#      independent code path. It must agree with 4.2 to the digit.
VENUE_V2_GENESIS_UNIX=1785768079 node --max-old-space-size=16384 tools/tenure.ts \
  --input tools/artifacts/full/full-history-reduced-doc.json \
  --qf-definition median7 \
  --out tools/artifacts/full/tenure-full-median7.json

# 4.4  The 56-day arithmetic, stated rather than asserted.
node tools/artifacts/full/tenure-verdict.mjs tools/artifacts/full/full-history.json
```

**Four integrity checks that must hold. If any fails, stop and fix it — do not
carry the number forward.**

1. Every window's **streamed** recipient count equals its **declared** count.
2. Owned-day credits sum **exactly** to the merged total. (In September:
   2,877,162 owned against 2,877,164 scanned — a 2-log boundary sliver correctly
   attributed to the neighbouring window. A difference of that order is fine; a
   difference of thousands is a partition bug.)
3. Every window-boundary block header lands on **23:59:59Z** of its date.
4. `tenure.ts` (4.3) reproduces `full-history.mjs` (4.2) on `everAbove`,
   `standingAtWindowEnd`, spell counts, KM median and RMST.

**Read `standingAtWindowEnd` from FOUR bases, all of which 4.2 emits — and quote
the floor, not the subset:**

| basis | what it is |
|---|---|
| `perDay` | fully-priced recipient subset. **Excludes anyone touching a dust asset with no price on any day** — including the two largest addresses on the chain |
| `perDayPricedFloor` | **the honest lower bound. Excludes nobody.** A recipient whose priced-only trailing median already clears a gate clears it whatever its unpriced credits turn out to be worth |
| `asOf` | single-price comparison. **For diagnosing pricing sensitivity only. Never the headline** |
| `perDayCarried` | carry-forward sensitivity, to bound what fail-closed exclusion could hide |

**One trap, and it is easy to fall into.** `tenure-full-median7.json` will report
`pricing.complete: true`, `assetsSeen: 1`, `assetsUnpriced: 0`. **That is an
artefact of the merge, not a finding.** The reduced document hands `tenure.ts` a
single synthetic USD asset (`0x…0001`, 6 dp) with pricing already applied
upstream, so the toolkit's unpriced-tail refusal cannot fire and it exits 0. The
dust assets are still unpriced. **The floor basis is your protection, not that
flag.**

---

## 5. Re-measure incumbent capture — 10–15 min, and this is the one that decides it

**This is the step that flipped the verdict in September. It is a live read and it
is stale the moment it finishes.**

```bash
# 5.1  Which coins clear T1 on the post-subsidy 7-day window. Uses the two-path
#      join (curve -> TokenLaunched; hook -> PoolFeesSwept -> PoolRegistered).
VENUE_ASSETS_FILE=assets-7d-head-priced.json \
VENUE_COINS_OUT=coins-above-gates-october.json \
  node tools/artifacts/attribute-coins.mjs

# 5.2  Separate the TRUE creator leg from protocol-leg contamination by exact
#      amount-match against PoolFeesSwept. In September this moved T1 from 128
#      to 125 — the published headline was overstated by three.
node tools/artifacts/split-legs.mjs

# 5.3  THE MEASUREMENT. For every T1 coin, read hook.launches(poolId) live and
#      classify the LIVE creator-fee recipient by eth_getCode:
#      EOA / EIP-7702 delegate / beacon-proxy-over-incumbent / EIP-1167 clone / other.
node tools/artifacts/incumbent-capture.mjs      # -> incumbent-capture.json

# 5.4  The one-way door: every CreatorFeeRecipientUpdated over the hook's whole
#      life, with old and new recipient classified.
node tools/artifacts/reassign-flow.mjs          # -> reassign-flow.json
```

**5.5 — Now compute the number the verdict actually needs. Contract-routed is not
the same as unwinnable: only a recipient that carries an exit selector can hand
recipiency back.**

```bash
node - <<'EOF'
import { keccak256Utf8 } from 'file:///c/tech/intern/fee-split-vaults/tools/lib/keccak.ts';
import fs from 'node:fs';
const U='https://rpc.mainnet.chain.robinhood.com';
const rpc=async(m,p)=>(await(await fetch(U,{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})})).json()).result;
const sel=(s)=>keccak256Utf8(s).slice(2,10);
const EXIT=['transferCreatorFeeRecipient(address,address)','setCreatorFeeRecipient(address,address)',
            'transferCreatorFeeRecipient(address)','setCreatorFeeRecipient(address)'].map(sel);
const ic=JSON.parse(fs.readFileSync('tools/artifacts/incumbent-capture.json','utf8'));
const signable=ic.rows.filter(r=>r.cls==='EOA'||r.cls==='EOA_7702');
const routed=ic.rows.filter(r=>r.cls!=='EOA'&&r.cls!=='EOA_7702');
let withExit=0;
for(const r of routed){
  const target=r.impl ? r.impl : r.creatorRecipient;      // follow clones/proxies
  const code=await rpc('eth_getCode',[target,'latest']);
  if(EXIT.some(s=>code.includes(s))) withExit++;
}
console.log('T1 coins            :',ic.rows.length);
console.log('signable (EOA/7702) :',signable.length);
console.log('contract-routed     :',routed.length,'  of which carry an exit:',withExit);
console.log('WINNABLE            :',signable.length+withExit,
            ' =',((signable.length+withExit)/ic.rows.length*100).toFixed(1)+'%');
console.log('>>> feed WINNABLE to reprice.ts --clients-above-gate in step 7 <<<');
EOF
```

**The most decision-relevant time series in this whole exercise is the migration
rate onto the incumbent's distributors.** In September: **203 EOA→distributor
moves and ZERO moves off one**, over the hook's entire 34-day life. If that ratio
is still compounding after the subsidy, the winnable population shrinks even as
the standing population grows, and no amount of market growth rescues the verdict.
**Report the September and October flow matrices side by side.**

**5.6 — the item a keyboard could close and September did not.** Scan the
distributor implementation's claim events and establish whether claims are
actually being made, and whether unclaimed funds roll to holders or to the
operator. The merkle/epoch machinery is confirmed (`claim(epoch,acct,amt,_,proof)`,
`harvest()`, `rollOver`, `CLAIM_WINDOW` 90 days; one instance at epoch 196) but the
payout behaviour was never verified. **This is a diligence question with teeth.**

**5.7 — try once more to name the incumbent.** Operator EOA
`0x3a3e6be1e8be67a4e2e7e2e815a66ba03a27f5d4`, distributor implementation
`0x53c2eae568c4095c6972817f5fcb6141b723d920`, IPFS metadata CID
`QmTXKYGoYqz2Jft8kUQwN3EA24nWfradpkjWo1F3txTyb4`. In September every route failed
for a stated reason: unverified on Sourcify, hoodscan.co out of API credits, no
name strings in the bytecode, the CID unpinned on six gateways, nothing on a web
search. **One funded block-explorer API key finishes this in minutes. Get one
before October.**

---

## 6. Cross-endpoint verification on the post-subsidy window — ~45 min

```bash
npm run cross-verify --prefix tools -- \
  --from-block <first block of your window> --to-block <last block> \
  --seed venue-cross-verify-oct-1 --windows 40 \
  --out tools/artifacts/cross-verify-oct.json

npm run cross-verify --prefix tools -- \
  --from-block <same> --to-block <same> \
  --seed venue-cross-verify-oct-2 --windows 40 \
  --out tools/artifacts/cross-verify-oct-seed2.json
```

Two independent seeds, then de-duplicate the drawn windows and check they really
are distinct before claiming combined coverage — in September the two seeds
happened not to overlap and that was **verified, not assumed**.

**Quote the clustered bound, and only the clustered bound.** At 95% confidence,
rule of three at k = 0 over n windows: `1 − 0.05^(1/n)`. At n = 80 that is
**≤ 3.68% of window-slots — a contiguous ~219,000-block gap could still have
escaped both samples.** The per-log and per-block bounds are tighter only because
they assume a defect shape nobody has characterised.

**Two things the September run flagged as the cheapest improvements available.
Do them this time:**

1. **Extend the `logsBloom` check across the sampled windows, not just the 20
   boundary blocks.** It is the only control here that reaches a **common-mode**
   defect, because the bloom is committed in the block hash by consensus rather
   than asserted by the other node. Its power is shape-dependent and was measured,
   not claimed: one dropped log caught 22.9–34.1% of the time; a run of five,
   70.1–88.2%. **Do not sell it as completeness verification.**
2. **Cross-check more than the seams of the full-history scan.** September
   verified only 12 two-thousand-block boundary slices across 36 days — 24,000 of
   30.93M blocks, **0.078% coverage, bounding a range-shaped defect at only
   ≤ 22.1%.** The population and tenure headline came from that scan. Sample its
   interior.

Also re-run the **negative controls**, because a comparison that cannot fail
proves nothing: shift the secondary's range by one block, and query a different
contract over the same range. Both must **diverge**.

Note: `rpc.ordofi.network` answers roughly **one `eth_getLogs` in five** and takes
**~25 s** when it does. A null second-endpoint count is that node refusing, not a
disagreement. A full second scan is impractical; sampling is the only option, which
is why the deliverable is a **bound**, not a proof.

---

## 7. The verdict

```bash
# Read these three off your own artifacts, not off this page:
#   TENURE   = result.gates[T1].survival.restrictedMeanDays   (full/tenure-full-median7.json)
#   WINNABLE = the number printed by step 5.5
#   STANDING = gates[T1][priceBasis=perDayPricedFloor].cohort.standingAtWindowEnd

node tools/reprice.ts --tenure-days <TENURE> --operator-bps 500 --clients-above-gate <WINNABLE>

# The uncorrected comparison — what the old method would have said:
node tools/reprice.ts --tenure-days <TENURE> --operator-bps 500 --clients-above-gate <STANDING>

# The flip point, re-run rather than assumed (it moves with fixed cost and COGS):
for n in 105 106 107 108 109 110 111 112; do
  echo -n "$n -> "
  node tools/reprice.ts --tenure-days <TENURE> --operator-bps 500 --clients-above-gate $n --json \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s).result;
        console.log(r.verdict.verdict, r.steadyState.acquisitionFeasibilityRatio.toFixed(4));});"
done
```

**Then apply the acquisition latency by hand — `reprice.ts` has no flag for it and
its ratio implicitly assumes zero.** Re-read the timelock first; it is a contract
constant and it can change:

```bash
# factory.CREATOR_FEE_RECIPIENT_TIMELOCK() on 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
# September: 0x3f480 = 259,200 s = 3.00 days, plus a 3.00-day execution window.
#
#   required/wk = breakEven x 7 / (tenure - latency)
#   winnable/wk = winnable x 7 / tenure x winRate
#   ratio       = winnable/wk / required/wk
#
# September, at 73 winnable and 11.59 d: 4.41 / 8.81 = 0.50, against the tool's 0.68.
```

**Two things that will not change and should not be re-litigated:**

- **Tenure cancels exactly out of the feasibility ratio.** It enters both the
  required rate and the available crossings as `1/W`. Confirmed at 3.01, 8.59,
  11.59 and 32 days — all **0.6753** at 73 winnable. Tenure moves **LTV**, and
  only LTV. If your October ratio changes, it is because the **population**
  changed, not the tenure.
- **Near the boundary, read the verdict string, not the ratio.** At a population
  of 108 the tool prints `feasibility ratio : 1.00 (NOT ACHIEVABLE)`. The verdict
  is right; the rounded display makes a STOP look like a tie.

---

## 8. What to compare against — the September baseline

**Every figure below was measured 2026-08-03 → 2026-09-08 INSIDE the subsidy.
That is the whole point of re-running.**

### The verdict

| | September 2026 |
|---|---|
| **Verdict** | **STOP** |
| Feasibility ratio, as the tool reports it | **0.68** at 73 winnable |
| Ratio with the 3.00-day timelock modelled (arithmetic) | **0.50** |
| Flip point | **109 GO / 108 STOP** |
| Break-even concurrent clients | 10.8 |
| Required signings/week | 6.53 |
| Winnable signings/week at a 10% win rate | 4.41 |
| LTV per client | $428.83 over an 11.59-day life |

### Population and capture — the decisive block

| | September 2026 | flag if October shows |
|---|---|---|
| T1 standing, fully-priced subset (`perDay`) | **146** recipients | any large move either way |
| T1 standing, priced-only floor | **150**; **149** addressable | |
| **T1 coins, true creator leg** | **125** | |
| **WINNABLE** | **73 (58.4%)** | **< 58% ⇒ capture is compounding post-subsidy. This is the alarm.** |
| signable (EOA + EIP-7702) | 70 (56.0%) | |
| contract-routed | 55 (44.0%), of which **52 locked** | |
| incumbent distributors specifically | 37 (29.6%), $2.44M of $7.95M creator-leg USD | |
| coins touched by the incumbent in either leg | 63 of 125 (50.4%) | |
| `CreatorFeeRecipientUpdated`, whole hook life | **361**; 203 EOA→distributor; **0 off a distributor** | any nonzero "off" is real news |
| T1 ever above / sustained ≥7 d / ≥14 d | 246 / 57 / 9 | |
| T2 standing / ever met the 14-day requirement | 79 / **3** | |
| T3 standing / ever met the 14-day requirement | 6 / **0** | |

### Tenure and market shape

| | September 2026 |
|---|---|
| KM restricted mean above T1 | **11.59 d** (τ = 32 d) — **a lower bound**, S(32) = 0.1413 |
| KM median | 7.0 d |
| Spells / completed / right-censored | 250 / 104 / 146 (58.4%) |
| Longest T1 spell **ever** | **32 d**, exactly one recipient |
| T2 RMST / T3 RMST | 8.72 d (τ = 17) / **5.00 d exactly** (τ = 7, S(7) = 0, no tail) |
| Little's Law consistency ratio, T1 | **0.428** — the book is **not** in steady state |
| Standing curve, last nine days | 60 → 146, **+18 on the final day** |
| Mean QF of the T1 standing stock | $5,113.73/day |
| `measurabilityCeilingDays` | 35 |

### Volume, prices, scan

| | September 2026 |
|---|---|
| Window | 36 UTC days, blocks 26,314,511 → 57,245,348 (30.93M) |
| Credits decoded / merged | 2,877,164 / 2,877,162 |
| Distinct recipients / assets | 175,295 / 2,040 |
| Total credited value, per-day priced | **≥ $77,364,862** (1,986 assets unpriced) |
| Native share | 17,884.98 ETH = 56.2% of priced value |
| Top ERC-20s | USDG $10.67M, NVDA $3.38M, SPY $3.24M, SPCX $2.54M, GLD $1.77M |
| ETH daily close range | $1,858.81 (08-03) → $2,515.72 (08-21) |
| As-of vs per-day error | +1.65% on the total, **+28.8% over the first 14 days** |
| Buyback-on rate | 1.9% by volume; blended creator rate 69.35 bps vs 70.00 assumed |
| Fee split (uniform, all 125) | hook 100 bps, protocol share 3000 bps → 30/70 |
| Cross-endpoint, 7-day window | AGREE, 80 windows / 400k blocks (6.70%), **0 mismatches**, bound ≤ 3.68% |
| Cross-endpoint, 36-day scan | AGREE, 12 boundary slices only (0.078%), bound **≤ 22.1%** |
| logsBloom | 40/40 pairs, 3,072 logs |

---

## 9. Rules that survive the re-run

These are not style preferences. Each exists because breaking it produced a wrong
answer at least once in this project.

1. **`bigint` minor units. Never floats for amounts.**
2. **Every USD figure carries price provenance**, or it is not a USD figure.
3. **Fail closed over guessing. A missing input renders as an explicit UNKNOWN,
   never zero.** An earlier version printed a table of zeros that read as "no
   market" when the answer was 140.
4. **Do not weaken tests. Do not edit `config/protocol.ts`** — report instead.
   `TERMS.operatorBps` is inside the CREATE2 salt preimage; changing it changes
   every vault address ever predicted.
5. **Quote the floor basis, not the fully-priced subset**, whenever you state a
   population.
6. **A green test suite is not a validated business**, and implying readiness the
   evidence does not support is the most expensive error available here.

---

## 10. What this re-run still will not tell you

**Do not let a clean October run read as a green light. Four things gate the
business and not one of them is closed by any command in this document:**

- **(a) The Section 9 pilot has never been run.** It gates roughly 45% of the
  thesis, and its committed decision rule requires the *point estimate* to clear
  +10% — so against a true +10% effect it fires with probability approaching one
  half **at any sample size**. `requiredCoins(design, 10, 0.8)` returns
  `reachable: false`. **That is a business decision about the threshold, owed
  before the trial runs against a real coin, and no enrolment number fixes it.**
- **(b) No written Anthropic usage-policy determination exists** for operating a
  disclosed AI desk in a public memecoin community under the Finance High-Risk
  clause. The output classifier is this repository's own reading of a policy, not
  a counterparty's agreement that the reading is right.
- **(c) No insurance has been placed and none has been quoted.** Whether an
  uncapped, uninsured operator publishing promotional copy about financial
  instruments to retail is *insurable at all* is an open question, and the
  liability cap in `legal/MSA.md` §18.3 is still `[COUNSEL]`.
- **(d) The win rate and the fixed cost still have zero observations.** The
  verdict needs a 14.8% win rate at 73 winnable coins. Nobody has ever signed a
  client.

**And three measurement limits no window length fixes:** the coin basis over the
full history needs a ~53M-log join this endpoint cannot serve; tenure is measured
on **recipients**, not coins; and both endpoints run the **same client family
(nitro)**, so a common-mode index defect would agree perfectly on both sides and
be invisible at any sample size.
