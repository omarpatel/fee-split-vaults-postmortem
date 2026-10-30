/**
 * THE BOOTSTRAP'S PROMISES.
 *
 * Two of them are safety properties rather than conveniences, and both are the
 * reason this tool is allowed to write configuration at all:
 *
 *   1. Nothing it writes for a variable apps/api requires is ever silently
 *      wrong. Derived values are derived; the ones that cannot be derived are
 *      the published sentinels, and every one of those is refused in production.
 *
 *   2. The file it produces PARSES, and parses to exactly the values in the
 *      plan. A generated env file with a stray newline in a comment is a
 *      configuration bug that looks like a code bug for an afternoon.
 */

import { describe, expect, it } from 'vitest'
import { buildPlan, renderEnvFile, type BootstrapPlan } from '../bootstrap-env.ts'
import { DEV_ONLY, DEV_ONLY_MARKER_ENV, isDevOnlyValue, isStructurallyUnreachableAddress } from '../../config/dev-only.ts'
import { VENUE } from '../../config/protocol.ts'
import { deriveVaultDeployer } from '../lib/deployment-derivation.ts'

const RPC = ['https://one.invalid', 'https://two.invalid']

function plan(overrides: Partial<Parameters<typeof buildPlan>[0]> = {}): BootstrapPlan {
  return buildPlan({ rpcUrls: RPC, devIdentity: false, port: 8080, ...overrides })
}

/** The same parse Node's --env-file does for the shapes this tool emits. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    expect(eq, `line is not KEY=VALUE: ${JSON.stringify(line)}`).toBeGreaterThan(0)
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
  }
  return out
}

describe('the file it writes', () => {
  it('parses, and every value in it came from the plan', () => {
    const p = plan({ devIdentity: true })
    const parsed = parseEnvFile(renderEnvFile(p))
    for (const entry of p.vars) {
      expect(parsed[entry.name], `${entry.name} missing from the rendered file`).toBe(entry.value ?? '')
    }
  })

  it('is deterministic, so regenerating produces no diff noise', () => {
    expect(renderEnvFile(plan())).toBe(renderEnvFile(plan()))
  })

  it('tags every DEV-ONLY line as such in the file itself', () => {
    const text = renderEnvFile(plan({ devIdentity: true }))
    for (const entry of plan({ devIdentity: true }).vars.filter((v) => v.provenance === 'dev-only')) {
      const index = text.indexOf(`\n${entry.name}=`)
      expect(index, `${entry.name} not found`).toBeGreaterThan(0)
      expect(text.slice(0, index)).toMatch(/\[DEV-ONLY\][^]*$/)
    }
  })
})

describe('what it derives, as opposed to what it defaults', () => {
  it('writes the real init-code hash, not a placeholder', () => {
    const value = plan().vars.find((v) => v.name === 'VENUE_VAULT_INIT_CODE_HASH')
    expect(value?.provenance).toBe('derived')
    expect(value?.value).toMatch(/^0x[0-9a-f]{64}$/)
    // The one variable in the whole file that is NOT dev-only. If this ever
    // becomes a sentinel, the tool has hidden the value it exists to supply.
    expect(isDevOnlyValue(value?.value)).toBe(false)
  })

  it('derives the deployer from whatever factory is in play, never copying the factory', () => {
    const real = '0x1d1499e622d69689cdf9004d05ec547d650ff211'
    const p = plan({ factory: real })
    expect(p.deployer).toBe(deriveVaultDeployer(real))
    expect(p.deployer).not.toBe(real)
    expect(p.factoryIsSentinel).toBe(false)
    expect(p.vars.find((v) => v.name === 'VENUE_VAULT_DEPLOYER')?.provenance).toBe('derived')
  })

  it('pins the chain id to config/protocol.ts rather than restating it', () => {
    expect(plan().vars.find((v) => v.name === 'VENUE_CHAIN_ID')?.value).toBe(String(VENUE.chainId))
  })
})

describe('what it refuses to invent', () => {
  it('uses the published sentinel for the factory, and marks it dev-only', () => {
    const p = plan()
    expect(p.factory).toBe(DEV_ONLY.factory)
    expect(p.factoryIsSentinel).toBe(true)
    expect(p.vars.find((v) => v.name === 'VENUE_VAULT_FACTORY')?.provenance).toBe('dev-only')
  })

  it('picks sentinel addresses no CREATE or CREATE2 can reach', () => {
    const p = plan()
    expect(isStructurallyUnreachableAddress(p.factory)).toBe(true)
    // The derived deployer is NOT unreachable-shaped -- it is a real keccak
    // output -- which is exactly why the marker and the value list exist too.
    expect(isStructurallyUnreachableAddress(p.deployer)).toBe(false)
    expect(isDevOnlyValue(p.deployer)).toBe(true)
  })

  it('leaves the operator identity EMPTY by default, so the existing guards fire', () => {
    const identity = plan().vars.filter((v) =>
      ['VENUE_OPERATOR_NAME', 'VENUE_RECEIPTS_BASE_URL', 'VENUE_OPERATOR_API_TOKEN'].includes(v.name),
    )
    expect(identity).toHaveLength(3)
    for (const entry of identity) {
      expect(entry.value, `${entry.name} must be empty without --dev-identity`).toBeUndefined()
      expect(entry.provenance).toBe('operator-must-set')
    }
  })

  it('fills the identity only under --dev-identity, and marks the file with the refusal flag', () => {
    const p = plan({ devIdentity: true })
    expect(p.vars.find((v) => v.name === 'VENUE_OPERATOR_NAME')?.value).toBe(DEV_ONLY.operatorName)
    expect(p.vars.find((v) => v.name === 'VENUE_OPERATOR_API_TOKEN')?.value).toBe(DEV_ONLY.operatorApiToken)
    expect(p.vars.find((v) => v.name === DEV_ONLY_MARKER_ENV)?.value).toBe('1')
  })

  it('refuses fewer than two RPC endpoints, the same refusal the loader makes', () => {
    expect(() => plan({ rpcUrls: ['https://one.invalid'] })).toThrow(/two/)
  })

  it('refuses a malformed factory or deployer override', () => {
    expect(() => plan({ factory: 'not-an-address' })).toThrow(/--factory/)
    expect(() => plan({ deployer: '0x1234' })).toThrow(/--deployer/)
  })
})

describe('the variables apps/api requires', () => {
  /** Kept in step with apps/api/src/config.ts by hand; the test below is why. */
  const REQUIRED = [
    'VENUE_VAULT_INIT_CODE_HASH',
    'VENUE_VAULT_FACTORY',
    'VENUE_VAULT_DEPLOYER',
    'VENUE_RPC_URLS',
    'VENUE_OPERATOR_API_TOKEN',
    'VENUE_OPERATOR_NAME',
    'VENUE_RECEIPTS_BASE_URL',
  ]

  it('are all present in the file, and all flagged as required', () => {
    const p = plan({ devIdentity: true })
    for (const name of REQUIRED) {
      const entry = p.vars.find((v) => v.name === name)
      expect(entry, `${name} is required by apps/api but the bootstrap does not write it`).toBeDefined()
      expect(entry?.requiredByApi, `${name} must be flagged requiredByApi`).toBe(true)
    }
  })

  it('all have a value under --dev-identity, so the API can actually boot', () => {
    const parsed = parseEnvFile(renderEnvFile(plan({ devIdentity: true })))
    for (const name of REQUIRED) {
      expect(parsed[name], `${name} is empty; the API would refuse to boot`).toBeTruthy()
    }
  })

  it('every variable the file writes names what reads it', () => {
    for (const entry of plan().vars) {
      expect(entry.readBy.length, `${entry.name} has no readBy`).toBeGreaterThan(0)
      expect(entry.note.length, `${entry.name} has no note`).toBeGreaterThan(20)
    }
  })
})
