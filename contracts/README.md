# Fee split vaults: Solidity layer

The on-chain half of a creator-fee vault protocol: each token's creator fees are
credited to its own vault and split by a parameterised share.

Everything here exists to make three claims true *structurally* rather than by
policy, because policy is what you audit and structure is what you verify:

1. **The protocol never custodies the dev's money.** The dev leg is pull-only by
   the dev's own address, and no operator key path reaches it.
2. **Settlement performs no swap, wrap, or conversion.** Asset in equals asset
   out on the dev leg. This is the unlicensed-money-transmission defence.
3. **There is no third-party payee anywhere.** Budget disbursement is a
   reimbursement to the operator's own treasury, because the operator buys all
   media as principal in its own name.

```
forge build
forge test
forge test --match-path 'test/invariant/*' -vvv
```

Foundry only. `src/` imports nothing external — `SafeTransferLib`,
`SignatureLib`, and `ConsentLib` are vendored minimal pieces, not OpenZeppelin.
`lib/forge-std` is vendored source (not a submodule) so the repo builds with no
network access. Solidity 0.8.24, `evm_version = paris`, `via_ir = true`.

---

## Contracts

| Contract | Role | Mutability |
|---|---|---|
| `VaultFactory.sol` | CREATE2 prediction, EIP-712 consent, deployment | No owner, no upgrade, no admin key |
| `VaultDeployer.sol` | Holds `CoinVault` init code; deploys for the factory only | Immutable, single caller |
| `CoinVault.sol` | One per token. Legs, state machine, payouts | No owner, no upgrade, no pause |
| `VenueAdapter.sol` | Pinned Venue integration shim, fixed selector set | Immutable, no generic call |
| `Registry.sol` | Service record: tier, screening verdict, consent hash | Operator-written, append-only |
| `ReceiptLog.sol` | Procurement receipts and delivery predicates | Operator-written, append-only |

`Registry` and `ReceiptLog` **affect service and evidence, never funds**. That is
structural: neither has a payable function, a `receive`, a `fallback`, or any
external call, and nothing in `CoinVault` reads either of them.

### Why `VaultDeployer` exists

`new CoinVault{salt: ...}()` embeds the vault's entire init code in whichever
contract performs it. Doing that inside `VaultFactory` pushed the factory over
the EIP-170 24,576-byte limit and, more importantly, would have left future
audit fixes competing for a few hundred spare bytes in a contract that must
never be casually redeployed. Splitting it gives both several kilobytes of
headroom. CREATE2 addresses derive from the **deployer's** address, so
`predictVault` hashes `deployer`, not `factory`.

---

## The salt is the entire agreement

```
salt = keccak256(abi.encode(consent))
```

Every economic term — `operatorBps`, `budgetBpsMax`, `adapter`, `referrer`,
`referrerBps`, `devPayout`, `termsHash`, `token` — is inside that preimage.

Consequently **repricing an existing customer is not forbidden, it is
unrepresentable.** A different rate is a different salt is a different address.
The vault at the old address cannot be redeployed, and the vault at the new
address is a contract the dev never pointed fee recipiency at. There is no admin
function to change a rate because there is no address at which a changed rate
could live.

`deployUnsigned` normalises `operatorBps = 0` and `budgetBpsMax = 0` **before**
computing the salt, so a free splitter deliberately lands at a different address
than the paid vault for otherwise-identical terms.

`VaultFactory` additionally imposes structural ceilings — `MAX_OPERATOR_BPS =
2000`, `MAX_BUDGET_BPS_MAX = 5000` — so no signed consent can ever create a vault
above them. `config/protocol.ts` flags `operatorBps` as the most likely-wrong
number in the repo; the contract refuses to be the place where that mistake
becomes permanent. Exceeding a ceiling requires a new factory, which changes
every future vault address and is exactly as visible as it should be.

---

## The one-line split rule

```solidity
if (_state != VaultState.ACTIVE || asset == launch token) -> 100% to the dev leg
```

Everything the specification asks for about `UNBOUND`, `PASSTHROUGH`,
`TERMINATED`, `POISONED`, `SUSPENDED`, and the launch token falls out of that
single branch rather than a table of special cases. That is why there is no state
in which the operator can be paid by accident.

The four legs are `dev`, `budget`, `operator`, `referrer`. The referrer leg is a
**sub-account of the operator leg**, carved out of the operator's own slice and
never out of the client's — `test_referralNeverDilutesTheDev` pins that. The dev
leg absorbs the integer-division remainder, so rounding can only ever favour the
client and the four legs sum exactly.

### State machine

```
UNBOUND ──bind()──> BOUND ──acceptService()──> PENDING ──activate()──> ACTIVE
   │                                                                    │  ▲
   │                                                          suspend() │  │ resume()
   │                                                                    ▼  │
   │                                                                SUSPENDED
   └──────────────────────────────┬─────────────────────────────────────┘
                                  │
      terminate() ──> TERMINATED  │  disclaim() / operatorWithdraw() ──> PASSTHROUGH
                                  │  poison() ──> POISONED
```

Charging happens only in `ACTIVE`. Activation requires **both** parties: the dev
calls `acceptService`, the operator calls `activate`.

---

## The three fixes that could not be added later

**(a) `setAdapter` is DEV-callable, on a 14-day timelock.** The Venue ABIs are
unpublished. A frozen adapter in a non-upgradeable vault would strand the dev's
entire fee stream forever, with nobody able to fix it. Giving the migration right
to the dev removes the hostage situation: the party whose money is at risk is the
party who can rescue it. It stays available in terminal states, because a
`TERMINATED` vault still needs to claim residual escrow credit at 100% to the dev.

**(b) `terminate()` succeeds unconditionally.** It stops charges, freezes the
budget for immediate refund, flips to passthrough, and *then* attempts the
recipiency handback inside `try/catch`, ignoring the result. A third party's
access control never gates our own exit. Tested against both a locked Venue
registry and a fully broken adapter.

**(c) `operatorWithdraw()` exists.** Firing a client is as unconditional for the
operator as terminating is for the dev, on the 14-day notice from `TERMS`.
Execution after the notice elapses is **permissionless**, so an operator cannot
give notice, keep charging, and never execute the exit it announced.

---

## The eight invariants

`test/invariant/` is the primary audit objective, not reentrancy hunting. The
handler drives four assets — a 6-decimal quote token, a WETH mock, the native
sentinel `address(0)`, and the launch token — through every reachable state
including the terminal ones.

| # | Property | Where asserted |
|---|---|---|
| **I1** | `balanceOf(vault, asset) >= dev + budget + operator + referrer`, per asset, after every call | `invariant_I1_*` |
| **I2** | `settle()` performs no swap/wrap/conversion; asset in equals asset out on the dev leg | `invariant_I2_*` |
| **I3** | No code path moves `devClaimable` to any address other than `devPayout` | `invariant_I3_*` |
| **I4** | `pullBudget` sends only to the operator treasury; no third-party payee in any function | `invariant_I4_*` |
| **I5** | `operatorBps` is immutable; the live ceiling is monotone toward zero | `invariant_I5_*` |
| **I6** | Any launch-token balance credits 100% to `devClaimable` | `invariant_I6_*` |
| **I7** | `bind()` reverts if already bound | `invariant_I7_*` |
| **I8** | A vault with `operatorBps == 0` remains a fully functional dev-withdrawable splitter | `invariant_I8_*` |

Notes on how a few of these are made falsifiable rather than tautological:

- **I2** is structural for `settle()`: that function makes no external call at
  all beyond `balanceOf`, and moves no tokens. It cannot convert because it never
  calls anything that could. The suite additionally asserts the WETH mock's
  `depositCalls`/`withdrawCalls` counters never move, and that a payout in asset
  A leaves every other asset balance untouched.
- **I3** is enforced by signature: `withdrawDev` and `pushDev` have **no address
  parameter**. The destination is an immutable. The suite proves it empirically
  with a conservation equation over the whole consented address set, deliberately
  *excluding* the calling handler so that a "pay `msg.sender`" bug is visible
  rather than absorbed.
- **I4** is likewise enforced by signature — `pullBudget(address,uint256,bytes32,bytes)`
  has nowhere to put a payee — and there is an invariant asserting that selector
  never changes shape.

### Why the handler counts violations instead of asserting them

An `assertEq` inside an invariant handler **reverts**, and under
`fail_on_revert = false` the fuzzer treats a reverting handler call as an
uninteresting no-op. Worse, the revert rolls back the very state change that
proved the bug, so the evidence destroys itself.

This is not theoretical. Mutation testing caught exactly that: a vault mutated to
pay the caller instead of `devPayout` went **undetected** by the first version of
this suite. Violations therefore increment a ghost counter and let the call
stand; the invariant functions assert those counters are zero.

### Mutation results

The suite was validated by deliberately breaking the vault and confirming a test
fails. All of these are caught:

| Mutation | Caught by |
|---|---|
| Dev leg pays `msg.sender` instead of `DEV_PAYOUT` | I3 (both the counter and conservation) |
| `resume()` restores the operator ceiling after a freeze | I5 monotonicity |
| `pullBudget` funded from the dev leg | I4 attribution |
| `pullBudget` skips the leg decrement | I1 solvency |
| Launch token gets charged | I6 |
| `SUSPENDED` still charges | I5 (charging-state) + unit |
| Rounding remainder handed to the operator | `testFuzz_splitIsExactAndDevAbsorbsTheRemainder` |
| `terminate()` blocked when handback reverts | fix-(b) unit tests |

Reaching the `resume()` mutation required giving `sanctionsFreeze` its own
reachable handler action — it is the only way to zero the ceiling while leaving
the vault `ACTIVE`, which is the exact sequence that bug needs. If you extend the
handler, check that new states are actually reachable rather than assuming they are.

---

## What an auditor should attack

Ranked by where I think the real risk is.

**1. The adapter is the residual trust.** This is the sharpest edge in the
design. The dev may install an arbitrary adapter contract on a 14-day timelock,
and `CoinVault` then executes `(target, calldata)` that the adapter constructs.
The guards, none of which a new adapter can relax:

- target is never a ledgered asset, never the launch token, never the vault itself
- target must have code
- a hardcoded selector deny-list — `approve`, `permit`, `setApprovalForAll`,
  `transfer`, `transferFrom`, all `safeTransferFrom` arities, `increase/decreaseAllowance`
- value is always zero
- the adapter's own `isPinnedSelector` must accept the selector (via `staticcall`, so a
  hostile adapter that reverts fails closed)
- **post-call solvency across every registered asset**

The reasoning: an *immediate* extraction trips the solvency check, and a
*deferred* one requires an approval, which the deny-list blocks. Attack that
argument. Is there a primitive that moves value later without an ERC-20 approval
selector and without failing solvency now? ERC-777 hooks, ERC-1363, a token with
a non-standard allowance setter, a callback-registering target. If you find one,
it is a real finding.

The accepted trade: the alternative is a frozen adapter in a non-upgradeable
vault against unpublished ABIs, which strands the dev's whole stream forever.
That is strictly worse. Note also that the blast radius is the operator leg and
the budget — the dev, who controls the adapter, can already withdraw the dev leg
and terminate at will.

**2. Asset balances that go down.** Every approved quote asset on chain 4663 is
an upgradeable, pausable, issuer-controlled proxy. `settle()` recognises income
as `balance - accounted`, which is correct for fee-on-transfer and for
non-standard returns. It is **not** robust to an implementation upgrade that
*reduces* balances (a negative rebase, a blacklist-and-burn). In that case
`balance < accounted` and payouts become first-come-first-served until the
balance is exhausted. No leg is mis-attributed and nothing is stolen, but the
shortfall is not shared pro-rata. `checkSolvency(asset)` exposes this on-chain
for monitoring, and the per-asset kill switch lives off-chain in the asset
registry. **Rebasing assets are unsupported and must never be approved.**

**3. The known-asset registry is griefable to full.** Capped at 64 and populated
on first nonzero credit. An attacker can fill it with worthless tokens. It fails
*open* on purpose — registration is skipped rather than reverting — because
reverting would brick `settle` for a real quote asset, which is strictly worse.
Nothing that moves money depends on membership: every money-moving function is
per-asset and takes the asset as an argument, and `checkSolvency` works for any
asset registered or not. The only degradation is that an unregistered asset is
outside the post-adapter-call solvency loop. Convince yourself that is the whole
consequence.

**4. Reentrancy on native payouts.** `withdrawDev(address(0), …)` forwards all gas
to a contract `devPayout`. Without a lock, a reentrant `settle()` would observe
the pre-transfer balance against post-decrement legs and credit the same money
twice. There is a single shared `nonReentrant` lock and
`test_reentrantDevPayoutCannotDoubleCredit` pins it. Note that `sweep()` is
deliberately **not** `nonReentrant` — it isolates each asset behind an external
self-call so one paused proxy cannot block the others — so check that every path
it reaches takes the lock individually.

**5. The escrow ABI is a guess.** `IVenueExternal.sol` is a pin derived from
on-chain verification, not a published spec. It is the single most likely thing
in this repository to be wrong, which is exactly why it sits behind
`IVenueAdapter` and why fix (a) exists.

**6. Timelock constants are duplicated.** Solidity cannot import
`config/protocol.ts`, so `DIAL_LOWER_NOTICE`, `OPERATOR_NOTICE`,
`ADAPTER_TIMELOCK`, `PROOF_WINDOW`, and `DEAD_MAN` are mirrored.
`test_timelockConstantsMirrorProtocolTerms` is the seam that fails if the two
sides drift.

**7. `bindWithSig` replay.** Replay protection is the one-shot state check, not a
nonce. A signature for a token that was never bound stays valid until the vault
is bound or exits. Consider whether that matters given `bind` is also gated on
`TOKEN_HINT`.

---

## Deliberate design decisions worth arguing with

- **The operator treasury is immutable.** Rotating it requires a new factory,
  which changes every future vault address. An operator key compromise therefore
  costs the operator its own revenue and can never reach a dev leg. The
  alternative — a mutable payee — makes I4 weaker for no real security gain,
  since a compromised key can already withdraw to the legitimate treasury.
- **`refundUnproven` is aggressive.** Budget sitting unspent past the 7-day proof
  window returns to the dev leg, permissionlessly, and immediately after any exit.
  A healthy account that keeps a buffer will be swept roughly weekly. That is
  churny but correct: `pullBudget` happens at commitment time, so the budget leg
  only ever holds *uncommitted* funds, and uncommitted client money belongs to
  the client.
- **`salvage` is restricted to `POISONED`.** Unrestricted, anyone could route the
  operator's earned share away by choosing which function to call. In a live
  vault, `settle` is the correct entry point.
- **The dead man releases the operator leg to the dev.** After 180 days of total
  operator silence, earned operator and referrer balances would otherwise be
  stranded forever. They move to the dev leg — **except when frozen**, because
  the dead man exists to prevent stranding, not to launder a sanctions freeze.
- **`pushDev` is permissionless.** The destination is the same immutable, so
  pushing the dev's own money to the dev's own address is not an attack. It
  exists so a `devPayout` that cannot originate transactions (a multisig
  mid-migration, an exchange deposit address) can never strand its own funds.
- **The vendor countersignature is evidence, not authority.** Verifying a vendor
  key on-chain would require a vendor registry, and a registry that can block a
  fund movement is an admin key on every vault by indirection. `pullBudget`
  records `keccak256(countersig)` and marks the invoice used; it does not check a
  signer.

---

## Operational notes, from the on-chain verification pass

These are behaviours of the deployed Venue system that the contracts accommodate
but cannot enforce. They belong in the runbook.

- **Claim in bounded amounts.** Some approved quote assets impose per-transfer
  caps. `claimToken(asset, maxAmount)` takes a caller-supplied ceiling; repeat it.
  `sweep()` uses an unbounded claim and simply logs the failure for a capped asset.
- **Residual escrow credit does not follow recipiency.** After `terminate()`, any
  credit already banked under the vault's address stays there. The vault remains
  fully able to `claim()` and `settle()` afterwards, at 100% to the dev — but
  someone has to call it. Sweep to zero as part of offboarding.
- **Per-coin attribution cannot come from escrow events.** Post-graduation all
  clients share one depositor and no escrow event carries a coin identifier.
  Drive per-coin receipts off the hook's `PoolFeesSwept(poolId, …)` and map
  `poolId` to token. The `Credited` event here is the vault-side counterpart.
- **Monitor `CreatorFeeRecipientChangeProposed`.** The Venue owner holds a 3-day
  timelocked override to reassign any coin's fee recipient. It is not addressable
  from these contracts; it is an off-chain alarm with a 3-day response window.
- **`transferCreatorFeeRecipient` is immediate and has no timelock**, and is
  self-service by the current recipient. A dev who moves recipiency away mid-
  engagement simply stops the stream; nothing here can or should prevent that.
- **`launchEnabled` can be closed by the owner with no timelock.** Launching is
  permissionless today. Do not build a funnel that assumes it stays that way.
- **The anti-snipe tax is an open policy question.** It is 99% at t=0, decays
  over ~3 seconds, and flows to the fee recipient along normal rails. If it
  arrives denominated in the **launch token**, I6 exempts it and 100% goes to the
  dev. If it arrives in the **quote asset**, the current code charges it like any
  other fee. That will look like a windfall and generate support tickets.
  The clean operational mitigation is to `activate()` only *after* the anti-snipe
  window — charging happens exclusively in `ACTIVE`, so a vault bound and pending
  through launch credits the entire windfall to the dev. Decide this before
  onboarding the first greenfield launch.

---

## Test layout

```
test/
  BaseTest.sol              shared fixture; TERMS-mirroring parameters
  mocks/Mocks.sol           pausable/capped/returnless ERC20, msg.sender-only escrow,
                            lockable fee registry, hostile and reverting adapters,
                            reentrant devPayout, ERC-1271 wallet
  unit/
    VaultFactory.t.sol      CREATE2 prediction, salt coverage, anti-repricing,
                            signature handling, ceilings, deployUnsigned
    CoinVaultState.t.sol    every transition, bind one-shot, the three fixes,
                            sanctions freeze, dead man
    CoinVaultAccounting.t.sol  the split, payout destinations, budget, salvage,
                            capped/paused/returnless assets, native, adapter guards,
                            reentrancy
    Timelocks.t.sol         dial, adapter migration, operator notice, constant pinning
    VenueAdapter.t.sol       fixed selector set, no generic call surface
    Ledgers.t.sol           Registry and ReceiptLog append-only, never-funds
  invariant/
    VaultHandler.sol        bounded actions, ghost totals, violation counters
    Invariants.t.sol        I1 through I8
```

102 tests. `forge test`.
