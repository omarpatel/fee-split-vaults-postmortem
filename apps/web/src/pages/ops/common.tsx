import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

import { ApiError } from '../../api/client.js'
import { DecodeError } from '../../api/decode.js'
import type { OnboardingRecordView, OnboardingState, OperatorApiClient, OperatorAuth } from '../../api/operator.js'
import { Link } from '../../app/router.js'
import { AddressChip, Badge } from '../../components/primitives.js'

/**
 * What every console page gets from the gate. The bearer is here and nowhere
 * else: not in a URL, not in a prop drilled through the router, not in
 * localStorage where it would outlive the tab.
 */
export interface OperatorContextValue {
  auth: OperatorAuth
  operator: OperatorApiClient
  nowUnix: number
  isDemo: boolean
  signOut: () => void
}

const OperatorContext = createContext<OperatorContextValue | null>(null)

export function OperatorProvider({ value, children }: { value: OperatorContextValue; children: ReactNode }) {
  return <OperatorContext.Provider value={value}>{children}</OperatorContext.Provider>
}

export function useOperator(): OperatorContextValue {
  const value = useContext(OperatorContext)
  if (value === null) throw new Error('useOperator called outside the operator console')
  return value
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export interface Refusal {
  /** The server's machine code, verbatim; null when the failure never reached a server. */
  code: string | null
  status: number | null
  message: string
}

/**
 * The console never paraphrases a refusal. `feature_unconfigured` tells the
 * operator to wire a dependency; `chain_state_mismatch` tells them to look at
 * the chain; "something went wrong" tells them nothing. A decode error is its
 * own kind of refusal: the server answered with a shape this console refuses
 * to render, and that is said in those words.
 */
export function describeRefusal(error: unknown): Refusal {
  if (error instanceof ApiError) {
    const detail = error.code !== null && error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2) : error.message
    return { code: error.code, status: error.status, message: detail }
  }
  if (error instanceof DecodeError) return { code: 'decode_error', status: null, message: error.message }
  return { code: null, status: null, message: error instanceof Error ? error.message : String(error) }
}

export function RefusalPanel({ refusal, title = 'Refused' }: { refusal: Refusal; title?: string }) {
  return (
    <div className="callout callout-bad" role="alert">
      <div className="callout-title">
        {title}
        {refusal.status !== null && <span className="faint"> · {refusal.status}</span>}
      </div>
      <div className="small">
        {refusal.code !== null && (
          <p style={{ margin: 0 }}>
            <code className="refusal-code">{refusal.code}</code>
          </p>
        )}
        <p className="mono tiny" style={{ margin: 0 }}>
          {refusal.message}
        </p>
      </div>
    </div>
  )
}

/** One async action, with its in-flight and refused states, for a button to bind to. */
export function useAction<T>(): {
  busy: boolean
  refusal: Refusal | null
  result: T | null
  run: (work: () => Promise<T>) => Promise<T | null>
  clear: () => void
} {
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [result, setResult] = useState<T | null>(null)

  const run = useCallback(async (work: () => Promise<T>): Promise<T | null> => {
    setBusy(true)
    setRefusal(null)
    try {
      const value = await work()
      setResult(value)
      return value
    } catch (error: unknown) {
      setRefusal(describeRefusal(error))
      return null
    } finally {
      setBusy(false)
    }
  }, [])

  const clear = useCallback(() => {
    setRefusal(null)
    setResult(null)
  }, [])

  return { busy, refusal, result, run, clear }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

const STATE_TONES: Readonly<Record<OnboardingState, 'neutral' | 'accent' | 'good' | 'warn' | 'bad'>> = {
  drafted: 'neutral',
  signed: 'accent',
  screened: 'accent',
  deployed: 'accent',
  awaiting_pointing: 'warn',
  pointed: 'accent',
  accepted: 'warn',
  active: 'good',
  declined: 'bad',
  withdrawn: 'neutral',
}

export function StateBadge({ state }: { state: OnboardingState }) {
  return <Badge tone={STATE_TONES[state]}>{state.replace(/_/g, ' ')}</Badge>
}

/** The one-line identity of an onboarding, the same on every console page. */
export function RecordLine({ record }: { record: OnboardingRecordView }) {
  return (
    <span className="row">
      <strong>
        {record.subject.name} <span className="faint">({record.subject.symbol})</span>
      </strong>
      <StateBadge state={record.state} />
      <code className="tiny mono muted">{record.id}</code>
      <span className="tiny muted">
        vault <AddressChip address={record.vault} />
      </span>
    </span>
  )
}

/** A picker for pages that act on one onboarding: the eligible records, each a link. */
export function RecordPicker({
  records,
  page,
  eligible,
  emptyNote,
}: {
  records: OnboardingRecordView[]
  page: 'narrative' | 'creative' | 'accounts'
  eligible: (record: OnboardingRecordView) => boolean
  emptyNote: string
}) {
  const shown = records.filter(eligible)
  if (shown.length === 0) return <div className="card-flat small muted">{emptyNote}</div>
  return (
    <div className="card">
      {shown.map((record) => (
        <div className="row-between" key={record.id} style={{ padding: 'var(--gap-2) 0', borderBottom: '1px solid var(--line)' }}>
          <RecordLine record={record} />
          <Link to={{ name: 'ops', page, id: record.id }} className="btn btn-small">
            Open
          </Link>
        </div>
      ))}
    </div>
  )
}

export function Swatch({ hex, label }: { hex: string; label: string }) {
  return (
    <span className="row" style={{ gap: '0.4rem' }}>
      <span
        className="swatch"
        aria-label={`${label} ${hex}`}
        style={{
          display: 'inline-block',
          width: '1.6rem',
          height: '1.6rem',
          borderRadius: '0.3rem',
          border: '1px solid var(--line)',
          background: hex,
        }}
      />
      <code className="tiny">{hex}</code>
      <span className="tiny muted">{label}</span>
    </span>
  )
}

export function DemoBadge({ isDemo }: { isDemo: boolean }) {
  return isDemo ? <Badge tone="warn">demo data</Badge> : null
}
