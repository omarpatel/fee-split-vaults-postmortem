import { BAND_EDGES_CENTS, bandBalance } from '../domain/lag.js'
import { Figure } from './primitives.js'

/**
 * Banded balances.
 *
 * A balance tells a reader how much dry powder is left, which is a purchasing
 * calendar in disguise. Every public balance is therefore snapped to a fixed
 * ladder and rendered as a range. The ladder is shown alongside the value, not
 * hidden: a range whose bucketing is secret is not a disclosure, it is a hint.
 *
 * Zero is reported exactly and on purpose. "This budget is empty" gives away no
 * future purchase and is something both the dev and the public are owed.
 */

export function BandedBalanceCard({
  label,
  cents,
  observedAtUnix,
  note,
}: {
  label: string
  cents: bigint
  observedAtUnix: number
  note: string
}) {
  const banded = bandBalance(cents, observedAtUnix)
  const activeIndex = banded.band.index

  return (
    <div className="figure">
      <span className="figure-label">{label}</span>
      <span className="figure-value band">{banded.label}</span>
      <div className="band-rail" aria-hidden="true">
        {BAND_EDGES_CENTS.map((edge, index) => (
          <span
            key={String(edge)}
            className={`band-tick${index === activeIndex ? ' is-active' : ''}`}
          />
        ))}
      </div>
      <span className="figure-sub">
        as of {new Date(banded.observedAtUnix * 1_000).toISOString().slice(0, 13).replace('T', ' ')}
        :00 UTC
      </span>
      <span className="figure-note">{note}</span>
    </div>
  )
}

export function BandExplainer() {
  return (
    <div className="card-flat small muted">
      <strong>Why balances are shown as ranges.</strong> An exact procurement balance, refreshed
      live, tells anyone watching how much this coin is about to be able to spend and roughly when.
      Balances are snapped to a fixed 1–2–5 ladder and timestamps to the hour, so the page still
      answers &ldquo;is there budget?&rdquo; without answering &ldquo;how much, exactly, right
      now?&rdquo;. Executed spend, by contrast, is published to the cent: money that has already
      left cannot be front-run.
    </div>
  )
}

export function FeeLegFigure({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note: string
}) {
  return <Figure label={label} value={value} note={note} />
}
