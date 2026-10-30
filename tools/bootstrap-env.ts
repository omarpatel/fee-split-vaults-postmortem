/**
 * bootstrap-env - derive every derivable configuration value and write a
 * runnable .env.local.
 *
 * THE DEFECT THIS CLOSES. From a clean checkout,
 *
 *     node apps/api/dist/main.js
 *     ConfigError: config: VENUE_VAULT_INIT_CODE_HASH is required and has no safe default
 *
 * and nothing in the repository said where that value comes from. The loader
 * failing closed is CORRECT and is untouched here. The bug was that no path
 * existed to a valid value, so the control plane could not be started by
 * anybody, ever. This tool is that path.
 *
 * WHAT IT REFUSES TO DO. It does not invent a factory address. There is no
 * VaultFactory on chain 4663 -- config/protocol.ts lists Venue' own V2 contracts
 * and none of ours -- so VENUE_VAULT_FACTORY has no real value to write, and a
 * plausible-looking one is exactly the failure the fail-closed loader exists to
 * prevent: a wrong factory address is a dev pointing their fee revenue at a
 * contract that does not exist. What it writes instead is the published
 * sentinel from config/dev-only.ts, which has 32 leading zero nibbles, is
 * obviously fake in any log line, and which apps/api REFUSES when
 * NODE_ENV=production. Pass --factory once a real one is deployed.
 *
 * WHAT IS GENUINELY DERIVED, not defaulted:
 *
 *   VENUE_VAULT_INIT_CODE_HASH  keccak256 of CoinVault's compiled creation code,
 *                              read from contracts/out/. A real value, correct
 *                              for any future deployment of this bytecode.
 *   VENUE_VAULT_DEPLOYER        CREATE(factory, 1). Derived from whatever factory
 *                              address is in play, real or sentinel, so the
 *                              triple always predicts the address that factory
 *                              would actually deploy to.
 *
 * Both derivations are pinned on the Solidity side by
 * contracts/test/unit/DerivedDeployment.t.sol and on this side by
 * tools/__tests__/deployment-derivation.spec.ts.
 */

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import type { ParsedValues } from './lib/cli.ts'
import { CliError, getBool, getList, getString, isEntrypoint, runCli } from './lib/cli.ts'
import { heading, subheading, table } from './lib/format.ts'
import { emit, type Report } from './lib/report.ts'
import {
  assertDeterministicBuildSettings,
  deriveVaultDeployer,
  deriveVaultInitCodeHash,
  predictCreate2,
  DerivationError,
} from './lib/deployment-derivation.ts'
import { DEV_ONLY, DEV_ONLY_MARKER_ENV } from '../config/dev-only.ts'
import { VENUE } from '../config/protocol.ts'

const SCHEMA_VERSION = 'bootstrap-env-1'

/** Repo root, resolved against this file so the tool works from any cwd. */
export const REPO_ROOT = join(import.meta.dirname, '..')

/**
 * How a value came to be. This is the whole point of the tool's output: an
 * operator has to be able to tell, per line, whether they are looking at a fact,
 * a convenience, or something that will get them hurt in production.
 */
export type Provenance =
  | 'derived' // computed from repository artifacts; a real, correct value
  | 'safe-default' // a real value that cannot point at the wrong thing
  | 'dev-only' // fake, published in git, refused when NODE_ENV=production
  | 'operator-must-set' // a placeholder the existing guards reject on purpose
  | 'optional' // unset, and unset is a supported state

export interface EnvVar {
  name: string
  /** Undefined means the line is written commented out. */
  value: string | undefined
  provenance: Provenance
  /** Printed above the line in .env.local. One or more sentences. */
  note: string
  /** Which code reads it. Provenance for the audit, not decoration. */
  readBy: string
  /** True when apps/api refuses to boot without it. */
  requiredByApi?: boolean
}

export interface BootstrapPlan {
  initCodeHash: string
  initCodeBytes: number
  artifactPath: string
  factory: string
  deployer: string
  factoryIsSentinel: boolean
  devIdentity: boolean
  /** A vault address predicted from the triple. Proves the three agree. */
  selfCheckVault: string
  vars: EnvVar[]
}

const SPEC = {
  name: 'bootstrap-env',
  summary: 'Derive the deployment constants and write a runnable .env.local.',
  detail: `
    apps/api fails closed on VENUE_VAULT_INIT_CODE_HASH and four other variables, and
    nothing documented where to get them, so a clean checkout could not start the
    service at all. This derives the two derivable ones from contracts/out/, fills the
    rest with defaults that cannot point at the wrong chain or the wrong factory, and
    leaves the operator's own identity as a placeholder the existing guards reject.
    Values it cannot derive are written as DEV-ONLY sentinels that apps/api refuses
    when NODE_ENV=production.
  `,
  options: [
    {
      // NOT --env-file. Node intercepts `--env-file` ANYWHERE in argv, including
      // after the script path, and loads that file into the process environment
      // before the script runs. Naming a flag `--env-file` here made
      // `node tools/bootstrap-env.ts --env-file .env.local` exit 9 with
      // "node: .env.local: not found" -- the file this command exists to create.
      // Verified on Node v24.18.1: `--env-out` and `--env` pass through, `--env-file` does not.
      name: 'env-out',
      type: 'string' as const,
      placeholder: '<path>',
      describe: 'Where to write the environment file. Relative paths resolve against the repo root.',
      default: '.env.local',
    },
    {
      name: 'force',
      type: 'boolean' as const,
      describe: 'Overwrite an existing environment file. Without it an existing file is left alone.',
    },
    {
      name: 'factory',
      type: 'string' as const,
      placeholder: '<0x...>',
      describe:
        'A real deployed VaultFactory. The deployer is derived from it. Omit to use the DEV-ONLY sentinel.',
    },
    {
      name: 'deployer',
      type: 'string' as const,
      placeholder: '<0x...>',
      describe:
        'Override factory.deployer(). Only for a factory whose deployer was not its nonce-1 CREATE.',
    },
    {
      name: 'rpc',
      type: 'string[]' as const,
      placeholder: '<url,url>',
      describe: 'JSON-RPC endpoints. Two or more; the indexer requires a quorum and has no fallback.',
      default: ['https://rpc.mainnet.chain.robinhood.com', 'https://rpc.ordofi.network'],
    },
    {
      name: 'dev-identity',
      type: 'boolean' as const,
      describe:
        'Also fill the operator name, API token and receipts URL with DEV-ONLY values so the API can boot. Without it those stay placeholders the guards reject.',
    },
    {
      name: 'port',
      type: 'number' as const,
      describe: 'Port for apps/api.',
      default: 8080,
    },
  ],
  examples: [
    'node tools/bootstrap-env.ts --dry-run          # show the file, write nothing',
    'node tools/bootstrap-env.ts --dev-identity     # a .env.local the API will actually boot on',
    'node tools/bootstrap-env.ts --factory 0xabc... --force   # against a real deployment',
  ],
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

function normalizeAddressArg(value: string, flag: string): string {
  const trimmed = value.trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    throw new CliError(`--${flag} must be a 0x-prefixed 20-byte address, got ${JSON.stringify(value)}`)
  }
  return trimmed.toLowerCase()
}

export interface BuildPlanOptions {
  contractsDir?: string
  factory?: string | undefined
  deployer?: string | undefined
  rpcUrls: readonly string[]
  devIdentity: boolean
  port: number
}

export function buildPlan(options: BuildPlanOptions): BootstrapPlan {
  const contractsDir = options.contractsDir
  if (contractsDir === undefined) assertDeterministicBuildSettings()
  else assertDeterministicBuildSettings(contractsDir)

  const derived =
    contractsDir === undefined ? deriveVaultInitCodeHash() : deriveVaultInitCodeHash(contractsDir)

  const factoryIsSentinel = options.factory === undefined
  const factory = factoryIsSentinel
    ? DEV_ONLY.factory
    : normalizeAddressArg(options.factory as string, 'factory')
  const deployer =
    options.deployer === undefined
      ? deriveVaultDeployer(factory)
      : normalizeAddressArg(options.deployer, 'deployer')

  if (options.rpcUrls.length < 2) {
    // Mirrors the loader's own refusal, so the failure lands here with a fix
    // rather than three commands later with a stack trace.
    throw new CliError(
      `--rpc needs at least two endpoints; got ${String(options.rpcUrls.length)}. The indexer sends ` +
        'every read to two providers and refuses unless they agree exactly. There is no single-provider fallback.',
    )
  }

  // Not decoration: it exercises the same CREATE2 preimage apps/api uses, so a
  // triple that cannot produce a well-formed address never reaches a file.
  const selfCheckVault = predictCreate2(deployer, `0x${'00'.repeat(32)}`, derived.initCodeHash)

  const vars: EnvVar[] = [
    {
      name: 'VENUE_CHAIN_ID',
      value: String(VENUE.chainId),
      provenance: 'safe-default',
      note: 'Pinned by config/protocol.ts. Any other value is refused at boot: a service on another chain verifies signatures against the wrong EIP-712 domain.',
      readBy: 'apps/api/src/config.ts, tools/lib/env.ts',
    },
    {
      name: 'VENUE_RPC_URLS',
      value: options.rpcUrls.join(','),
      provenance: 'safe-default',
      note: 'Two keyless public endpoints for chain 4663, both verified reachable. Two is the minimum and is not negotiable: the indexer requires a quorum and has no single-provider fallback.',
      readBy: 'apps/api/src/config.ts',
      requiredByApi: true,
    },
    {
      name: 'VENUE_RPC_URL',
      value: options.rpcUrls[0],
      provenance: 'safe-default',
      note: 'Single-endpoint alias used only by tools/ (measurement scripts, not the service).',
      readBy: 'tools/lib/env.ts',
    },
    {
      name: 'VENUE_VAULT_INIT_CODE_HASH',
      value: derived.initCodeHash,
      provenance: 'derived',
      note:
        `DERIVED, not a default: keccak256 of CoinVault's compiled creation code (${String(derived.initCodeBytes)} bytes), ` +
        'read from contracts/out/. CoinVault takes no constructor arguments, so the init code is the artifact ' +
        'bytecode with nothing appended, and foundry.toml disables metadata so the hash does not depend on file paths. ' +
        'This is a REAL value and stays correct for any deployment of this bytecode. Re-run bootstrap-env after ' +
        'any change to contracts/src/CoinVault.sol.',
      readBy: 'apps/api/src/config.ts -> deploy.ts predictVault()',
      requiredByApi: true,
    },
    {
      name: 'VENUE_VAULT_FACTORY',
      value: factory,
      provenance: factoryIsSentinel ? 'dev-only' : 'safe-default',
      note: factoryIsSentinel
        ? 'DEV-ONLY SENTINEL. No VaultFactory is deployed on chain 4663, so there is no real value to write. ' +
          'This address has 32 leading zero nibbles, which no CREATE or CREATE2 reaches, and apps/api refuses ' +
          'it when NODE_ENV=production. Re-run with --factory <address> once one exists.'
        : 'Supplied with --factory. Also the EIP-712 verifyingContract, so signatures bind to this factory as well as this chain.',
      readBy: 'apps/api/src/config.ts (factory + EIP-712 domain)',
      requiredByApi: true,
    },
    {
      name: 'VENUE_VAULT_DEPLOYER',
      value: deployer,
      provenance: options.deployer !== undefined ? 'safe-default' : factoryIsSentinel ? 'dev-only' : 'derived',
      note:
        'DERIVED as CREATE(factory, 1). THIS IS THE CREATE2 BASE, NOT THE FACTORY: VaultFactory embedding ' +
        "CoinVault's init code exceeded EIP-170, so it delegates to a VaultDeployer its constructor creates, " +
        'and a contract\'s first CREATE uses nonce 1. Using the factory address here yields wrong vault ' +
        'addresses silently.' +
        (factoryIsSentinel ? ' Derived from the DEV-ONLY factory above, so it is dev-only too.' : ''),
      readBy: 'apps/api/src/config.ts -> deploy.ts predictVault()',
      requiredByApi: true,
    },
    {
      name: 'PORT',
      value: String(options.port),
      provenance: 'safe-default',
      note: 'apps/api listen port.',
      readBy: 'apps/api/src/config.ts',
    },
    {
      name: 'VENUE_SCREENING_MAX_AGE_SECONDS',
      value: String(7 * 24 * 3600),
      provenance: 'safe-default',
      note: 'How stale a screening may be before activation is refused. The loader default, written out so it is visible.',
      readBy: 'apps/api/src/config.ts',
    },
    {
      name: 'VENUE_ANTI_SNIPE_HOLD_SECONDS',
      value: String(900),
      provenance: 'safe-default',
      note: 'How long after launch before a coin may be ACTIVATED. Charging happens only in ACTIVE, so holding activation is the whole mitigation for the anti-snipe tax windfall.',
      readBy: 'apps/api/src/config.ts',
    },
    {
      name: 'VENUE_OPERATOR_NAME',
      value: options.devIdentity ? DEV_ONLY.operatorName : undefined,
      provenance: options.devIdentity ? 'dev-only' : 'operator-must-set',
      note: options.devIdentity
        ? 'DEV-ONLY. Names no legal entity. It passes the placeholder predicate only so a local process can boot; apps/api refuses it when NODE_ENV=production.'
        : 'YOU MUST SET THIS. The legal operating entity. Left unset on purpose: packages/core rejects every ' +
          'placeholder shape, so the API, the publisher and the desk all refuse to construct until a real name ' +
          'is on record. Nothing can be published under a name that names nobody.',
      readBy: 'apps/api/src/config.ts via packages/core requireOperatorName()',
      requiredByApi: true,
    },
    {
      name: 'VENUE_RECEIPTS_BASE_URL',
      value: options.devIdentity ? DEV_ONLY.receiptsBaseUrl : undefined,
      provenance: options.devIdentity ? 'dev-only' : 'operator-must-set',
      note: options.devIdentity
        ? 'DEV-ONLY. RFC 2606 reserves .invalid to never resolve, so a receipt link built from it is visibly local rather than a promise nobody can keep. Refused when NODE_ENV=production.'
        : 'YOU MUST SET THIS. Public receipts base, https only. Every disclosure footer builds its receipt link from it, so it is part of the compliance surface.',
      readBy: 'apps/api/src/config.ts',
      requiredByApi: true,
    },
    {
      name: 'VENUE_OPERATOR_API_TOKEN',
      value: options.devIdentity ? DEV_ONLY.operatorApiToken : undefined,
      provenance: options.devIdentity ? 'dev-only' : 'operator-must-set',
      note: options.devIdentity
        ? 'DEV-ONLY and PUBLIC: this exact string is committed in config/dev-only.ts, so it protects nothing. apps/api refuses it when NODE_ENV=production.'
        : 'YOU MUST SET THIS. Bearer token for every non-public API route, at least 32 characters, compared in ' +
          'constant time. Generate one that is not in any repository:  node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"',
      readBy: 'apps/api/src/http/server.ts',
      requiredByApi: true,
    },
    {
      name: DEV_ONLY_MARKER_ENV,
      value: options.devIdentity || factoryIsSentinel ? '1' : undefined,
      provenance: 'dev-only',
      note: 'Marks this file as bootstrap-generated with DEV-ONLY values in it. apps/api refuses to boot with it set when NODE_ENV=production. Delete it only when every dev-only line above has been replaced.',
      readBy: 'apps/api/src/config.ts',
    },
    {
      name: 'OPS_ALLOW_FAKE_PORTS',
      value: '1',
      provenance: 'dev-only',
      note: 'Runs the ops scheduler against in-memory fakes. DEVELOPMENT ONLY: unset it and set OPS_PORTS_MODULE to a module that supplies the real adapter ports.',
      readBy: 'ops/scheduler/main.ts',
    },
    {
      name: 'OPS_PORTS_MODULE',
      value: undefined,
      provenance: 'optional',
      note: 'Module path providing the real adapter ports. Required unless OPS_ALLOW_FAKE_PORTS=1.',
      readBy: 'ops/scheduler/main.ts',
    },
    {
      name: 'DATABASE_URL',
      value: undefined,
      provenance: 'optional',
      note: 'Postgres for the ops scheduler, the migrations CLI and `ops status`. Unset means the in-memory stores, which do not survive a restart. docker-compose.yml at the repo root brings up a local one.',
      readBy: 'ops/lib/pg.ts, ops/migrations/cli.ts',
    },
    {
      name: 'ANTHROPIC_API_KEY',
      value: undefined,
      provenance: 'optional',
      note: 'UNSET MEANS NO MODEL RUNS AT ALL, which is a working local state: T0 is deterministic by design. Every paid tier needs a key.',
      readBy: 'packages/runtime/src/model/anthropic.ts',
    },
    {
      name: 'TELEGRAM_BOT_TOKEN',
      value: undefined,
      provenance: 'optional',
      note: 'Desk and publisher Telegram channel. Unset means the in-memory fake, which fails closed.',
      readBy: 'packages/desk/src/telegram/client.ts',
    },
    {
      name: 'VENUE_DATA_DIR',
      value: undefined,
      provenance: 'optional',
      note: 'Overrides where packages/catalog reads vendor, SKU and rate-card data. Defaults to data/ next to the package, which is checked in and correct.',
      readBy: 'packages/catalog/src/paths.ts',
    },
  ]

  return {
    initCodeHash: derived.initCodeHash,
    initCodeBytes: derived.initCodeBytes,
    artifactPath: derived.artifactPath,
    factory,
    deployer,
    factoryIsSentinel,
    devIdentity: options.devIdentity,
    selfCheckVault,
    vars,
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const PROVENANCE_LABEL: Record<Provenance, string> = {
  derived: 'DERIVED',
  'safe-default': 'safe default',
  'dev-only': 'DEV-ONLY',
  'operator-must-set': 'YOU MUST SET',
  optional: 'optional',
}

function wrapComment(text: string, width = 96): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    if (line.length > 0 && line.length + word.length + 1 > width) {
      out.push(line)
      line = word
    } else {
      line = line.length === 0 ? word : `${line} ${word}`
    }
  }
  if (line.length > 0) out.push(line)
  return out
}

/** The .env.local text. Deterministic, so re-running produces no diff noise. */
export function renderEnvFile(plan: BootstrapPlan): string {
  const lines: string[] = []
  lines.push('#'.repeat(78))
  lines.push('# GENERATED BY  node tools/bootstrap-env.ts  -- safe to edit, safe to regenerate.')
  lines.push('#')
  lines.push('# .gitignore excludes .env.* (except .env.example), so this file is never committed.')
  lines.push('# Every line is tagged with where its value came from:')
  lines.push('#')
  lines.push('#   [DERIVED]        computed from repository artifacts. A real value.')
  lines.push('#   [safe default]   a real value that cannot point at the wrong chain or contract.')
  lines.push('#   [DEV-ONLY]       fake, published in git, REFUSED by apps/api when NODE_ENV=production.')
  lines.push('#   [YOU MUST SET]   left empty on purpose; the existing guards reject it until you do.')
  lines.push('#   [optional]       unset is a supported state.')
  lines.push('#')
  if (plan.devIdentity) {
    lines.push('# THIS FILE CONTAINS DEV-ONLY OPERATOR IDENTITY VALUES (--dev-identity). It is for a')
    lines.push('# laptop. Do not deploy it: apps/api refuses every one of them when NODE_ENV=production.')
  } else {
    lines.push('# The operator identity below is deliberately EMPTY. apps/api will refuse to boot and')
    lines.push('# name the variable. That is the intended state until a real operator fills it in;')
    lines.push('# for a local demo run bootstrap-env again with --dev-identity.')
  }
  lines.push('#')
  lines.push(`# Init code hash source: ${plan.artifactPath.replace(/\\/g, '/')}`)
  lines.push(`#   keccak256 over ${String(plan.initCodeBytes)} bytes of CoinVault creation code.`)
  lines.push('#'.repeat(78))
  lines.push('')

  for (const entry of plan.vars) {
    for (const line of wrapComment(`[${PROVENANCE_LABEL[entry.provenance]}] ${entry.note}`)) {
      lines.push(`# ${line}`)
    }
    lines.push(`#   read by: ${entry.readBy}`)
    if (entry.value === undefined) {
      lines.push(`${entry.name}=`)
    } else {
      lines.push(`${entry.name}=${entry.value}`)
    }
    lines.push('')
  }

  lines.push('# Every remaining variable any package reads is documented in .env.example, including')
  lines.push('# the eight that are the intended deployment interface but are NOT YET READ by any code.')
  return `${lines.join('\n')}\n`
}

function renderHuman(report: Report<BootstrapPlan>): string {
  const plan = report.result
  const out: string[] = []
  out.push(heading('Derived deployment constants'))
  out.push(
    table(
      [
        { k: 'VENUE_VAULT_INIT_CODE_HASH', v: plan.initCodeHash, how: 'DERIVED from contracts/out/' },
        {
          k: 'VENUE_VAULT_FACTORY',
          v: plan.factory,
          how: plan.factoryIsSentinel ? 'DEV-ONLY sentinel (none deployed)' : 'supplied with --factory',
        },
        { k: 'VENUE_VAULT_DEPLOYER', v: plan.deployer, how: 'DERIVED as CREATE(factory, 1)' },
      ],
      [
        { header: 'variable', value: (r) => r.k },
        { header: 'value', value: (r) => r.v },
        { header: 'how', value: (r) => r.how },
      ],
    ),
  )
  out.push('')
  out.push(
    `Creation code: ${String(plan.initCodeBytes)} bytes from ${plan.artifactPath.replace(/\\/g, '/')}`,
  )
  out.push(`Self-check: the three values above predict ${plan.selfCheckVault} for a zero salt.`)
  out.push('')

  out.push(subheading('Every variable this file writes'))
  out.push(
    table(plan.vars, [
      { header: 'variable', value: (v) => v.name },
      { header: 'provenance', value: (v) => PROVENANCE_LABEL[v.provenance] },
      {
        header: 'value',
        value: (v) => (v.value === undefined ? '(empty)' : v.value.length > 44 ? `${v.value.slice(0, 41)}...` : v.value),
      },
      { header: 'API requires', value: (v) => (v.requiredByApi === true ? 'yes' : '') },
    ]),
  )
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function main(values: ParsedValues): Promise<void> {
  const envFileArg = getString(values, 'env-out') ?? '.env.local'
  const envFile = resolve(REPO_ROOT, envFileArg)
  const dryRun = getBool(values, 'dry-run')
  const force = getBool(values, 'force')

  const plan = buildPlan({
    factory: getString(values, 'factory'),
    deployer: getString(values, 'deployer'),
    rpcUrls: getList(values, 'rpc'),
    devIdentity: getBool(values, 'dev-identity'),
    port: typeof values.port === 'number' ? values.port : 8080,
  })

  const contents = renderEnvFile(plan)
  const warnings: string[] = []
  if (plan.factoryIsSentinel) {
    warnings.push(
      'VENUE_VAULT_FACTORY and VENUE_VAULT_DEPLOYER are DEV-ONLY sentinels. No VaultFactory exists on chain ' +
        '4663. Consent digests signed against them are bound to a contract that is not there, so nothing ' +
        'signed locally is portable to a real deployment. apps/api refuses these values when NODE_ENV=production.',
    )
  }
  if (plan.devIdentity) {
    warnings.push(
      'VENUE_OPERATOR_API_TOKEN is the published dev token from config/dev-only.ts. It is in git. Anyone ' +
        'who can reach the port can call every operator route. Bind to localhost, and never use it anywhere else.',
    )
  } else {
    warnings.push(
      'The operator identity is empty, so apps/api will refuse to boot and name the missing variable. ' +
        'That is correct and intended. Set VENUE_OPERATOR_NAME, VENUE_RECEIPTS_BASE_URL and ' +
        'VENUE_OPERATOR_API_TOKEN, or re-run with --dev-identity for a local demo.',
    )
  }

  let wrote: string | undefined
  if (dryRun) {
    process.stdout.write(`${contents}\n`)
  } else if (existsSync(envFile) && !force) {
    throw new CliError(
      `${relative(REPO_ROOT, envFile).replace(/\\/g, '/')} already exists and was left alone. ` +
        'Pass --force to overwrite it, or --dry-run to see what would be written.',
    )
  } else {
    await mkdir(dirname(envFile), { recursive: true })
    await writeFile(envFile, contents, 'utf8')
    wrote = envFile
  }

  await emit(
    {
      meta: {
        tool: SPEC.name,
        schemaVersion: SCHEMA_VERSION,
        generatedAtUnix: Math.floor(Date.now() / 1000),
        config: {
          envFile: relative(REPO_ROOT, envFile).replace(/\\/g, '/'),
          written: wrote !== undefined,
          dryRun,
          devIdentity: plan.devIdentity,
        },
        io: { httpRequests: 0, cacheHits: 0, cacheMisses: 0 },
        warnings,
        methodLimits: [
          'The init code hash is derived from contracts/out/, which is a build artifact. It is only as ' +
            'current as the last `forge build`; re-run bootstrap-env after any change to contracts/src/.',
          'Nothing here contacts a chain. The factory address is either the DEV-ONLY sentinel or whatever ' +
            'you passed to --factory; this tool does not verify that a contract exists at it.',
        ],
      },
      result: plan,
    },
    {
      json: getBool(values, 'json'),
      outPath: getString(values, 'out'),
      human: (report) =>
        `${renderHuman(report)}\n\n${
          wrote === undefined
            ? dryRun
              ? '--dry-run: nothing written.'
              : ''
            : `Wrote ${relative(REPO_ROOT, wrote).replace(/\\/g, '/')}.\n` +
              'Start the API with:  node --env-file=.env.local apps/api/dist/main.js'
        }`,
    },
  )
}

/** So `runCli` prints a one-line message for a derivation failure, not a stack. */
export function isOperationalDerivationError(error: unknown): error is DerivationError {
  return error instanceof DerivationError
}

if (isEntrypoint(import.meta.url)) {
  await runCli(SPEC, process.argv.slice(2), async (values) => {
    try {
      await main(values)
    } catch (error) {
      if (error instanceof DerivationError) throw new CliError(error.message)
      throw error
    }
  })
}

export { SPEC as BOOTSTRAP_ENV_SPEC }
