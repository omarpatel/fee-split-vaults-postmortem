# CurveBuy / CurveSell parameter names, pinned from live chain evidence

**Verdict: ESTABLISHED.** Captured 15 September 2026 against chain 4663 (head
64,173,920), read-only over JSON-RPC. 175 curve trade logs (117 `CurveBuy`,
58 `CurveSell`) across 27 per-launch curves, every one joined to its
transaction and receipt. One mapping holds on all 175 without a counter-example:

| slot | name | evidence |
| --- | --- | --- |
| topic1 (`address indexed`) | `sender` | msg.sender of the curve call: equals `tx.from` on direct calls (53 buys, 33 sells) and equals `tx.to` when a router / wallet contract made the call (57 buys, 24 sells) |
| topic2 (`address indexed`) | `trader` | the launched token `Transfer` in the same receipt goes curve → topic2 for exactly word1 on **117/117** buys and topic2 → curve for exactly word0 on **58/58** sells |
| word0 | `amountIn` | buy: gross quote paid. `tx.value == word0` on **53/53** direct native buys; `tx.value − word0 == 0.0005 ETH` (the launch fee) on **20/20** launch-transaction buys; an ERC-20 quote `Transfer` of exactly word0 into the curve on **12/12** ERC-20-quote buys. sell: launched token sold (the 58/58 Transfer above) |
| word1 | `amountOut` | buy: launched token received (117/117 above). sell: NET quote paid to the trader: `balance(block) − balance(block−1) == word1 − gasUsed·effectiveGasPrice` on **32/32** direct native sells; ERC-20 quote `Transfer` curve → trader of exactly word1 on **9/9** ERC-20 sells |
| word2 | `fee` | `== gross × 100 / 10 000` on **58/58** sells and **99/117** buys; the other 18 buys are all within 17 blocks of launch and carry 7.18 % or 1.19 % (anti-snipe surcharge, see below). Never below 1.00 % |
| word3 | `creatorTax` | `== gross × creatorTaxBps / 10 000` on **175/175**, with `creatorTaxBps` read from `factory.getLaunchedToken(token)` word 8. Sample spans 0, 100, 150, 200, 300, 330, 500, 1000 bps |

`gross` is word0 on a buy and `word1 + word2 + word3` on a sell: the sell pays
the trader net of both fee and creator tax, and both are computed on the gross.

The hypotheses the probe was asked to test and did **not** survive:

- topic1 / topic2 = token or curve: **0/175** for either slot. Both slots are
  always EOAs or caller contracts; the curve is the log emitter and the token is
  only reachable through `getLaunchedToken`.
- word3 = reserve / supply after the trade: rejected. It is not monotone across
  consecutive trades on one curve (it is zero on every zero-tax curve and scales
  with each trade's own size) and it equals `gross × creatorTaxBps / 10 000`
  exactly.
- `fee == amountIn × creatorTaxBps / 10 000`: rejected on every non-zero-tax
  curve; that relation belongs to word3.

Raw logs, transactions, the ERC-20 transfers of each receipt, the balance
deltas and the `getLaunchedToken` return data are in
`tools/__tests__/fixtures/curve-trade-live-logs.json`. Every relation above is
re-derived from that fixture by
`packages/indexer/src/__tests__/curve-shape.spec.ts`; renaming `fee` and
`creatorTax` in `abi.ts` fails two of its assertions, so the names cannot drift
silently.

## What the pin does and does not claim

It claims the event's six slots carry the quantities named above. It does NOT
claim who ultimately receives `fee` or `creatorTax`: the curves are unverified on
Sourcify and neither leg leaves the curve as a transfer at trade time (the ERC-20
sells show only the net quote leaving). The indexer therefore still credits the
creator through `creatorShareOfFee(fee, …)` and does not credit `creatorTax`.

**Discrepancy to resolve outside this pin.** `config/protocol.ts creatorNetBps`
models the creator tax as `hookFeeBps × creatorTaxBps / 10 000` — a slice of the
1 % fee. On chain, `creatorTax` is `creatorTaxBps` of the gross **volume**:
curve `0x7ec83e7c…` (tax 500 bps) charged 0.005 ETH of creator tax on a
0.1 ETH buy, a hundred times the config's figure. The config direction
under-credits, which is the fail-closed direction, but a tier gate reading
curve-phase QF will be wrong by that factor until the config and
`creatorShareOfFee` are reconciled against verified curve source or an escrow
credit trace.

## Counter-examples examined

- **18 early buys with fee > 1 %.** All lie 2–17 blocks after launch: 7.18 % at
  2–9 blocks (13 logs), 1.19 % at 12–17 blocks (5 logs). `creatorTax` is still
  exact on every one, so the surcharge is inside the fee word only. This is the
  anti-snipe schedule `classifyFee` already models; every 7.18 % log classifies
  as `anti_snipe_window` by rate, and no ordinary 1 % trade does.
- **37 native buys where `tx.value ≠ word0`.** 20 are launch transactions
  (value − word0 is the 0.0005 ETH launch fee on all 20); the remaining 17 go
  through a router or wallet contract (`tx.to == topic1` on 16, one call
  deeper on 1) that funds part of the buy from its own balance or receives a
  refund. None contradicts word0: the direct calls and the ERC-20 quote
  transfers fix it exactly.
- **28 buys and 25 sells with `trader ≠ tx.from`.** `topic1` is then a
  contract other than the signer (the one the EOA called, `tx.to`, on 46 of the
  53; one call deeper on 7) and the launched token still moves to / from `topic2`, so
  `trader` is the beneficiary rather than the transaction signer. Attribution
  reports `trader` as the counterparty for that reason.
- **Fee and creator tax on ERC-20 sells are not transferred out** in the same
  receipt (0/9 have a curve → anyone transfer of word2 or word3). They accrue in
  the curve; only the net leg is paid. Consistent with the mapping, not evidence
  of it.

Not observed in the sample: any curve with `buybackEnabled = 1` (27/27 off), any
curve past phase 0, any trade on a curve whose quote is not native ETH or the
two ERC-20 quotes `0x5fc5360d…` and `0x4a0e65a3…`.

## Sample

| | logs | curves | direct EOA calls | via contract | ERC-20 quote |
| --- | --- | --- | --- | --- | --- |
| CurveBuy | 117 | 27 | 53 | 64 | 12 |
| CurveSell | 58 | 21 | 33 | 25 | 9 |

Launch windows scanned on the factory: blocks 64,167,921–64,169,920 and
64,169,921–64,171,920 (37 `TokenLaunched`, 27 with at least one trade in the
2,000 blocks after launch). 472 RPC calls in total (39 `eth_getLogs`, 27
`eth_call`, 171 + 171 `eth_getTransactionByHash` / `eth_getTransactionReceipt`,
64 `eth_getBalance`), throttled to one call per 1.25 s.

## Reproduce

Endpoints: `https://rpc.mainnet.chain.robinhood.com` (primary; needs a browser-ish
`User-Agent` or it answers 403, and its `eth_getBalance` is non-archival past a
few hundred blocks) and `https://rpc.ordofi.network` (secondary; served the
historical balances). Both are the defaults in `packages/fleet/src/adapters.ts`.
Stay under one request per second.

```sh
RPC=https://rpc.ordofi.network
call() { curl -s "$RPC" -H 'content-type: application/json' -H 'user-agent: curl/8.4.0' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"; }

# 1. Curves: TokenLaunched(token indexed, curve indexed, deployer indexed, ...) on the factory.
call eth_getLogs '[{"fromBlock":"0x3d327c1","toBlock":"0x3d32f90",
  "address":"0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  "topics":["0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607"]}]'
# topic1 = token, topic2 = curve, data word0 = pairToken (zero address = native ETH).

# 2. Trades on one curve, bounded to 2,000 blocks from its launch block.
call eth_getLogs '[{"fromBlock":"0x3d3292e","toBlock":"0x3d330fd",
  "address":"0x3331fea92ab47b30c0f4f3e0c1d30f904e72af93",
  "topics":[["0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455",
             "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df"]]}]'

# 3. creatorTaxBps: factory.getLaunchedToken(token), word 8 of the 15-word return.
call eth_call '[{"to":"0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  "data":"0x3cf28b5a000000000000000000000000d391f352ff2d2210e80754f95cb9e99f1d8f3ef1"},"latest"]'

# 4. Per log: the transaction, its receipt (ERC-20 Transfer topic0
#    0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef) and, for a
#    direct native sell, the trader balance before and after.
call eth_getTransactionByHash '["0xaa3891c40894db0a88e7f1c00f6746de5f58bf74371fcf062f1c933d49f4f051"]'
call eth_getTransactionReceipt '["0xaa3891c40894db0a88e7f1c00f6746de5f58bf74371fcf062f1c933d49f4f051"]'
call eth_getBalance '["0xf34ce55efe8e267bec20d407b0c163ae10f06644","0x3d329c2"]'   # block − 1
call eth_getBalance '["0xf34ce55efe8e267bec20d407b0c163ae10f06644","0x3d329c3"]'   # block
```

Worked examples from the fixture (all amounts in wei / token base units):

- Direct native buy, curve `0xfef1be22…` (tax 100), tx `0xb1759886…`, block
  64,171,001: `tx.from = sender = trader = 0x0f03e95e…`, `tx.value =
  351,751,066,677,435 = amountIn`; launched-token Transfer curve → trader
  `205,146,028,700,092,559,728,665 = amountOut`; `fee = 3,517,510,666,774 =
  amountIn / 100`; `creatorTax = 3,517,510,666,774 = amountIn × 100 / 10 000`.
- Launch-transaction buy, curve `0x65b5c277…` (tax 200), tx `0x043d3e63…`:
  `sender = 0xe33e9e47…` (the launcher contract, `tx.to`), `trader = tx.from =
  0x7023c910…`, `tx.value − amountIn = 26,152,624,188,800,000 −
  25,652,624,188,800,000 = 500,000,000,000,000`; `fee = amountIn / 100`,
  `creatorTax = amountIn × 2 / 100 = 513,052,483,776,000`.
- Direct native sell, same curve, tx `0xaa3891c4…`, block 64,170,435: launched token
  Transfer trader → curve `14,595,162,717,672,786,006,026,528 = amountIn`;
  `amountOut = 24,169,476,476,564,834`, `fee = 249,169,860,583,142`,
  `creatorTax = 498,339,721,166,285`; gross `= 24,916,986,058,314,261`, of
  which fee is `⌊1 %⌋` and creatorTax `⌊2 %⌋`; trader balance delta
  `24,162,576,428,552,834 = amountOut − 6,900,048,012,000 gas`.
- ERC-20 quote sell, curve `0x255b519f…` (tax 0, quote `0x5fc5360d…`), tx
  `0xe05615a6…`: quote Transfer curve → trader `732,884,703 = amountOut`; `fee =
  7,402,875 = ⌊(732,884,703 + 7,402,875) / 100⌋`; no transfer of the fee leaves
  the curve in that receipt.
- Anti-snipe buy, curve `0x02083722…` (tax 100), tx `0x08174dac…`, 7 blocks
  after launch: `fee = 1,587,773,180,771,974 = 7.18 %` of `amountIn =
  22,113,832,601,280,996`, while `creatorTax = 221,138,326,012,809` is still
  exactly 1.00 %.

## What would invalidate the pin

- A `CurveBuy` / `CurveSell` log whose launched-token `Transfer` does not match
  topic2 / word1 (buy) or topic2 / word0 (sell).
- A sell whose `word2 ≠ ⌊(word1 + word2 + word3) / 100⌋`, or any log whose
  `word3 ≠ ⌊gross × creatorTaxBps / 10 000⌋` for the token's current
  `getLaunchedToken` tax.
- A buy with `fee` below 1 % of `amountIn`, or above it later than the launch
  window.
- A new curve implementation (a different `launchConfigId`, a
  `buybackEnabled` curve, a non-ETH quote beyond the two seen) emitting the same
  topic0 with different semantics. The topic pin in `config/protocol.ts` would
  not catch that; only re-running this probe on such curves would.

Re-run the probe and extend the fixture before trusting the names on any of
those.
