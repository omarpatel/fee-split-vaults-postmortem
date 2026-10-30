import { describe, expect, it } from 'vitest'

import { AbiEncodingError, wordFromUint } from '../abi.js'
import { encodeSetDial, encodeTerminate, encodeTransferCreatorFeeRecipient, selector } from '../calldata.js'
import {
  CONSENT_TYPE_STRING,
  consentDigest,
  consentSalt,
  consentStructHash,
  consentTypedData,
  domainSeparator,
  normaliseUnsigned,
  predictCreate2,
  predictVaultAddress,
  ZERO_ADDRESS,
  type ConsentStruct,
  type VaultDeploymentAddresses,
} from '../consent.js'
import { bytesToHex } from '../hex.js'
import { keccak256 } from '../keccak.js'

const DEPLOYMENT: VaultDeploymentAddresses = {
  chainId: 4663,
  factory: '0x1111111111111111111111111111111111111111',
  vaultDeployer: '0x2222222222222222222222222222222222222222',
  vaultInitCodeHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
}

const CONSENT: ConsentStruct = {
  devSigner: '0x00000000000000000000000000000000000000a1',
  devPayout: '0x00000000000000000000000000000000000000a2',
  token: '0x00000000000000000000000000000000000000a3',
  termsHash: '0x00000000000000000000000000000000000000000000000000000000000000b1',
  operatorBps: 1_000,
  budgetBpsMax: 4_000,
  adapter: '0x00000000000000000000000000000000000000a4',
  referrer: ZERO_ADDRESS,
  referrerBps: 0,
  expiryUnix: 1_790_000_000,
  nonce: '0x00000000000000000000000000000000000000000000000000000000000000c1',
}

describe('CREATE2 prediction', () => {
  // EIP-1014's own vectors. init_code 0x00, so initCodeHash = keccak256(0x00).
  const initCodeHashOfZeroByte = bytesToHex(keccak256(new Uint8Array([0x00])))
  const zeroSalt = `0x${'0'.repeat(64)}`

  it('matches EIP-1014 example 0', () => {
    expect(
      predictCreate2('0x0000000000000000000000000000000000000000', zeroSalt, initCodeHashOfZeroByte),
    ).toBe('0x4d1a2e2bb4f88f0250f26ffff098b0b30b26bf38')
  })

  it('matches EIP-1014 example 1', () => {
    expect(
      predictCreate2('0xdeadbeef00000000000000000000000000000000', zeroSalt, initCodeHashOfZeroByte),
    ).toBe('0xb928f69bb1d91cd65274e3c79d8986362984fda3')
  })

  it('derives from the DEPLOYER, not the factory', () => {
    const viaDeployer = predictVaultAddress(CONSENT, DEPLOYMENT)
    const viaFactory = predictCreate2(
      DEPLOYMENT.factory,
      consentSalt(CONSENT),
      DEPLOYMENT.vaultInitCodeHash,
    )
    expect(viaDeployer).not.toBe(viaFactory)
  })
})

describe('the consent salt is the whole agreement', () => {
  it('is deterministic', () => {
    expect(consentSalt(CONSENT)).toBe(consentSalt({ ...CONSENT }))
  })

  // The load-bearing claim of the whole onboarding flow: a different rate is a
  // different address, so an existing customer cannot be repriced.
  it('changes the vault address when the operator fee changes', () => {
    const cheaper = { ...CONSENT, operatorBps: CONSENT.operatorBps - 1 }
    expect(consentSalt(cheaper)).not.toBe(consentSalt(CONSENT))
    expect(predictVaultAddress(cheaper, DEPLOYMENT)).not.toBe(predictVaultAddress(CONSENT, DEPLOYMENT))
  })

  it('changes the vault address when any other economic term changes', () => {
    const baseline = predictVaultAddress(CONSENT, DEPLOYMENT)
    const variants: ConsentStruct[] = [
      { ...CONSENT, budgetBpsMax: 3_900 },
      { ...CONSENT, devPayout: '0x00000000000000000000000000000000000000ff' },
      { ...CONSENT, adapter: '0x00000000000000000000000000000000000000fe' },
      { ...CONSENT, referrer: '0x00000000000000000000000000000000000000fd', referrerBps: 1_500 },
      { ...CONSENT, termsHash: `0x${'b2'.repeat(32)}` },
      { ...CONSENT, nonce: `0x${'c2'.repeat(32)}` },
      { ...CONSENT, expiryUnix: CONSENT.expiryUnix + 1 },
      { ...CONSENT, token: '0x00000000000000000000000000000000000000fc' },
    ]
    for (const variant of variants) {
      expect(predictVaultAddress(variant, DEPLOYMENT)).not.toBe(baseline)
    }
  })

  it('is not confusable between the two adjacent uint16 fields', () => {
    // abi.encode pads each field to its own word; a packed encoding would make
    // (1000, 4000) and (10, 4000) collide-prone. These must differ.
    const swapped = { ...CONSENT, operatorBps: 4_000, budgetBpsMax: 1_000 }
    expect(consentSalt(swapped)).not.toBe(consentSalt(CONSENT))
  })

  it('lands the unsigned path at a different address than the signed one', () => {
    const normalised = normaliseUnsigned(CONSENT)
    expect(normalised.operatorBps).toBe(0)
    expect(normalised.budgetBpsMax).toBe(0)
    expect(predictVaultAddress(normalised, DEPLOYMENT)).not.toBe(
      predictVaultAddress(CONSENT, DEPLOYMENT),
    )
  })
})

describe('EIP-712', () => {
  it('lists the fields in the contract’s order', () => {
    const fields = CONSENT_TYPE_STRING.slice('Consent('.length, -1)
      .split(',')
      .map((entry) => entry.split(' ')[1])

    expect(fields).toEqual([
      'devSigner',
      'devPayout',
      'token',
      'termsHash',
      'operatorBps',
      'budgetBpsMax',
      'adapter',
      'referrer',
      'referrerBps',
      'expiryUnix',
      'nonce',
    ])
  })

  it('keeps the typed-data field order identical to the type string', () => {
    const typed = consentTypedData(CONSENT, DEPLOYMENT)
    const fromTypeString = CONSENT_TYPE_STRING.slice('Consent('.length, -1)
      .split(',')
      .map((entry) => {
        const [type, name] = entry.split(' ')
        return { name: name ?? '', type: type ?? '' }
      })
    expect(typed.types.Consent).toEqual(fromTypeString)
  })

  it('distinguishes hashStruct from the salt by the typehash prefix', () => {
    expect(consentStructHash(CONSENT)).not.toBe(consentSalt(CONSENT))
  })

  it('binds the digest to the chain and the verifying contract', () => {
    const here = consentDigest(CONSENT, 4663, DEPLOYMENT.factory)
    expect(consentDigest(CONSENT, 1, DEPLOYMENT.factory)).not.toBe(here)
    expect(consentDigest(CONSENT, 4663, '0x9999999999999999999999999999999999999999')).not.toBe(here)
  })

  it('produces a 32-byte domain separator that depends on the chain', () => {
    const separator = domainSeparator(4663, DEPLOYMENT.factory)
    expect(separator).toHaveLength(66)
    expect(domainSeparator(4664, DEPLOYMENT.factory)).not.toBe(separator)
  })
})

describe('calldata', () => {
  it('encodes the selectors the contracts actually expose', () => {
    expect(encodeTerminate()).toBe(selector('terminate()'))
    expect(encodeTerminate()).toHaveLength(10)
  })

  it('encodes setDial with the dial padded into a full word', () => {
    const data = encodeSetDial(2_500)
    expect(data.startsWith(selector('setDial(uint16)'))).toBe(true)
    expect(data).toHaveLength(10 + 64)
    expect(data.endsWith('09c4')).toBe(true)
  })

  it('encodes the recipiency transfer with both addresses left-padded', () => {
    const data = encodeTransferCreatorFeeRecipient(
      '0x00000000000000000000000000000000000000a3',
      '0x00000000000000000000000000000000000000b7',
    )
    expect(data.startsWith(selector('transferCreatorFeeRecipient(address,address)'))).toBe(true)
    expect(data).toHaveLength(10 + 128)
    expect(data.slice(10, 74)).toBe(`${'0'.repeat(24)}00000000000000000000000000000000000000a3`)
  })

  it('refuses to encode a value that overflows its declared width', () => {
    expect(() => wordFromUint(65_536n, 16)).toThrow(AbiEncodingError)
    expect(() => wordFromUint(-1n, 16)).toThrow(AbiEncodingError)
  })
})
