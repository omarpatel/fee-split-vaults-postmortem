/**
 * Sealing for secrets at rest.
 *
 * AES-256-GCM, a fresh 12-byte IV per seal, and the key's fingerprint stored
 * beside the ciphertext. The fingerprint is checked BEFORE decryption so a
 * process started with a rotated or mistyped key refuses with `key_mismatch`
 * instead of failing the GCM tag and reporting a tampered blob. A blob nobody
 * can open is a refusal, never a token: the store returns nothing rather than
 * the bytes of a failed decryption.
 *
 * Blob layout, one line of text so it fits a TEXT column and a log grep:
 *
 *   v1.<keyId>.<iv b64url>.<ciphertext||tag b64url>
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { SecretUnopenableError } from '../errors.js'

const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const VERSION = 'v1'

export interface SealingKey {
  readonly bytes: Uint8Array
  /** First 16 hex of sha256(key). Identifies which key sealed a blob. */
  readonly id: string
}

/**
 * Parse a 32-byte key from hex. Refuses anything else at construction: a
 * store built with a short key would seal every token under a weak key and
 * nothing downstream would notice.
 */
export function sealingKeyFromHex(hex: string): SealingKey {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex
  if (!/^[0-9a-fA-F]{64}$/.test(body)) {
    throw new TypeError(`sealing key must be ${KEY_BYTES} bytes of hex (${KEY_BYTES * 2} chars), got ${body.length}`)
  }
  const bytes = Buffer.from(body, 'hex')
  return { bytes, id: createHash('sha256').update(bytes).digest('hex').slice(0, 16) }
}

export function sealSecret(key: SealingKey, plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key.bytes, iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return `${VERSION}.${key.id}.${iv.toString('base64url')}.${body.toString('base64url')}`
}

export function openSecret(key: SealingKey, sealed: string): string {
  const parts = sealed.split('.')
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretUnopenableError('malformed', `expected ${VERSION}.<keyId>.<iv>.<body>`)
  }
  const [, keyId, ivText, bodyText] = parts as [string, string, string, string]
  if (keyId !== key.id) {
    throw new SecretUnopenableError('key_mismatch', `blob sealed under key ${keyId}, this process holds ${key.id}`)
  }
  const iv = Buffer.from(ivText, 'base64url')
  const body = Buffer.from(bodyText, 'base64url')
  if (iv.length !== IV_BYTES || body.length < TAG_BYTES) {
    throw new SecretUnopenableError('malformed', 'iv or body has the wrong length')
  }
  const decipher = createDecipheriv('aes-256-gcm', key.bytes, iv)
  decipher.setAuthTag(body.subarray(body.length - TAG_BYTES))
  try {
    return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString(
      'utf8',
    )
  } catch (error) {
    throw new SecretUnopenableError('auth_failed', String(error))
  }
}

/** Which key sealed a blob, without opening it. Used to refuse before decrypting. */
export function sealedKeyId(sealed: string): string | undefined {
  const parts = sealed.split('.')
  return parts.length === 4 && parts[0] === VERSION ? parts[1] : undefined
}
