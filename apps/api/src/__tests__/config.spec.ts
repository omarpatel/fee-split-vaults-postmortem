/**
 * The API's boot-time refusals.
 *
 * The operator-name check had NO test at all before this file, on the one
 * surface that gates every other service: apps/api resolves `operatorName` and
 * hands it to the publisher and the desk, so if it boots with a placeholder,
 * everything downstream is publishing under a name that names nobody.
 */

import { describe, expect, it } from 'vitest'
import { DISCLOSURE } from '../../../../config/protocol.js'
import { ConfigError, loadConfig } from '../config.js'
import {
  DEV_ONLY,
  DEV_ONLY_MARKER_ENV,
  isDevOnlyValue,
  isProductionEnv,
  isStructurallyUnreachableAddress,
} from '../../../../config/dev-only.js'

/** A complete, valid environment. Each test breaks exactly one thing. */
function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    VENUE_VAULT_INIT_CODE_HASH: `0x${'11'.repeat(32)}`,
    VENUE_OPERATOR_NAME: 'Acme Ops Ltd',
    VENUE_RECEIPTS_BASE_URL: 'https://receipts.acme-ops.test',
    VENUE_RPC_URLS: 'https://one.invalid,https://two.invalid',
    VENUE_OPERATOR_API_TOKEN: 'x'.repeat(32),
    VENUE_VAULT_FACTORY: `0x${'22'.repeat(20)}`,
    VENUE_VAULT_DEPLOYER: `0x${'33'.repeat(20)}`,
    ...overrides,
  }
}

describe('loadConfig accepts a complete environment', () => {
  it('resolves a real operator name', () => {
    expect(loadConfig(validEnv()).operatorName).toBe('Acme Ops Ltd')
  })

  it('trims the operator name rather than carrying padding into a disclosure', () => {
    expect(loadConfig(validEnv({ VENUE_OPERATOR_NAME: '  Acme Ops Ltd  ' })).operatorName).toBe(
      'Acme Ops Ltd',
    )
  })
})

describe('loadConfig REFUSES TO BOOT while the operator is not named', () => {
  it('refuses when VENUE_OPERATOR_NAME is unset and the shipped constant is the sentinel', () => {
    // This is the shipped state of the repository today.
    expect(DISCLOSURE.operatorName).toBe('SET_ME_BEFORE_LAUNCH')
    const { VENUE_OPERATOR_NAME: _unset, ...env } = validEnv()
    expect(() => loadConfig(env)).toThrow(ConfigError)
    expect(() => loadConfig(env)).toThrow(/VENUE_OPERATOR_NAME/)
  })

  it('refuses every placeholder shape, not only the one sentinel', () => {
    for (const name of ['SET_ME_BEFORE_LAUNCH', 'TBD', 'TODO', 'CHANGEME', 'n/a', 'YOUR_COMPANY', '', ' ', 'X']) {
      expect(
        () => loadConfig(validEnv({ VENUE_OPERATOR_NAME: name })),
        `${JSON.stringify(name)} must refuse the boot`,
      ).toThrow(ConfigError)
    }
  })

  it('says where to fix it', () => {
    const env = validEnv({ VENUE_OPERATOR_NAME: 'TBD' })
    expect(() => loadConfig(env)).toThrow(/config\/protocol\.ts/)
  })
})

describe('the other boot-time refusals that protect a live surface', () => {
  it('refuses a non-https receipts base, because disclosure links are built from it', () => {
    expect(() => loadConfig(validEnv({ VENUE_RECEIPTS_BASE_URL: 'http://receipts.invalid' }))).toThrow(
      /https/,
    )
  })

  it('refuses a single RPC endpoint: one provider is not a quorum', () => {
    expect(() => loadConfig(validEnv({ VENUE_RPC_URLS: 'https://only.invalid' }))).toThrow(
      /at least two/,
    )
  })

  it('reads the fleet spelling too: VENUE_RPC_URL plus VENUE_RPC_URL_SECONDARY, with the named default', () => {
    const { VENUE_RPC_URLS: _unset, ...env } = validEnv({ VENUE_RPC_URL: 'https://one.invalid' })
    expect(loadConfig(env).rpcUrls).toEqual(['https://one.invalid', 'https://rpc.ordofi.network'])
    expect(loadConfig({ ...env, VENUE_RPC_URL_SECONDARY: 'https://two.invalid' }).rpcUrls).toEqual([
      'https://one.invalid',
      'https://two.invalid',
    ])
    expect(() => loadConfig({ ...env, VENUE_RPC_URL_SECONDARY: 'https://one.invalid' })).toThrow(/not a quorum/)
  })

  it('refuses a non-positive request rate', () => {
    expect(() => loadConfig(validEnv({ VENUE_HTTP_RPS: '0' }))).toThrow(/VENUE_HTTP_RPS/)
  })

  it('refuses a short operator token', () => {
    expect(() => loadConfig(validEnv({ VENUE_OPERATOR_API_TOKEN: 'short' }))).toThrow(/32 characters/)
  })

  it('refuses a chain that is not the one the protocol pins', () => {
    expect(() => loadConfig(validEnv({ VENUE_CHAIN_ID: '1' }))).toThrow(/4663/)
  })
})

/**
 * THE DEV-ONLY VALUES MUST NOT SURVIVE A PROMOTION TO PRODUCTION.
 *
 * tools/bootstrap-env.ts exists because this loader failed closed on
 * VENUE_VAULT_INIT_CODE_HASH and nothing said where to get one, so nobody could
 * start the service from a clean checkout. It fills the values that genuinely
 * cannot be derived -- there is no VaultFactory on this chain, and a bearer
 * token is not derivable by anyone -- with the sentinels in config/dev-only.ts.
 * Those are committed, so they are public. Everything below is about making
 * sure a laptop's configuration cannot quietly become a deployment's.
 *
 * Two guards, because the two failure modes are different: shipping the whole
 * generated file, and copying two addresses out of it into a real secret store.
 */
describe('the production guard on DEV-ONLY values', () => {
  const prod = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
    validEnv({ NODE_ENV: 'production', ...overrides })

  it('refuses the bootstrap marker in production, and says how to clear it', () => {
    expect(() => loadConfig(prod({ [DEV_ONLY_MARKER_ENV]: '1' }))).toThrow(ConfigError)
    expect(() => loadConfig(prod({ [DEV_ONLY_MARKER_ENV]: '1' }))).toThrow(/bootstrap-env/)
  })

  it.each([
    ['VENUE_VAULT_FACTORY', DEV_ONLY.factory],
    ['VENUE_VAULT_DEPLOYER', DEV_ONLY.deployer],
    ['VENUE_OPERATOR_API_TOKEN', DEV_ONLY.operatorApiToken],
    ['VENUE_RECEIPTS_BASE_URL', DEV_ONLY.receiptsBaseUrl],
    ['VENUE_OPERATOR_NAME', DEV_ONLY.operatorName],
  ])('refuses the published %s in production even with no marker present', (key, value) => {
    expect(() => loadConfig(prod({ [key]: value }))).toThrow(ConfigError)
    expect(() => loadConfig(prod({ [key]: value }))).toThrow(new RegExp(key))
  })

  it('refuses any address no CREATE or CREATE2 can reach, not only the one sentinel', () => {
    // A different vanity-zero address is just as impossible and just as wrong.
    const impossible = `0x${'0'.repeat(32)}${'c0ffee01'}`
    expect(() => loadConfig(prod({ VENUE_VAULT_DEPLOYER: impossible }))).toThrow(
      /no CREATE or CREATE2 can reach/,
    )
  })

  it('ACCEPTS every one of them outside production, which is the whole point', () => {
    // An unset NODE_ENV is a laptop. Refusing here would undo the change that
    // made the service startable at all.
    const config = loadConfig(
      validEnv({
        [DEV_ONLY_MARKER_ENV]: '1',
        VENUE_VAULT_FACTORY: DEV_ONLY.factory,
        VENUE_VAULT_DEPLOYER: DEV_ONLY.deployer,
        VENUE_OPERATOR_API_TOKEN: DEV_ONLY.operatorApiToken,
        VENUE_RECEIPTS_BASE_URL: DEV_ONLY.receiptsBaseUrl,
        VENUE_OPERATOR_NAME: DEV_ONLY.operatorName,
      }),
    )
    expect(config.factory.factory).toBe(DEV_ONLY.factory)
    expect(config.operatorName).toBe(DEV_ONLY.operatorName)
  })

  it('accepts a real-looking deployment in production', () => {
    expect(() =>
      loadConfig(
        prod({
          VENUE_VAULT_FACTORY: '0x1d1499e622d69689cdf9004d05ec547d650ff211',
          VENUE_VAULT_DEPLOYER: '0x45c92c2cd0df7b2d705ef12cff77cb0bc557ed22',
        }),
      ),
    ).not.toThrow()
  })

  it('treats an explicit VENUE_DEV_ONLY_CONFIG=0 as absent', () => {
    expect(() => loadConfig(prod({ [DEV_ONLY_MARKER_ENV]: '0' }))).not.toThrow()
  })
})

describe('the dev-only predicates themselves', () => {
  it('is case-insensitive and whitespace-tolerant, because env files are hand-edited', () => {
    expect(isDevOnlyValue(`  ${DEV_ONLY.factory.toUpperCase()}  `)).toBe(true)
  })

  it('does not fire on an empty or absent value', () => {
    expect(isDevOnlyValue('')).toBe(false)
    expect(isDevOnlyValue(undefined)).toBe(false)
  })

  it('recognises an unreachable address, and leaves a real one alone', () => {
    expect(isStructurallyUnreachableAddress(DEV_ONLY.factory)).toBe(true)
    expect(isStructurallyUnreachableAddress('0x1d1499e622d69689cdf9004d05ec547d650ff211')).toBe(false)
    // The derived deployer is a real keccak output and looks entirely normal.
    // That is why the exact-value list exists alongside the shape check.
    expect(isStructurallyUnreachableAddress(DEV_ONLY.deployer)).toBe(false)
    expect(isDevOnlyValue(DEV_ONLY.deployer)).toBe(true)
  })

  it('only calls NODE_ENV=production production', () => {
    expect(isProductionEnv({ NODE_ENV: 'production' })).toBe(true)
    expect(isProductionEnv({ NODE_ENV: 'PRODUCTION' })).toBe(true)
    expect(isProductionEnv({ NODE_ENV: 'staging' })).toBe(false)
    expect(isProductionEnv({})).toBe(false)
  })
})

describe('the X application is configured whole or not at all', () => {
  const X = {
    X_CLIENT_ID: 'client-1',
    X_CLIENT_SECRET: 'shh',
    X_REDIRECT_URI: 'https://ops.acme-ops.test/accounts/x/callback',
    PUBLISHER_TOKEN_KEY: 'ab'.repeat(32),
  }

  it('is absent when nothing is set, and the routes stay unconfigured', () => {
    const config = loadConfig(validEnv())
    expect(config.x).toBeUndefined()
    expect(config.publisherTokenKey).toBeUndefined()
  })

  it('accepts the full set and strips a 0x prefix from the key', () => {
    const config = loadConfig(validEnv({ ...X, PUBLISHER_TOKEN_KEY: `0x${X.PUBLISHER_TOKEN_KEY}` }))
    expect(config.x).toEqual({ clientId: 'client-1', clientSecret: 'shh', redirectUri: X.X_REDIRECT_URI })
    expect(config.publisherTokenKey).toBe(X.PUBLISHER_TOKEN_KEY)
  })

  it('refuses a client id without a key to store its tokens under', () => {
    const { PUBLISHER_TOKEN_KEY: _unset, ...env } = validEnv(X)
    expect(() => loadConfig(env)).toThrow(/PUBLISHER_TOKEN_KEY/)
  })

  it('refuses a client id without a redirect, and a redirect that is not https', () => {
    const { X_REDIRECT_URI: _unset, ...env } = validEnv(X)
    expect(() => loadConfig(env)).toThrow(/X_REDIRECT_URI/)
    expect(() => loadConfig(validEnv({ ...X, X_REDIRECT_URI: 'http://ops.acme-ops.test/cb' }))).toThrow(/https/)
  })

  it('refuses a key that is not 32 bytes of hex', () => {
    expect(() => loadConfig(validEnv({ ...X, PUBLISHER_TOKEN_KEY: 'ab'.repeat(16) }))).toThrow(/32 bytes/)
  })
})

describe('the live dependencies the API resolves from the same variables as the fleet', () => {
  it('reads the X bearer, the font files and the signer key, none of which is required', () => {
    const bare = loadConfig(validEnv())
    expect(bare.xReadBearerToken).toBeUndefined()
    expect(bare.operatorSignerKey).toBeUndefined()
    expect(bare.creativeFontFiles).toEqual([])
    expect(bare.prices).toBeUndefined()

    const config = loadConfig(
      validEnv({
        X_READ_BEARER_TOKEN: 'AAAA-bearer',
        CREATIVE_FONT_FILES: ' /fonts/a.ttf, /fonts/b.ttf ,',
        OPERATOR_SIGNER_KEY: `0x${'AB'.repeat(32)}`,
      }),
    )
    expect(config.xReadBearerToken).toBe('AAAA-bearer')
    expect(config.creativeFontFiles).toEqual(['/fonts/a.ttf', '/fonts/b.ttf'])
    expect(config.operatorSignerKey).toBe(`0x${'ab'.repeat(32)}`)
  })

  it('refuses a signer key that is not 32 bytes of hex rather than deploying with half a key', () => {
    expect(() => loadConfig(validEnv({ OPERATOR_SIGNER_KEY: 'ab'.repeat(32) }))).toThrow(/OPERATOR_SIGNER_KEY/)
  })

  it('FLEET_PRICES=coingecko needs COINGECKO_IDS shaped as address -> id, all or nothing', () => {
    const asset = `0x${'5f'.repeat(20)}`
    const config = loadConfig(
      validEnv({ FLEET_PRICES: 'coingecko', COINGECKO_IDS: JSON.stringify({ [asset.toUpperCase().replace('0X', '0x')]: 'global-dollar' }), COINGECKO_API_KEY: 'k' }),
    )
    expect(config.prices).toEqual({ ids: { [asset]: 'global-dollar' }, apiKey: 'k' })

    expect(() => loadConfig(validEnv({ FLEET_PRICES: 'coingecko' }))).toThrow(/COINGECKO_IDS/)
    expect(() => loadConfig(validEnv({ FLEET_PRICES: 'coingecko', COINGECKO_IDS: '{' }))).toThrow(/not JSON/)
    expect(() => loadConfig(validEnv({ FLEET_PRICES: 'coingecko', COINGECKO_IDS: '{}' }))).toThrow(/maps no asset/)
    expect(() => loadConfig(validEnv({ FLEET_PRICES: 'coingecko', COINGECKO_IDS: '{"usdg":"global-dollar"}' }))).toThrow(
      /address -> id/,
    )
    expect(() => loadConfig(validEnv({ FLEET_PRICES: 'binance' }))).toThrow(/not a mode/)
  })
})
