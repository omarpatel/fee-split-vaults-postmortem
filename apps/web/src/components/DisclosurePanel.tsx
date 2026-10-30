import {
  buildDisclosureBlock,
  REFUSAL_EXPLANATIONS,
  WHAT_WE_DID_NOT_DO,
  type DisclosureFacts,
} from '../domain/disclosure.js'
import { REFUSAL_CLASSES } from '../protocol.js'
import { AddressChip, Badge } from './primitives.js'

/**
 * The disclosure block and the "what we did not do" section.
 *
 * Both render fixed, code-owned copy from domain/disclosure.ts. Neither takes
 * an editable string from the API, because a disclosure that can be edited
 * remotely is a disclosure that can be removed remotely.
 */

export function DisclosurePanel({ facts }: { facts: DisclosureFacts }) {
  const block = buildDisclosureBlock(facts)
  const namePlaceholder = facts.operatorLegalName === 'SET_ME_BEFORE_LAUNCH'

  return (
    <section className="card stack" id="disclosure">
      <div className="row-between">
        <div>
          <span className="eyebrow">Required disclosure</span>
          <h2>{block.headline}</h2>
        </div>
        <div className="row">
          {block.tags.map((tag) => (
            <Badge key={tag} tone="accent">
              {tag}
            </Badge>
          ))}
        </div>
      </div>

      {namePlaceholder && (
        <div className="callout callout-bad">
          <div className="callout-title">The operator&rsquo;s legal name is not set</div>
          <p className="small" style={{ margin: 0 }}>
            <code>DISCLOSURE.operatorName</code> in <code>config/protocol.ts</code> is still the
            placeholder. This page is not compliant until it names the operator, and it says so here
            rather than printing the placeholder as if it were a name.
          </p>
        </div>
      )}

      <div className="stack-tight">
        {block.paragraphs.map((paragraph, index) => (
          <p key={index} className={index === 2 ? undefined : 'small'}>
            {paragraph}
          </p>
        ))}
      </div>

      <div>
        <h3 style={{ fontSize: 'var(--step-0)', marginBottom: '0.4rem' }}>Addresses</h3>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>What</th>
                <th>Address</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {block.addresses.map((entry) => (
                <tr key={entry.address}>
                  <td>{entry.label}</td>
                  <td>
                    <AddressChip address={entry.address} />
                  </td>
                  <td className="muted">{entry.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}

export function WhatWeDidNotDo() {
  return (
    <section className="card stack" id="what-we-did-not-do">
      <div className="section-head">
        <div>
          <span className="eyebrow">Fixed section</span>
          <h2>What we did not do</h2>
        </div>
        <p>
          The same list on every member page, every week. It does not shrink when a week goes badly
          and it does not grow when one goes well, because a list of abstentions that moves is not a
          commitment.
        </p>
      </div>

      <ul className="checklist">
        {WHAT_WE_DID_NOT_DO.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>

      <div className="card-flat">
        <h4>Questions the desk refuses as a class</h4>
        <p className="small muted">
          Not answered carefully — refused, by a classifier rather than by a prompt. An autonomous
          desk cannot satisfy the qualified-review requirement that attaches to financial advice, so
          it does not attempt to.
        </p>
        <div className="row" style={{ marginTop: '0.5rem' }}>
          {REFUSAL_CLASSES.map((refusalClass) => (
            <Badge key={refusalClass} tone="neutral" title={refusalClass}>
              {REFUSAL_EXPLANATIONS[refusalClass] ?? refusalClass}
            </Badge>
          ))}
        </div>
      </div>
    </section>
  )
}
