import { useEffect, useState, type ReactNode } from 'react'

import { formatUnits, formatUsd, formatUsdCompact, type Cents, type Minor, type PricedUsd } from '../domain/money.js'
import { shortenAddress } from '../crypto/hex.js'
import { formatRelative, isoMinute } from '../domain/time.js'

export function Badge({
  tone = 'neutral',
  children,
  title,
}: {
  tone?: 'neutral' | 'accent' | 'good' | 'warn' | 'bad' | 'related'
  children: ReactNode
  title?: string
}) {
  return (
    <span className={`badge badge-${tone}`} {...(title === undefined ? {} : { title })}>
      {children}
    </span>
  )
}

export function Callout({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'good' | 'warn' | 'bad'
  title: string
  children: ReactNode
}) {
  return (
    <div className={`callout callout-${tone}`}>
      <div className="callout-title">{title}</div>
      <div className="small">{children}</div>
    </div>
  )
}

export function Skeleton({ height = 18, width = '100%' }: { height?: number; width?: string }) {
  return <div className="skeleton" style={{ height, width }} aria-hidden="true" />
}

export function CopyField({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1_600)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <div className="field">
      {label !== undefined && <label>{label}</label>}
      <div className="copyfield">
        <code>{value}</code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
    </div>
  )
}

/**
 * A USD amount. Always rendered from bigint cents, never from a float, and
 * never with its price provenance omitted when it had one.
 */
export function Usd({
  cents,
  compact = false,
  provenance,
}: {
  cents: Cents
  compact?: boolean
  provenance?: PricedUsd
}) {
  const text = compact ? formatUsdCompact(cents) : formatUsd(cents)
  if (provenance === undefined) return <span className="num">{text}</span>
  return (
    <span
      className="num"
      title={`priced by ${provenance.priceSource} at ${new Date(
        provenance.pricedAtUnix * 1_000,
      ).toISOString()}${provenance.blockHash === undefined ? '' : ` · block ${provenance.blockHash}`}`}
    >
      {text}
    </span>
  )
}

export function TokenAmount({
  amount,
  decimals,
  symbol,
  maxFractionDigits = 6,
}: {
  amount: Minor
  decimals: number
  symbol: string
  maxFractionDigits?: number
}) {
  return (
    <span className="num">
      {formatUnits(amount, decimals, maxFractionDigits)} {symbol}
    </span>
  )
}

export function AddressChip({ address, href }: { address: string; href?: string }) {
  const label = shortenAddress(address)
  if (href === undefined) {
    return (
      <code className="addr" title={address}>
        {label}
      </code>
    )
  }
  return (
    <a className="addr" href={href} title={address} target="_blank" rel="noreferrer noopener">
      {label}
    </a>
  )
}

export function Timestamp({ unix, relativeTo }: { unix: number; relativeTo?: number }) {
  const now = relativeTo ?? Math.floor(Date.now() / 1_000)
  return (
    <time dateTime={new Date(unix * 1_000).toISOString()} title={`${isoMinute(unix)} UTC`}>
      {formatRelative(unix, now)}
    </time>
  )
}

export function Figure({
  label,
  value,
  note,
  sub,
  isSource = false,
}: {
  label: string
  value: ReactNode
  note?: ReactNode
  sub?: ReactNode
  isSource?: boolean
}) {
  return (
    <div className="figure">
      <span className="figure-label">{label}</span>
      <span className={`figure-value${isSource ? ' is-source' : ''}`}>{value}</span>
      {sub !== undefined && <span className="figure-sub">{sub}</span>}
      {note !== undefined && <span className="figure-note">{note}</span>}
    </div>
  )
}

type Theme = 'light' | 'dark' | 'system'

const THEME_KEY = 'fee-split-vaults/theme'

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    // Private windows and blocked site data throw on access. Fall through.
  }
  return 'system'
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme)

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      // Not being able to remember a theme is not worth an error state.
    }
  }, [theme])

  const next: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' }
  const label: Record<Theme, string> = { system: 'Auto', light: 'Light', dark: 'Dark' }

  return (
    <button
      type="button"
      className="btn btn-ghost btn-small"
      onClick={() => setTheme(next[theme])}
      aria-label={`Theme: ${label[theme]}. Click to change.`}
    >
      {label[theme]}
    </button>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card-flat" style={{ textAlign: 'center', color: 'var(--ink-muted)' }}>
      <h4 style={{ marginBottom: '0.25rem' }}>{title}</h4>
      {children !== undefined && <div className="small">{children}</div>}
    </div>
  )
}

export function ErrorPanel({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <Callout tone="bad" title="Could not load this">
      <p className="mono tiny">{error}</p>
      <p>
        Nothing on this page is estimated when a load fails. It shows an error rather than a
        plausible number, because on a receipts page the two are not interchangeable.
      </p>
      {onRetry !== undefined && (
        <button type="button" className="btn btn-small" onClick={onRetry}>
          Try again
        </button>
      )}
    </Callout>
  )
}
