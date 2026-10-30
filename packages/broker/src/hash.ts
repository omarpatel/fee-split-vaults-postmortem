import { createHash } from 'node:crypto'

/** Content addressing for archived rate cards and delivery evidence. */
export function sha256Hex(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex')
}
