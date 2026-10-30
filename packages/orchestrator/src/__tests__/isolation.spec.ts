/**
 * Structural assertions over this package's own source.
 *
 * These are not style checks. Each one pins a property that is only true
 * because of what is ABSENT from the code, and absence is exactly the kind of
 * property that a future well-meaning edit erodes without any test failing.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLANNER_TOOL_NAMES, READER_TOOLS } from '@fee-split-vaults/core'
import { COMMITMENT_RULE } from '../../../../config/protocol.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

function sourceFiles(): Array<{ name: string; text: string }> {
  return readdirSync(SRC, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => ({ name: e.name, text: readFileSync(join(SRC, e.name), 'utf8') }))
}

/** Strip comments so a doc block explaining a rule cannot satisfy or trip one. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('the airlock holds in this package', () => {
  it('never reads the text of an untrusted message', () => {
    for (const file of sourceFiles()) {
      const body = code(file.text)
      expect(body, `${file.name} reads message text`).not.toMatch(/\.text\b/)
      expect(body, `${file.name} reads an author id`).not.toMatch(/\.authorId\b/)
    }
  })

  it('never constructs a payee, an address literal, or a URL', () => {
    for (const file of sourceFiles()) {
      const body = code(file.text)
      // A 0x literal long enough to be an address has no business being here:
      // every destination in this package comes from a typed field written by
      // the broker or by operator configuration.
      expect(body, `${file.name} contains an address literal`).not.toMatch(/0x[a-fA-F0-9]{8,}/)
      expect(body, `${file.name} contains a hardcoded URL`).not.toMatch(/https?:\/\//)
    }
  })

  it('never hardcodes a creator rate: the branch always goes through config', () => {
    for (const file of sourceFiles()) {
      const body = code(file.text)
      // 0.70% off, 0.35% on. Any of these as a literal means someone assumed
      // one of the two branches.
      expect(body, `${file.name} hardcodes a creator rate`).not.toMatch(
        /\b(?:0\.007|0\.0035|0\.70|0\.35)\b/,
      )
      expect(body, `${file.name} hardcodes a creator rate in bps`).not.toMatch(
        /\bcreatorNetBps\s*=\s*\d/,
      )
    }
  })

  it('the reader still has no tools and the planner only proposes', () => {
    expect(READER_TOOLS).toHaveLength(0)
    for (const name of PLANNER_TOOL_NAMES) {
      expect(name.startsWith('propose_')).toBe(true)
    }
  })

  it('the commitment rule is intact in the config this package compiled against', () => {
    expect(COMMITMENT_RULE.requireFullyBankedAtSigning).toBe(true)
    expect(COMMITMENT_RULE.allowCrossCoinSubsidy).toBe(false)
    expect(COMMITMENT_RULE.allowForwardFinancing).toBe(false)
  })
})

describe('the settlement port cannot express a destination', () => {
  it('SettlementPort.submit takes exactly one argument', () => {
    const ports = readFileSync(join(SRC, 'ports.ts'), 'utf8')
    const match = /export interface SettlementPort \{([\s\S]*?)\n\}/.exec(ports)
    expect(match).not.toBeNull()
    const body = match?.[1] ?? ''
    expect(body).toMatch(/submit\(pull: ReimbursementPull\): Promise<SettlementReceipt>/)
    expect(body).not.toMatch(/destination|payee|to:|recipient/)
  })

  it('no exported function in spend.ts takes a destination parameter', () => {
    const spend = code(readFileSync(join(SRC, 'spend.ts'), 'utf8'))
    expect(spend).not.toMatch(/\bpayee\b/)
    expect(spend).not.toMatch(/destination:\s*(?:Address|string)/)
  })
})
