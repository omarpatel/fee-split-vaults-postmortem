/** Human-readable output. No colour codes: these reports get pasted into docs. */

/**
 * THE ONE UNKNOWN MARKER.
 *
 * A USD-denominated figure that could not be derived - because the amount
 * behind it has no price - renders as this string. NEVER as 0, and never as
 * "$0.00".
 *
 * This exists because of a real failure. A live run against an escrow whose
 * assets were all unpriced printed a gate table of zeros:
 *
 *     T1 Desk       $1000/day   0   0   0   0
 *
 * and the true answer, once priced, was 140. Every zero in that table was a
 * formatting artefact of a missing price, and it reads exactly like "there is
 * no market". The same rendering path also printed "$0.00" for a recipient's
 * peak day in a row whose total already said "n/a", so the table contradicted
 * itself and the $0.00 won the eye.
 *
 * A count is different from an amount and gets no marker of its own: a gate
 * count taken over a population with ANY unpriced member is not a count at
 * all, so it is REFUSED rather than rendered - see the gate tables in
 * escrow-index.ts and tenure.ts.
 */
export const UNPRICED = 'UNPRICED'

export function heading(text: string): string {
  return `\n${text}\n${'='.repeat(text.length)}`
}

export function subheading(text: string): string {
  return `\n${text}\n${'-'.repeat(text.length)}`
}

/**
 * A boxed warning. Used for the facts that make a number non-extrapolable -
 * these must survive being skim-read, because the whole failure mode of this
 * project is someone quoting a tenure figure without its observation window.
 */
export function banner(lines: readonly string[], maxWidth = 92): string {
  // Wrapped here rather than at the call sites so a caller can pass whole
  // sentences; an unwrapped banner is a 400-column box nobody reads.
  const wrapped = lines.flatMap((line) => (line.length === 0 ? [''] : wrapText(line, maxWidth)))
  const width = Math.max(...wrapped.map((l) => l.length), 10)
  const bar = '!'.repeat(width + 4)
  return [bar, ...wrapped.map((l) => `! ${l.padEnd(width)} !`), bar].join('\n')
}

/** Greedy word wrap. Long unbreakable tokens are left long rather than cut. */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = []
  let current = ''
  for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
    if (current.length === 0) current = word
    else if (current.length + word.length + 1 > width) {
      out.push(current)
      current = word
    } else current = `${current} ${word}`
  }
  if (current.length > 0) out.push(current)
  return out.length === 0 ? [''] : out
}

export interface Column<T> {
  header: string
  value: (row: T) => string
  align?: 'left' | 'right'
}

export function table<T>(rows: readonly T[], columns: readonly Column<T>[]): string {
  if (rows.length === 0) return '  (no rows)'
  const cells = rows.map((row) => columns.map((c) => c.value(row)))
  const widths = columns.map((c, i) =>
    Math.max(c.header.length, ...cells.map((r) => (r[i] ?? '').length)),
  )
  const render = (values: readonly string[]): string =>
    `  ${values
      .map((v, i) =>
        columns[i]?.align === 'right' ? v.padStart(widths[i]!) : v.padEnd(widths[i]!),
      )
      .join('  ')
      .trimEnd()}`
  return [
    render(columns.map((c) => c.header)),
    `  ${widths.map((w) => '-'.repeat(w)).join('  ')}`,
    ...cells.map(render),
  ].join('\n')
}

/**
 * A USD figure, or UNPRICED when there is no figure.
 *
 * `null` is the shape an unpriced amount takes everywhere in this toolkit
 * (see series.ts), and it is accepted here so that a caller never has to write
 * `?? 0` to get a string out. Writing `?? 0` at a call site is precisely the
 * bug this signature removes.
 */
export function usd(value: number | null | undefined, digits = 2): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return UNPRICED
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `$${(value / 1000).toFixed(1)}k`
  return `$${value.toFixed(digits)}`
}

/**
 * A ratio, or "n/a" when it was not computed.
 *
 * "n/a" and UNPRICED are deliberately different words for different facts.
 * UNPRICED means "an amount exists and we could not value it", which is a
 * defect in the run's inputs and is what the loud banners are about. "n/a"
 * means "this quantity was never applicable" - a Kaplan-Meier median that the
 * survival curve never reached, a feasibility ratio whose input was not
 * supplied. Neither ever renders as 0.
 */
export function pct(value: number | null | undefined, digits = 1): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return 'n/a'
  return `${(value * 100).toFixed(digits)}%`
}

export function num(value: number | null | undefined, digits = 2): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return 'n/a'
  return value.toFixed(digits)
}

export function bps(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return 'n/a'
  return `${value.toFixed(2)}bps (${(value / 100).toFixed(4)}%)`
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 8)}..${address.slice(-4)}` : address
}

/**
 * ASCII sparkline for a survival curve or a daily series.
 *
 * `null` means "no value" and renders as '?', never as a blank. A blank is
 * what a zero day looks like, and a day whose amount could not be priced is
 * not a zero day - drawing it as one turns a pricing failure into a picture of
 * an idle recipient.
 */
export function sparkline(values: ReadonlyArray<number | null>, width = 40): string {
  if (values.length === 0) return ''
  const blocks = ' .:-=+*#%@'
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v))
  const max = known.length === 0 ? 0 : Math.max(...known)
  const step = Math.max(1, Math.ceil(values.length / width))
  const out: string[] = []
  for (let i = 0; i < values.length; i += step) {
    const slice = values.slice(i, i + step)
    // One unknown day poisons its bucket: the bucket's mean is unknown too.
    if (slice.some((v) => v === null || !Number.isFinite(v))) {
      out.push('?')
      continue
    }
    if (max <= 0) {
      out.push(' ')
      continue
    }
    const numbers = slice as readonly number[]
    const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length
    const index = Math.min(blocks.length - 1, Math.floor((mean / max) * (blocks.length - 1)))
    out.push(blocks[index]!)
  }
  return out.join('')
}
