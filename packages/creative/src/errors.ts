/**
 * Creative fails closed. There is no "render it anyway" mode: an input that
 * carries a destination, a font that cannot be resolved, a canvas that came out
 * the wrong size - each is a typed refusal the caller can log and act on, never
 * a banner with a URL baked into it or a PNG the channel would reject.
 */
export type CreativeErrorCode =
  | 'invalid_coin_ref'
  | 'unknown_kind'
  | 'unknown_tone'
  | 'invalid_palette'
  | 'empty_text'
  | 'destination_in_input'
  | 'font_unresolved'
  | 'dimension_mismatch'
  | 'asset_id_mismatch'

export class CreativeError extends Error {
  constructor(
    readonly code: CreativeErrorCode,
    message: string,
    /** Input field the refusal is attributed to, when there is one. */
    readonly field: string | null = null,
  ) {
    super(`${code}: ${message}`)
    this.name = 'CreativeError'
  }
}
