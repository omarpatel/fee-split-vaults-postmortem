/**
 * Stream the `recipients` array of a merged escrow-index document.
 *
 * WHY STREAM. The 7-day merged document is 229 MB of pretty-printed JSON and
 * `recipients` is 228 MB of it. `JSON.parse` on the whole file peaks at several
 * GB of heap; the machine that produced the measurement had 10.8 GB free, so a
 * full parse is a coin flip on OOM - and an OOM here reads as "the analysis
 * failed" rather than "the analysis needed more memory". Streaming one recipient
 * at a time is bounded by the largest single recipient, a few kilobytes.
 *
 * THE SCAN IS OVER BYTES, NOT CHARACTERS. Every JSON structural byte - { } " \ -
 * is ASCII, and no byte of a UTF-8 multi-byte sequence is ever below 0x80. So a
 * byte scan cannot be confused by a multi-byte symbol, and no chunk boundary can
 * split a character out from under it. That matters concretely: this chain's
 * asset symbols are issuer-chosen and ten of them are emoji.
 *
 * String state is tracked so a brace INSIDE a symbol cannot move the depth
 * counter, and backslash escapes are honoured so a quote inside a string cannot
 * end it early.
 *
 * THE FAILURE THIS GUARDS AGAINST is not a crash. A scanner that loses objects
 * at a chunk boundary reports a SMALLER MARKET, silently - the same shape as
 * the checkpoint defect that once turned a complete 808 MB checkpoint into a
 * table of zeros. Breaking the straddle carry deliberately loses 20,478 of
 * 20,865 recipients from a real 1-day artifact at a 64 KB chunk, so the
 * chunk-size-parameterised tests in `__tests__/reprice-artifact.spec.ts` are
 * what stands between this file and that failure. Callers must additionally
 * reconcile the yielded count against the document's own declared total.
 */
import { openSync, readSync, closeSync, statSync } from 'node:fs'

const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d
const OPEN_BRACKET = 0x5b
const CLOSE_BRACKET = 0x5d
const QUOTE = 0x22
const BACKSLASH = 0x5c

/**
 * A merged document with its `recipients` array emptied.
 *
 * Deliberately loose: this reader is used by operator scripts against documents
 * from several runs, and the toolkit's own `parseEscrowSeriesDocument` is the
 * place that enforces the schema.
 */
export interface DocumentHeader {
  envelope: Record<string, unknown>
  result: {
    schema?: string
    totalCredits: number
    assetDecimals?: Record<string, number>
    assetSymbols?: Record<string, string>
    assetKinds?: Record<string, 'native' | 'erc20'>
    priceUsdByAsset?: Record<string, number | null>
    assetTotals?: Array<{
      asset: string
      kind: 'native' | 'erc20'
      symbol: string
      decimals: number
      totalMinor: string
      recipients: number
      credits: number
      priceUsd: number | null
      totalUsd: number | null
    }>
    unpricedAssets?: string[]
    pricing?: { recipientsTotal?: number }
    recipients: unknown[]
    [key: string]: unknown
  }
  /** Byte offset of the `"recipients"` key, where the streamer starts. */
  recipientsOffset: number
}

export interface StreamedDay {
  dayUnix: number
  dateUtc: string
  byAssetMinor: Record<string, string>
  usd: number | null
  creditCount: number
}

export interface StreamedRecipient {
  recipient: string
  firstCreditUnix: number
  lastCreditUnix: number
  activeDays: number
  totalByAssetMinor: Record<string, string>
  totalUsd: number | null
  days: StreamedDay[]
}

/**
 * Parse the document header - everything before `recipients` - in one slice.
 *
 * Returns the parsed envelope with an EMPTY recipients array, plus the byte
 * offset the streamer should start from.
 */
export function readHeader(path: string, maxBytes = 8_000_000): DocumentHeader {
  const size = statSync(path).size
  const bytes = Math.min(size, maxBytes)
  const fd = openSync(path, 'r')
  const buffer = Buffer.alloc(bytes)
  readSync(fd, buffer, 0, bytes, 0)
  closeSync(fd)
  const marker = buffer.indexOf(Buffer.from('"recipients": ['))
  if (marker < 0) {
    throw new Error(
      `${path}: no "recipients" key in the first ${bytes} bytes. Either this is not an ` +
        `escrow-index document, or its header is bigger than the slice - raise maxBytes rather ` +
        `than concluding the fields are absent.`,
    )
  }
  const head = buffer.toString('utf8', 0, marker)
  for (const suffix of ['"recipients": []}}', '"recipients": []}']) {
    try {
      const parsed = JSON.parse(head + suffix) as Record<string, unknown>
      const result = (parsed.result ?? parsed) as DocumentHeader['result']
      return { envelope: parsed, result, recipientsOffset: marker }
    } catch {
      // try the other nesting depth
    }
  }
  throw new Error(`${path}: could not close the truncated header into valid JSON.`)
}

/**
 * Yield each recipient object of the document, parsed, one at a time.
 *
 * The caller MUST reconcile the yielded count against the header's own
 * recipient total. A silent short read on a file this size is precisely the
 * failure that once turned a complete checkpoint into a table of zeros.
 */
export function* streamRecipients(
  path: string,
  recipientsOffset: number,
  chunkBytes = 8 << 20,
): Generator<StreamedRecipient> {
  const size = statSync(path).size
  const fd = openSync(path, 'r')
  try {
    const chunk = Buffer.alloc(chunkBytes)
    let filePos = recipientsOffset
    let tail = Buffer.alloc(0)
    let started = false
    let depth = 0
    let inString = false
    let escaped = false

    while (filePos < size) {
      const read = readSync(fd, chunk, 0, Math.min(chunkBytes, size - filePos), filePos)
      if (read === 0) break
      filePos += read
      const data =
        tail.length === 0 ? chunk.subarray(0, read) : Buffer.concat([tail, chunk.subarray(0, read)])

      let i = 0
      if (!started) {
        i = data.indexOf(OPEN_BRACKET)
        if (i < 0) {
          tail = Buffer.alloc(0)
          continue
        }
        i++
        started = true
      }

      let objectStart = -1
      let done = false
      for (; i < data.length; i++) {
        const byte = data[i]
        if (inString) {
          if (escaped) escaped = false
          else if (byte === BACKSLASH) escaped = true
          else if (byte === QUOTE) inString = false
          continue
        }
        if (byte === QUOTE) {
          inString = true
          continue
        }
        if (byte === OPEN_BRACE) {
          if (depth === 0) objectStart = i
          depth++
          continue
        }
        if (byte === CLOSE_BRACE) {
          depth--
          if (depth === 0 && objectStart >= 0) {
            yield JSON.parse(data.toString('utf8', objectStart, i + 1)) as StreamedRecipient
            objectStart = -1
          }
          continue
        }
        if (byte === CLOSE_BRACKET && depth === 0) {
          done = true
          break
        }
      }
      if (done) return

      if (depth > 0 && objectStart >= 0) {
        // An object straddles this chunk. Carry it whole and REPLAY it from its
        // opening brace, so the scanner state that goes with it is reset rather
        // than half-remembered.
        tail = Buffer.from(data.subarray(objectStart))
        depth = 0
        inString = false
        escaped = false
      } else {
        tail = Buffer.alloc(0)
      }
    }
  } finally {
    closeSync(fd)
  }
}
