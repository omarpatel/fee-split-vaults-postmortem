# Runbook: stranded escrow after a recipient transfer

**Alerts:** `vault_recipient_transferred` (page), `venue_recipient_change_timelock_firing` (page),
`escrow_sweep_stalled` (page), `sweep_shortfall` (ticket)
**Auto-action:** `freeze_new_authorizations` on the affected vault

A coin's creator-fee recipiency has moved away from our vault, or is about to.
Two distinct causes, same shape:

- **The dev moved it.** They pointed the creator fee recipient somewhere else.
  That is their right; it ends the arrangement and it is not a security incident.
- **The Venue owner moved it.** `CreatorFeeRecipientChangeProposed` behind a
  timelock, executed by the platform. Neither we nor the client chose this.

The dangerous part is the same either way. The Venue V2 fee escrow at
`0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` is **`msg.sender`-only with no
claim-on-behalf**, and its credits key by `(recipient, quoteAsset)` with no coin
identifier. Once recipiency moves, anything already credited to the old recipient
can only be withdrawn by that recipient. If the old recipient was our vault, the
vault can still claim it. If the recipiency was transferred *to* our vault and
then away again, whatever is credited to the intermediate address is not
addressable by us at all.

## Detection

- The chain watcher raises `vault_recipient_transferred` on a
  `CreatorFeeRecipientTransferred` for a token bound to an `ACTIVE` vault.
- `venue_recipient_change_timelock_firing` fires up to 24h before a platform
  proposal becomes executable. That window is the whole opportunity to respond.
- Circumstantial evidence that arrives first: fee accrual for a coin goes flat
  while its Venue-pool volume does not, and `escrow_sweep_stalled` follows a day
  later.

```bash
node ops/scheduler/status.js asset --address "$ASSET"
node ops/scheduler/status.js unmatched-sweeps
```

## Immediate actions

1. **Claim what is still claimable, now.** If the vault is still the recipient
   for any credited balance, sweep it before anything else changes. This is the
   one step where minutes matter.

   ```bash
   node ops/scheduler/status.js jobs   # is escrow.sweep healthy?
   ```

   The value trigger should already have fired. If a lease is stuck, see
   `unlock` below - but read the warning in the command list first.

2. **Confirm the freeze landed.** New spend authorizations for that vault must
   stop: budget accrual has stopped, so authorizing against it would be spending
   money that is no longer arriving.

   ```bash
   node ops/scheduler/status.js freezes
   ```

3. **Establish which address holds the credit.** Do not guess from an aggregator.
   Read `CreatorFeeRecipientTransferred` and the escrow's credit mapping at a
   pinned block, through the two-provider quorum.

4. **Do not attempt recovery through any other address.** There is no
   claim-on-behalf. Any scheme that routes a client's fees through an operator
   address is custody, and this protocol does not custody the dev's money. If the
   credit sits at an address we do not control, the answer is that it sits there.

5. **Tell the client the same hour**, with the amount, the block, and what is and
   is not recoverable. If the dev did this deliberately, this is also the
   termination conversation.

## Decision points

- **Was the transfer authorised by the dev?** Compare the transaction sender
  against `vault_consent.dev_signer` and `dev_payout`. If it matches, treat it as
  a client-initiated termination: stop the service, refund the unspent
  procurement budget, and issue a final report. If it does not, this is a
  compromise of the dev's key and the client needs to hear that specifically.
- **Is this the platform's timelock rather than the client?** Then the client is
  the victim too. Say so plainly, and record it in the weekly report. It is also
  a platform-risk data point: recipiency we do not control is a structural
  exposure of this whole business, and a second occurrence should change what we
  are willing to promise.
- **Is the stranded amount material to the client?** Below a few dollars, the
  gas to chase it may exceed it - especially after the chain gas subsidy lapses
  (~29 Sep 2026). Say that honestly rather than performing a recovery that costs
  more than it returns.
- **Should the vault be terminated?** Only after the final sweep and settlement.
  Terminating first strands the dev's own claimable leg behind a state the
  contract may not allow to move.

## Commands

```bash
# 1. What the operations plane thinks is happening.
node ops/scheduler/status.js jobs
node ops/scheduler/status.js freezes
node ops/scheduler/status.js dead-letters --job escrow.sweep

# 2. Everything still credited to this vault, by asset.
psql "$DATABASE_URL" -c "SELECT asset, account, balance_minor FROM ledger_balance WHERE vault = '$VAULT' AND balance_minor <> '0';"

# 3. The sweep history and whether each one three-way matched.
psql "$DATABASE_URL" -c "SELECT sweep_id, asset, claimed_minor, completed_at_unix, matched_at_unix FROM escrow_sweep WHERE vault = '$VAULT' ORDER BY completed_at_unix DESC LIMIT 20;"

# 4. A wedged lease from a crashed worker. DANGEROUS: releasing a live lease
#    lets a second worker run the same scope, and only the idempotency record
#    stands between that and a second claim. Check `locks` for `expired = t`
#    first, and prefer waiting for the lease to lapse.
node ops/scheduler/status.js locks
node ops/scheduler/status.js unlock --key "lock:escrow.sweep:$VAULT#$ASSET" --by "$OPERATOR" --i-understand

# 5. Once the situation is understood, clear the freeze deliberately.
node ops/scheduler/status.js unfreeze --id "$FREEZE_ID" --by "$OPERATOR"
```

## Afterwards

- Every stranded cent appears in that client's next weekly report as a line item,
  with the block hash. Not in a footnote.
- If a platform timelock caused it, write the incident up for the threat model:
  recipiency the launchpad can move is the single largest uncontrollable risk in
  this business, and the evidence for that should be ours rather than anecdotal.
