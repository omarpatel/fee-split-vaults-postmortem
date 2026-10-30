import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { preRegistrationDocumentHash, renderPreRegistrationDocument } from '../document.js'
import { sha256Hex } from '../hash.js'
import {
  commitPlan,
  defaultAnalysisPlan,
  PreRegistrationError,
  verifyPreRegistration,
} from '../prereg.js'

const PILOT = 'pilot-2026-q4'
const SEED = 'vault-pilot-bootstrap/v1'

/** The committed artifact. Regenerated only by changing the plan it renders. */
const COMMITTED_PATH = fileURLToPath(
  new URL('../../../../docs/SECTION-9-PRE-REGISTRATION.txt', import.meta.url),
)

describe('the document is a pure function of the plan', () => {
  const plan = defaultAnalysisPlan(PILOT, SEED)

  it('renders identical bytes every time', () => {
    expect(renderPreRegistrationDocument(plan)).toBe(renderPreRegistrationDocument(plan))
  })

  it('moves when any part of the plan moves', () => {
    const moved = defaultAnalysisPlan(PILOT, SEED)
    moved.decisionRule = { ...moved.decisionRule, minFeeEffectPct: 15 }
    expect(preRegistrationDocumentHash(moved)).not.toBe(preRegistrationDocumentHash(plan))
  })

  it('wraps to a fixed column, so the committed bytes do not depend on a viewer', () => {
    for (const line of renderPreRegistrationDocument(plan).split('\n')) {
      expect(line.length).toBeLessThanOrEqual(110)
    }
  })
})

describe('what the document must say out loud', () => {
  const text = renderPreRegistrationDocument(defaultAnalysisPlan(PILOT, SEED))

  it('states the hypothesis, the design and the endpoint', () => {
    expect(text).toContain('1. HYPOTHESIS')
    expect(text).toContain('within_coin_time_randomized')
    expect(text).toContain('[PRIMARY] fees_log1p')
  })

  it('names every registered exclusion with its mechanism and its justification', () => {
    for (const rule of [
      'NON_RANDOMIZED_PHASE',
      'UNVALUED_WINDOW',
      'LAUNCH_WINDOW_ANTI_SNIPE',
      'GRADUATION_MECHANISM_CHANGE',
      'RECIPIENT_CHANGE',
    ]) {
      expect(text).toContain(rule)
    }
    expect(text).toContain('MECHANISM')
    expect(text).toContain('JUSTIFICATION')
    expect(text).toContain('anti-snipe tax of 99% at t=0')
    expect(text).toContain('24 hours from launch')
  })

  it('explains why the whale and the undelivered block are NOT excluded', () => {
    expect(text).toContain('SENSITIVITY ANALYSES (REPORTED, NEVER DECISIVE)')
    expect(text).toContain('WHY IT IS NOT AN EXCLUSION')
    expect(text).toContain('intention-to-treat')
  })

  it('publishes the power derivation, its assumptions and its uncomfortable conclusion', () => {
    expect(text).toContain('7. POWER')
    expect(text).toContain('matched pairs per coin             30')
    expect(text).toContain('CANNOT DETECT +10% AT ANY SAMPLE SIZE')
    expect(text).toContain('INSUFFICIENT')
    expect(text).toContain('MINIMUM DETECTABLE EFFECT')
    expect(text).toContain('SIMULATION SPOT-CHECKS')
  })

  it('commits the words for every outcome, including the null', () => {
    expect(text).toContain('ON SUCCESS')
    expect(text).toContain('ON FAILURE')
    expect(text).toContain('IF UNDERPOWERED')
    expect(text).toContain('IF DELIVERY COMPROMISED')
    expect(text).toContain('DO NOT PROCEED TO PHASE 1')
  })

  it('commits what is published if the result is null', () => {
    expect(text).toContain('10. WHAT IS PUBLISHED, INCLUDING IF THE RESULT IS NULL')
    expect(text).toContain('PUBLICATION COMMITMENT')
    expect(text).toContain('within 30 days of the analysis date')
    expect(text).toContain('the exclusion log')
  })

  it('lists what would invalidate the trial', () => {
    expect(text).toContain('11. WHAT WOULD INVALIDATE THIS TRIAL')
    expect(text).toContain('COMPROMISED_DELIVERY')
  })
})

describe('the document is bound to the commitment', () => {
  const plan = defaultAnalysisPlan(PILOT, SEED)

  it('records the document hash at commitment time', () => {
    const registration = commitPlan(plan, 1_000, 'anchor:0xfeed')
    expect(registration.documentHash).toBe(sha256Hex(renderPreRegistrationDocument(plan)))
    expect(() => verifyPreRegistration(registration, 2_000)).not.toThrow()
  })

  it('REFUSES a registration whose published document was edited after commitment', () => {
    const registration = commitPlan(plan, 1_000)
    registration.documentHash = sha256Hex('a document that says something more convenient')
    expect(() => verifyPreRegistration(registration, 2_000)).toThrow(PreRegistrationError)
    expect(() => verifyPreRegistration(registration, 2_000)).toThrow(
      /does not match the committed plan/,
    )
  })
})

describe('the checked-in artifact', () => {
  it('is exactly what the code renders, so the published document cannot drift', () => {
    const onDisk = readFileSync(COMMITTED_PATH, 'utf8').replace(/\r\n/g, '\n')
    expect(onDisk).toBe(renderPreRegistrationDocument(defaultAnalysisPlan(PILOT, SEED)))
  })
})
