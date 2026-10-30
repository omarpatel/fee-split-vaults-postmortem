import { useEffect, useState } from 'react'

import {
  IMAGE_KINDS,
  PROMOTION_ELIGIBLE_STATES,
  type CreativeImage,
  type CreativeRender,
  type ImageKind,
} from '../../api/operator.js'
import { useAsync } from '../../app/context.js'
import { Badge, ErrorPanel, Skeleton } from '../../components/primitives.js'
import { RecordPicker, RefusalPanel, describeRefusal, useAction, useOperator, type Refusal } from './common.js'

/**
 * Creative: render, preview, download.
 *
 * The three assets come back as bytes, not as URLs the browser would fetch on
 * its own: the route is behind the operator bearer, and an <img src> cannot
 * carry one. So each asset is fetched through the client and shown from a
 * blob URL, which is revoked when the page goes away.
 */

const KIND_DIMENSIONS: Readonly<Record<ImageKind, string>> = {
  banner: '1500 × 500',
  avatar: '400 × 400',
  card: '1200 × 675',
}

export interface PreviewedImage {
  kind: ImageKind
  url: string
  mime: string
  bytes: number
  sha256: string | null
}

export type PreviewSlot = { status: 'loading' } | { status: 'ready'; image: PreviewedImage } | { status: 'refused'; refusal: Refusal }

export function CreativePage({ id }: { id: string | null }) {
  const { operator, auth } = useOperator()
  const records = useAsync(() => (id === null ? operator.listOnboardings(auth) : Promise.resolve([])), [auth.token, id])
  const render = useAction<CreativeRender>()
  const [slots, setSlots] = useState<Partial<Record<ImageKind, PreviewSlot>>>({})
  const [generation, setGeneration] = useState(0)

  // Fetch the three previews; refetch after a render. Blob URLs are revoked on
  // the way out so a long console session does not hold every render it saw.
  useEffect(() => {
    if (id === null) return
    let live = true
    const urls: string[] = []
    setSlots(Object.fromEntries(IMAGE_KINDS.map((kind) => [kind, { status: 'loading' }])))
    for (const kind of IMAGE_KINDS) {
      operator
        .getCreative(auth, id, kind)
        .then((image) => {
          if (!live) return
          const url = toBlobUrl(image)
          urls.push(url)
          setSlots((prev) => ({ ...prev, [kind]: { status: 'ready', image: { kind, url, mime: image.mime, bytes: image.bytes.byteLength, sha256: image.sha256 } } }))
        })
        .catch((error: unknown) => {
          if (live) setSlots((prev) => ({ ...prev, [kind]: { status: 'refused', refusal: describeRefusal(error) } }))
        })
    }
    return () => {
      live = false
      for (const url of urls) URL.revokeObjectURL(url)
    }
  }, [operator, auth, id, generation])

  if (id === null) {
    if (records.error !== null) return <ErrorPanel error={records.error} onRetry={records.reload} />
    if (records.data === null) return <Skeleton height={200} />
    return (
      <div className="stack">
        <p className="small muted">Creative is rendered once the coin has pointed at the vault, from its approved narrative or from none.</p>
        <RecordPicker
          records={records.data}
          page="creative"
          eligible={(record) => PROMOTION_ELIGIBLE_STATES.includes(record.state)}
          emptyNote="No onboarding has pointed at its vault yet, so there is nothing to render."
        />
      </div>
    )
  }

  return (
    <CreativeView
      id={id}
      slots={slots}
      rendering={render.busy}
      renderRefusal={render.refusal}
      lastRender={render.result}
      onRender={() => void render.run(() => operator.renderCreative(auth, id)).then((r) => r !== null && setGeneration((g) => g + 1))}
    />
  )
}

function toBlobUrl(image: CreativeImage): string {
  // A fresh ArrayBuffer-backed copy: Blob's typing rejects a Uint8Array over a SharedArrayBuffer.
  const copy = new Uint8Array(image.bytes.byteLength)
  copy.set(image.bytes)
  return URL.createObjectURL(new Blob([copy.buffer], { type: image.mime }))
}

export function CreativeView({
  id,
  slots,
  rendering,
  renderRefusal,
  lastRender,
  onRender,
}: {
  id: string
  slots: Partial<Record<ImageKind, PreviewSlot>>
  rendering: boolean
  renderRefusal: Refusal | null
  lastRender: CreativeRender | null
  onRender: () => void
}) {
  return (
    <div className="stack-loose">
      <div className="row-between">
        <code className="mono">{id}</code>
        <button type="button" className="btn btn-primary" disabled={rendering} onClick={onRender}>
          {rendering ? 'Rendering…' : 'Render banner, avatar and card'}
        </button>
      </div>

      {renderRefusal !== null && <RefusalPanel refusal={renderRefusal} title="Render refused" />}

      {lastRender !== null && (
        <div className="callout callout-good">
          <div className="callout-title">Rendered {lastRender.narrative ? 'from the approved narrative' : 'with no narrative'}</div>
          <div className="small">
            {lastRender.assets.map((asset) => (
              <p key={asset.id} className="mono tiny" style={{ margin: 0 }}>
                {asset.kind} · {asset.bytes} bytes · sha256 {asset.sha256.slice(0, 16)}…
              </p>
            ))}
          </div>
        </div>
      )}

      <div className="grid-3">
        {IMAGE_KINDS.map((kind) => {
          const slot = slots[kind]
          return (
            <article className="card stack-tight" key={kind}>
              <div className="row-between">
                <strong>{kind}</strong>
                <span className="tiny muted">{KIND_DIMENSIONS[kind]}</span>
              </div>
              {slot === undefined || slot.status === 'loading' ? (
                <Skeleton height={120} />
              ) : slot.status === 'refused' ? (
                <RefusalPanel refusal={slot.refusal} title="Not available" />
              ) : (
                <>
                  <img
                    src={slot.image.url}
                    alt={`${kind} for ${id}`}
                    style={{ width: '100%', height: 'auto', borderRadius: 'var(--radius)', border: '1px solid var(--line)' }}
                  />
                  <div className="row-between tiny muted">
                    <span>
                      {slot.image.mime} · {slot.image.bytes} bytes
                    </span>
                    {slot.image.sha256 !== null && <Badge title={slot.image.sha256}>sha256 {slot.image.sha256.slice(0, 8)}</Badge>}
                  </div>
                  <a className="btn btn-small" href={slot.image.url} download={`${id}-${kind}.${slot.image.mime === 'image/png' ? 'png' : 'svg'}`}>
                    Download
                  </a>
                </>
              )}
            </article>
          )
        })}
      </div>
    </div>
  )
}
