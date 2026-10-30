/**
 * Image assets - the media counterpart of the link allowlist.
 *
 * The planner may name an image by ID exactly as it names a link by ID. The ID
 * is minted by trusted code from content it generated itself (creative package)
 * from trusted inputs (token symbol/name from chain, an approved
 * NarrativeProfile). Bytes are resolved after the model is out of the loop, at
 * publish time, and uploaded by the channel adapter. The model never sees bytes,
 * a URL, or a media id.
 *
 * Kinds are closed. `banner` is 1500x500 (X profile header), `avatar` is
 * 400x400, `card` is 1200x675 (16:9 post image).
 */

export const IMAGE_KINDS = ['banner', 'avatar', 'card'] as const
export type ImageKind = (typeof IMAGE_KINDS)[number]

export const IMAGE_DIMENSIONS: Readonly<Record<ImageKind, { width: number; height: number }>> = {
  banner: { width: 1500, height: 500 },
  avatar: { width: 400, height: 400 },
  card: { width: 1200, height: 675 },
}

export interface ImageAsset {
  /** `${coinRef}:${kind}:${sha256.slice(0, 16)}` — see imageAssetId(). */
  readonly id: string
  readonly coinRef: string
  readonly kind: ImageKind
  readonly mime: 'image/png'
  readonly width: number
  readonly height: number
  readonly sha256: string
  readonly bytes: Uint8Array
}

/** What the planner is shown: id + kind only. No bytes, no hash, no URL. */
export interface ImageRef {
  readonly id: string
  readonly kind: ImageKind
}

export interface ImageAssetSource {
  get(id: string): Promise<ImageAsset | null>
  list(coinRef: string): Promise<readonly ImageRef[]>
}

export interface ImageAssetStore extends ImageAssetSource {
  put(asset: ImageAsset): Promise<void>
}

const COIN_REF = /^[A-Za-z0-9_-]{1,96}$/
const ID_PATTERN = /^([A-Za-z0-9_-]{1,96}):(banner|avatar|card):([0-9a-f]{16})$/

export function imageAssetId(coinRef: string, kind: ImageKind, sha256: string): string {
  if (!COIN_REF.test(coinRef)) throw new TypeError(`invalid coinRef ${coinRef}`)
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new TypeError('sha256 must be 64 hex chars')
  return `${coinRef}:${kind}:${sha256.slice(0, 16)}`
}

export function parseImageAssetId(id: string): { coinRef: string; kind: ImageKind; prefix: string } | null {
  const m = ID_PATTERN.exec(id)
  if (!m) return null
  return { coinRef: m[1]!, kind: m[2] as ImageKind, prefix: m[3]! }
}
