/**
 * operator - the operator's hand on apps/api, one subcommand per route.
 *
 * Every operator route is bearer-gated behind VENUE_OPERATOR_API_TOKEN and takes
 * an exact-key JSON body; hand-typing either into curl is how a wrong field
 * name becomes a 400 and a wrong token becomes a 401 at 2am. This tool builds
 * the body from typed flags, sends the bearer, and prints the response as JSON.
 * A non-2xx answer exits 1 with the API's own `code: message`, verbatim, so the
 * refusal the service wrote is the one the operator reads.
 *
 * Money crosses as decimal strings (`--amount-usd 12.50`), never as a number.
 * `--dry-run` prints the exact request - method, URL, headers with the token
 * redacted, body - and sends nothing.
 */

import { writeFile } from 'node:fs/promises'
import {
  CliError,
  getBool,
  getList,
  getString,
  isEntrypoint,
  parseArgs,
  renderHelp,
  requireString,
  type CommandSpec,
  type OptionSpec,
  type ParsedValues,
} from './lib/cli.ts'
import { stringifyJson } from './lib/json.ts'

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8080'

/** The subset of fetch the tool uses; tests substitute a fake. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface OperatorIo {
  fetch: FetchLike
  env: Readonly<Record<string, string | undefined>>
  stdout: (text: string) => void
  stderr: (text: string) => void
}

/** What a subcommand resolved its flags into; the wire request minus the base URL and bearer. */
export interface OperatorRequest {
  method: 'GET' | 'POST'
  path: string
  query?: Record<string, string>
  body?: Record<string, unknown>
  /** True when the response is bytes to write to --out, not JSON to print. */
  binary?: boolean
}

export interface OperatorCommand {
  group: string
  /** Empty for the single-word commands (health, routes). */
  name: string
  summary: string
  /** GET /health and GET /routes are answerable without a token. */
  public?: boolean
  options: OptionSpec[]
  build: (values: ParsedValues) => OperatorRequest
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const str = (name: string, describe: string, placeholder = '<string>', required = true): OptionSpec => ({
  name,
  type: 'string',
  placeholder,
  describe,
  required,
})
const num = (name: string, describe: string, placeholder = '<int>', required = true): OptionSpec => ({
  name,
  type: 'number',
  placeholder,
  describe,
  required,
})

const ID = str('id', 'The onboarding id.', '<onboarding-id>')
const VAULT = str('vault', 'The vault address.', '<0x…>')
const DEV_SIGNER = str('dev-signer', "The dev's signing address.", '<0x…>')
const ACCOUNT_ID = str('account-id', 'The X platform user id.', '<x-user-id>')
const COIN_REF = str('coin-ref', 'The opaque coin reference ([A-Za-z0-9_-]).', '<ref>')
const FROM = num('from', 'Period start, unix seconds.', '<unix>', false)
const TO = num('to', 'Period end, unix seconds.', '<unix>', false)

/**
 * Body fields present only when the flag was given. The API's exact-key check
 * refuses `undefined` and `null` alike as an unknown field, so an absent flag
 * must be an absent key, not a key with no value.
 */
function optionalStrings(values: ParsedValues, map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [field, flag] of Object.entries(map)) {
    const v = getString(values, flag)
    if (v !== undefined) out[field] = v
  }
  return out
}

function requireInteger(values: ParsedValues, name: string): number {
  const v = values[name]
  if (typeof v !== 'number') throw new CliError(`--${name} is required.`)
  if (!Number.isInteger(v)) throw new CliError(`--${name} must be an integer, got ${v}.`)
  return v
}

function optionalInteger(values: ParsedValues, name: string): number | undefined {
  return values[name] === undefined ? undefined : requireInteger(values, name)
}

/** Same as optionalStrings, for integer flags. */
function optionalIntegers(values: ParsedValues, map: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [field, flag] of Object.entries(map)) {
    const v = optionalInteger(values, flag)
    if (v !== undefined) out[field] = v
  }
  return out
}

function periodQuery(values: ParsedValues): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of ['from', 'to']) {
    const v = optionalInteger(values, key)
    if (v !== undefined) out[key] = String(v)
  }
  return out
}

const onboardingPath = (values: ParsedValues, suffix = ''): string =>
  `/onboarding/${encodeURIComponent(requireString(values, 'id'))}${suffix}`

const onboardingAction = (name: string, summary: string): OperatorCommand => ({
  group: 'onboarding',
  name,
  summary,
  options: [ID],
  build: (v) => ({ method: 'POST', path: onboardingPath(v, `/${name}`) }),
})

/** Mirrors promotion.ts USD_DECIMAL: a vendor-printed amount, at most two places, never a float. */
const USD_DECIMAL = /^(0|[1-9]\d{0,8})(?:\.(\d{1,2}))?$/

// ---------------------------------------------------------------------------
// The command tree. One entry per route in apps/api/src/routes.ts and
// promotion.ts, except GET /accounts/x/callback, which X's redirect calls.
// ---------------------------------------------------------------------------

export const COMMANDS: OperatorCommand[] = [
  {
    group: 'health',
    name: '',
    summary: 'GET /health - liveness only; no token needed.',
    public: true,
    options: [],
    build: () => ({ method: 'GET', path: '/health' }),
  },
  {
    group: 'routes',
    name: '',
    summary: 'GET /routes - the route map the running service actually serves.',
    public: true,
    options: [],
    build: () => ({ method: 'GET', path: '/routes' }),
  },

  // Consent -------------------------------------------------------------------
  {
    group: 'consent',
    name: 'draft',
    summary: 'POST /consent/draft - draft a consent at the published rate; returns the EIP-712 payload.',
    options: [
      DEV_SIGNER,
      str('dev-payout', "The dev's payout address.", '<0x…>'),
      str('terms-hash', 'bytes32 hash of the terms document.', '<0x…>'),
      str('adapter', 'The launchpad adapter address.', '<0x…>'),
      str('nonce', 'bytes32 nonce.', '<0x…>'),
      str('token', 'The coin address, when already known.', '<0x…>', false),
      str('referrer', 'Referrer address.', '<0x…>', false),
      num('referrer-bps', 'Referrer share in basis points.', '<bps>', false),
      num('budget-bps-max', 'Maximum promotion budget in basis points.', '<bps>', false),
      num('ttl-seconds', 'Consent validity in seconds.', '<seconds>', false),
    ],
    build: (v) => ({
      method: 'POST',
      path: '/consent/draft',
      body: {
        devSigner: requireString(v, 'dev-signer'),
        devPayout: requireString(v, 'dev-payout'),
        termsHash: requireString(v, 'terms-hash'),
        adapter: requireString(v, 'adapter'),
        nonce: requireString(v, 'nonce'),
        ...optionalStrings(v, { token: 'token', referrer: 'referrer' }),
        ...optionalIntegers(v, { referrerBps: 'referrer-bps', budgetBpsMax: 'budget-bps-max', ttlSeconds: 'ttl-seconds' }),
      },
    }),
  },
  {
    group: 'consent',
    name: 'verify',
    summary: 'POST /consent/verify - verify a dev signature over a consent without starting an onboarding.',
    options: [
      str('consent', 'The consent object as JSON (the `consent` field a draft returned).', '<json>'),
      str('signature', "The dev's signature.", '<0x…>'),
    ],
    build: (v) => {
      let consent: unknown
      try {
        consent = JSON.parse(requireString(v, 'consent'))
      } catch {
        throw new CliError('--consent must be JSON.')
      }
      return { method: 'POST', path: '/consent/verify', body: { consent, signature: requireString(v, 'signature') } }
    },
  },

  // Onboarding ----------------------------------------------------------------
  {
    group: 'onboarding',
    name: 'list',
    summary: 'GET /onboarding - every onboarding, newest first; --state narrows.',
    options: [str('state', 'Only onboardings in this state (drafted, signed, … active, declined).', '<state>', false)],
    build: (v) => ({ method: 'GET', path: '/onboarding', query: optionalStrings(v, { state: 'state' }) }),
  },
  {
    group: 'onboarding',
    name: 'create',
    summary: 'POST /onboarding - screen the coin and draft the consent. A BLOCKED verdict stops here.',
    options: [
      str('id', 'Your id for this onboarding (≤64 chars).', '<id>'),
      COIN_REF,
      str('token', 'The coin address.', '<0x…>'),
      str('name', 'The coin name as the dev gave it.', '<name>'),
      str('symbol', 'The coin symbol.', '<symbol>'),
      DEV_SIGNER,
      str('dev-payout', "The dev's payout address.", '<0x…>'),
      str('terms-hash', 'bytes32 hash of the terms document.', '<0x…>'),
      str('adapter', 'The launchpad adapter address.', '<0x…>'),
      str('nonce', 'bytes32 nonce.', '<0x…>'),
      str('description', 'The coin description.', '<text>', false),
      { name: 'link', type: 'string[]', placeholder: '<url,…>', describe: 'Published links; repeat or comma-separate.' },
      { name: 'metadata-mutable', type: 'boolean', describe: 'The token metadata can still change.' },
      { name: 'narrative-source', type: 'string[]', placeholder: '<url,…>', describe: 'Dev-named documents to derive the narrative from (≤4).' },
      str('socials-x', "The dev's X handle, for the operator's eyes only.", '<handle>', false),
      num('budget-bps-max', 'Maximum promotion budget in basis points.', '<bps>', false),
    ],
    build: (v) => {
      const links = getList(v, 'link')
      const sources = getList(v, 'narrative-source')
      const socialsX = getString(v, 'socials-x')
      return {
        method: 'POST',
        path: '/onboarding',
        body: {
          id: requireString(v, 'id'),
          coinRef: requireString(v, 'coin-ref'),
          token: requireString(v, 'token'),
          name: requireString(v, 'name'),
          symbol: requireString(v, 'symbol'),
          devSigner: requireString(v, 'dev-signer'),
          devPayout: requireString(v, 'dev-payout'),
          termsHash: requireString(v, 'terms-hash'),
          adapter: requireString(v, 'adapter'),
          nonce: requireString(v, 'nonce'),
          ...optionalStrings(v, { description: 'description' }),
          ...(links.length === 0 ? {} : { links }),
          ...(getBool(v, 'metadata-mutable') ? { metadataMutable: true } : {}),
          ...(sources.length === 0 ? {} : { narrativeSources: sources }),
          ...(socialsX === undefined ? {} : { socials: { x: socialsX } }),
          ...optionalIntegers(v, { budgetBpsMax: 'budget-bps-max' }),
        },
      }
    },
  },
  {
    group: 'onboarding',
    name: 'get',
    summary: 'GET /onboarding/:id - one onboarding, including every refusal in its history.',
    options: [ID],
    build: (v) => ({ method: 'GET', path: onboardingPath(v) }),
  },
  {
    group: 'onboarding',
    name: 'signature',
    summary: 'POST /onboarding/:id/signature - consent 1 of 3: record the signature the dev produced.',
    options: [ID, str('signature', "The dev's EIP-712 signature.", '<0x…>')],
    build: (v) => ({ method: 'POST', path: onboardingPath(v, '/signature'), body: { signature: requireString(v, 'signature') } }),
  },
  onboardingAction('diligence', 'POST /onboarding/:id/diligence - fraud diligence plus a re-screen.'),
  onboardingAction('deploy', 'POST /onboarding/:id/deploy - deploy the vault at the address the consent fixed.'),
  onboardingAction('pointing', 'POST /onboarding/:id/pointing - consent 2 of 3: confirm fee recipiency points at the vault.'),
  onboardingAction('acceptance', 'POST /onboarding/:id/acceptance - confirm the dev called acceptService() on chain.'),
  onboardingAction('activate', 'POST /onboarding/:id/activate - consent 3 of 3: OUR activation. Charging starts here.'),
  {
    group: 'onboarding',
    name: 'decline',
    summary: 'POST /onboarding/:id/decline - the operator declining. Terminal; the dev keeps every fee.',
    options: [ID, str('code', 'A short machine code for the refusal.', '<code>'), str('detail', 'Free-text detail (≤512 chars).', '<text>', false)],
    build: (v) => ({
      method: 'POST',
      path: onboardingPath(v, '/decline'),
      body: { code: requireString(v, 'code'), ...optionalStrings(v, { detail: 'detail' }) },
    }),
  },

  // Narrative -----------------------------------------------------------------
  {
    group: 'narrative',
    name: 'get',
    summary: 'GET /onboarding/:id/narrative - the derived candidate and, once approved, the profile the planner sees.',
    options: [ID],
    build: (v) => ({ method: 'GET', path: onboardingPath(v, '/narrative') }),
  },
  {
    group: 'narrative',
    name: 'derive',
    summary: 'POST /onboarding/:id/narrative/derive - fetch the dev-named sources and hold a candidate for approval.',
    options: [ID],
    build: (v) => ({ method: 'POST', path: onboardingPath(v, '/narrative/derive') }),
  },
  {
    group: 'narrative',
    name: 'approve',
    summary: 'POST /onboarding/:id/narrative/approve - approve the candidate; renders creative beside it.',
    options: [ID, str('approved-by', 'Your operator id.', '<operator>')],
    build: (v) => ({
      method: 'POST',
      path: onboardingPath(v, '/narrative/approve'),
      body: { approvedBy: requireString(v, 'approved-by') },
    }),
  },

  // Creative ------------------------------------------------------------------
  {
    group: 'creative',
    name: 'render',
    summary: 'POST /onboarding/:id/creative/render - render banner, avatar and card from the approved narrative.',
    options: [ID],
    build: (v) => ({ method: 'POST', path: onboardingPath(v, '/creative/render') }),
  },
  {
    group: 'creative',
    name: 'get',
    summary: 'GET /onboarding/:id/creative/:kind - download the rendered PNG to --out <file>.',
    options: [ID, str('kind', 'banner, avatar or card.', '<kind>')],
    build: (v) => ({
      method: 'GET',
      path: onboardingPath(v, `/creative/${encodeURIComponent(requireString(v, 'kind'))}`),
      binary: true,
    }),
  },

  // X accounts ----------------------------------------------------------------
  {
    group: 'x',
    name: 'authorize',
    summary: 'GET /accounts/x/authorize - start the OAuth handshake; prints the URL to visit.',
    options: [COIN_REF, ACCOUNT_ID],
    build: (v) => ({
      method: 'GET',
      path: '/accounts/x/authorize',
      query: { coinRef: requireString(v, 'coin-ref'), accountId: requireString(v, 'account-id') },
    }),
  },
  {
    group: 'x',
    name: 'bind',
    summary: 'POST /accounts/x/bind - bind an authorised account to one coin as the operator-run channel.',
    options: [ACCOUNT_ID, COIN_REF, str('ticker', 'The coin symbol the account speaks for (no $).', '<ticker>')],
    build: (v) => ({
      method: 'POST',
      path: '/accounts/x/bind',
      body: { accountId: requireString(v, 'account-id'), coinRef: requireString(v, 'coin-ref'), ticker: requireString(v, 'ticker') },
    }),
  },
  {
    group: 'x',
    name: 'attest-label',
    summary: 'POST /accounts/x/attest-label - a named operator attests the Automated label is on the profile.',
    options: [ACCOUNT_ID, str('attested-by', 'Your operator id.', '<operator>'), num('days', 'Days until the attestation lapses (1-365).', '<days>')],
    build: (v) => ({
      method: 'POST',
      path: '/accounts/x/attest-label',
      body: { accountId: requireString(v, 'account-id'), attestedBy: requireString(v, 'attested-by'), days: requireInteger(v, 'days') },
    }),
  },

  // Purchases and invoices ----------------------------------------------------
  {
    group: 'purchases',
    name: 'list',
    summary: 'GET /purchases - approved purchases still to buy and evidence, and invoices not yet settled.',
    options: [VAULT],
    build: (v) => ({ method: 'GET', path: '/purchases', query: { vault: requireString(v, 'vault') } }),
  },
  {
    group: 'invoices',
    name: 'post',
    summary: 'POST /invoices - record a vendor-countersigned invoice for a purchase made as principal.',
    options: [
      VAULT,
      str('vendor-id', 'Catalog vendor id.', '<vendor>'),
      str('sku-id', 'Catalog SKU id.', '<sku>'),
      num('quantity', 'Units bought.', '<n>'),
      str('amount-usd', 'The amount as the vendor printed it, e.g. 12.50. A decimal string, never a float.', '<usd>'),
      str('vendor-countersig', "The vendor's countersignature, 0x-hex bytes.", '<0x…>'),
      num('issued-at-unix', 'When the vendor issued the invoice, unix seconds.', '<unix>'),
      str('invoice-hash', "The vendor's copy of the invoice hash; refused if it is not the hash of this invoice.", '<0x…>', false),
      num('baseline-boosts', 'Boost count observed before the purchase.', '<n>', false),
      num('baseline-rank', 'Rank observed before the purchase.', '<n>', false),
    ],
    build: (v) => {
      const amountUsd = requireString(v, 'amount-usd')
      if (!USD_DECIMAL.test(amountUsd)) {
        throw new CliError(`--amount-usd must be a decimal string with at most two places, got "${amountUsd}".`)
      }
      const baseline = optionalIntegers(v, { boosts: 'baseline-boosts', rank: 'baseline-rank' })
      return {
        method: 'POST',
        path: '/invoices',
        body: {
          vault: requireString(v, 'vault'),
          vendorId: requireString(v, 'vendor-id'),
          skuId: requireString(v, 'sku-id'),
          quantity: requireInteger(v, 'quantity'),
          amountUsd,
          vendorCountersig: requireString(v, 'vendor-countersig'),
          issuedAtUnix: requireInteger(v, 'issued-at-unix'),
          ...optionalStrings(v, { invoiceHash: 'invoice-hash' }),
          ...(Object.keys(baseline).length === 0 ? {} : { baseline }),
        },
      }
    },
  },

  // KYB -----------------------------------------------------------------------
  {
    group: 'kyb',
    name: 'attest',
    summary: 'POST /diligence/kyb/attest - record that a named operator verified the dev signer’s identity outside.',
    options: [
      DEV_SIGNER,
      str('attested-by', 'Your operator id.', '<operator>'),
      str('provider-ref', "A handle into the provider's file.", '<ref>'),
      num('expires-at-unix', 'When the attestation lapses, unix seconds.', '<unix>'),
      num('attested-at-unix', 'When the check was performed; defaults to now on the server.', '<unix>', false),
    ],
    build: (v) => ({
      method: 'POST',
      path: '/diligence/kyb/attest',
      body: {
        devSigner: requireString(v, 'dev-signer'),
        attestedBy: requireString(v, 'attested-by'),
        providerRef: requireString(v, 'provider-ref'),
        expiresAtUnix: requireInteger(v, 'expires-at-unix'),
        ...optionalIntegers(v, { attestedAtUnix: 'attested-at-unix' }),
      },
    }),
  },
  {
    group: 'kyb',
    name: 'get',
    summary: 'GET /diligence/kyb/:devSigner - the latest identity attestation on file, and whether it is current.',
    options: [DEV_SIGNER],
    build: (v) => ({ method: 'GET', path: `/diligence/kyb/${encodeURIComponent(requireString(v, 'dev-signer'))}` }),
  },

  // Receipts and the report ---------------------------------------------------
  {
    group: 'receipts',
    name: 'list',
    summary: 'GET /vaults/:vault/receipts - published receipts; unexecuted commitments are withheld for 72h.',
    options: [VAULT, FROM, TO],
    build: (v) => ({
      method: 'GET',
      path: `/vaults/${encodeURIComponent(requireString(v, 'vault'))}/receipts`,
      query: periodQuery(v),
    }),
  },
  {
    group: 'receipts',
    name: 'get',
    summary: 'GET /vaults/:vault/receipts/:id - one receipt, once its publication lag has elapsed.',
    options: [VAULT, str('id', 'The receipt id.', '<receipt-id>')],
    build: (v) => ({
      method: 'GET',
      path: `/vaults/${encodeURIComponent(requireString(v, 'vault'))}/receipts/${encodeURIComponent(requireString(v, 'id'))}`,
    }),
  },
  {
    group: 'report',
    name: 'get',
    summary: 'GET /vaults/:vault/report - the weekly report, including what we did NOT do. Defaults to the last 7 days.',
    options: [VAULT, FROM, TO],
    build: (v) => ({
      method: 'GET',
      path: `/vaults/${encodeURIComponent(requireString(v, 'vault'))}/report`,
      query: periodQuery(v),
    }),
  },
]

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const GROUPS = [...new Set(COMMANDS.map((c) => c.group))]

const commandLabel = (command: OperatorCommand): string =>
  command.name === '' ? command.group : `${command.group} ${command.name}`

export function topLevelHelp(): string {
  const lines: string[] = []
  lines.push("operator - the operator's hand on apps/api, one subcommand per route.")
  lines.push('')
  lines.push('USAGE')
  lines.push('  node tools/operator.ts <group> [command] [options]')
  lines.push('')
  lines.push('WHAT THIS SETTLES')
  lines.push('  Every operator route takes an exact-key JSON body behind a bearer token. This')
  lines.push('  builds the body from typed flags, sends the bearer, and prints the answer as')
  lines.push("  JSON. A non-2xx answer exits 1 with the API's own code and message, verbatim.")
  lines.push('')
  lines.push('ENVIRONMENT')
  lines.push(`  VENUE_API_BASE_URL         where apps/api listens (default: ${DEFAULT_BASE_URL})`)
  lines.push('  VENUE_OPERATOR_API_TOKEN   the operator bearer; required by every command except health and routes')
  lines.push('')
  lines.push('COMMANDS')
  const width = Math.max(...COMMANDS.map((c) => commandLabel(c).length))
  for (const command of COMMANDS) {
    lines.push(`  ${commandLabel(command).padEnd(width)}  ${command.summary}`)
  }
  lines.push('')
  lines.push('OPTIONS')
  lines.push('  Every command takes --json (raw response), --dry-run (print the request, send nothing),')
  lines.push('  --out <file> and -v. Run `node tools/operator.ts <group> <command> --help` for its flags.')
  lines.push('')
  lines.push('EXAMPLES')
  lines.push('  node tools/operator.ts routes')
  lines.push('  node tools/operator.ts onboarding get --id pump-abc')
  lines.push('  node tools/operator.ts kyb attest --dev-signer 0x… --attested-by alice --provider-ref sumsub:123 --expires-at-unix 1790000000')
  lines.push('  node tools/operator.ts x attest-label --account-id 1234567 --attested-by alice --days 30')
  lines.push('  node tools/operator.ts invoices post --vault 0x… --vendor-id v1 --sku-id boost --quantity 1 --amount-usd 12.50 \\')
  lines.push('      --vendor-countersig 0xabcd --issued-at-unix 1760000000 --dry-run')
  lines.push('  node tools/operator.ts creative get --id pump-abc --kind banner --out banner.png')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Non-2xx from the API. Carries the service's own code and message, verbatim. */
export class ApiRefusal extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiRefusal'
    this.status = status
    this.code = code
  }
}

/**
 * `<group> <command>` for two-word commands, `<group>` alone for health and
 * routes. A miss returns the message to print; the caller never guesses.
 */
function resolve(argv: readonly string[]): { command: OperatorCommand; rest: string[] } | { problem: string } {
  const [group, second] = argv
  const inGroup = COMMANDS.filter((c) => c.group === group)
  if (inGroup.length === 0) return { problem: `unknown command "${group ?? ''}". Try one of: ${GROUPS.join(', ')}` }
  const single = inGroup.find((c) => c.name === '')
  if (single !== undefined) return { command: single, rest: argv.slice(1) }
  const names = inGroup.map((c) => c.name)
  if (second === undefined || second.startsWith('-')) return { problem: `${group} takes one of: ${names.join(', ')}` }
  const command = inGroup.find((c) => c.name === second)
  if (command === undefined) return { problem: `unknown command "${group} ${second}". ${group} takes one of: ${names.join(', ')}` }
  return { command, rest: argv.slice(2) }
}

/**
 * The API's `{ error, message }` when the body is one; otherwise a status code
 * and the raw text, which is the best a proxy's crash page offers.
 */
function refusalFrom(status: number, statusText: string, text: string): ApiRefusal {
  let code = `http_${status}`
  let message = text.length === 0 ? statusText : text
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return new ApiRefusal(status, code, message)
  }
  if (parsed !== null && typeof parsed === 'object') {
    if ('error' in parsed && typeof parsed.error === 'string') code = parsed.error
    if ('message' in parsed && typeof parsed.message === 'string') message = parsed.message
  }
  return new ApiRefusal(status, code, message)
}

/**
 * Runs one invocation and returns the exit code. Never touches process.* so
 * a test can drive it with a fake fetch and a captured stdout.
 */
export async function runOperatorCli(argv: readonly string[], io: OperatorIo): Promise<number> {
  const first = argv[0]
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    io.stdout(`${topLevelHelp()}\n`)
    return 0
  }
  if (first.startsWith('-')) {
    io.stderr(`operator: expected a command before any flag. Try one of: ${GROUPS.join(', ')}\n`)
    return 2
  }

  const resolved = resolve(argv)
  if ('problem' in resolved) {
    io.stderr(`operator: ${resolved.problem}\n`)
    return 2
  }

  const spec: CommandSpec = {
    name: `operator ${commandLabel(resolved.command)}`,
    summary: resolved.command.summary,
    usage: `node tools/operator.ts ${commandLabel(resolved.command)} [options]`,
    options: resolved.command.options,
  }
  let values: ParsedValues
  try {
    values = parseArgs(spec, resolved.rest)
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  if (values.help === true) {
    io.stdout(`${renderHelp(spec)}\n`)
    return 0
  }

  try {
    await execute(resolved.command, values, io)
    return 0
  } catch (error) {
    if (error instanceof ApiRefusal) {
      io.stderr(`${spec.name}: ${error.code}: ${error.message}\n`)
      return 1
    }
    if (error instanceof CliError) {
      io.stderr(`${spec.name}: ${error.message}\n`)
      return error.exitCode
    }
    // fetch wraps ECONNREFUSED in a TypeError whose cause carries the code; a
    // failed --out write carries it directly. Either is an operating
    // condition, not a bug, and a stack would bury the one useful line.
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error
    if (cause instanceof Error && 'code' in cause && typeof cause.code === 'string') {
      io.stderr(`${spec.name}: ${cause.message}\n`)
      return 1
    }
    io.stderr(`${spec.name}: ${error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)}\n`)
    return 1
  }
}

async function execute(command: OperatorCommand, values: ParsedValues, io: OperatorIo): Promise<void> {
  const request = command.build(values)
  const base = io.env.VENUE_API_BASE_URL ?? DEFAULT_BASE_URL
  const token = io.env.VENUE_OPERATOR_API_TOKEN
  const dryRun = getBool(values, 'dry-run')
  // A preview needs no bearer; the request that would carry it does.
  if (token === undefined && command.public !== true && !dryRun) {
    throw new CliError('VENUE_OPERATOR_API_TOKEN is not set; every command except health and routes needs the operator bearer.')
  }
  const out = getString(values, 'out')
  if (request.binary === true && out === undefined) {
    throw new CliError('--out <file> is required: the response is a PNG, not JSON.')
  }

  const url = new URL(request.path, base.endsWith('/') ? base : `${base}/`)
  for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value)
  const headers: Record<string, string> = {
    accept: request.binary === true ? 'image/png' : 'application/json',
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
  }
  const body = request.body === undefined ? undefined : JSON.stringify(request.body)

  if (dryRun) {
    io.stdout(
      `${stringifyJson({
        dryRun: true,
        method: request.method,
        url: url.toString(),
        headers: { ...headers, ...(token === undefined ? {} : { authorization: 'Bearer <redacted>' }) },
        ...(request.body === undefined ? {} : { body: request.body }),
      })}\n`,
    )
    return
  }

  if (getBool(values, 'verbose')) io.stderr(`${request.method} ${url.toString()}\n`)
  const response = await io.fetch(url.toString(), { method: request.method, headers, ...(body === undefined ? {} : { body }) })

  if (response.status < 200 || response.status >= 300) {
    throw refusalFrom(response.status, response.statusText, await response.text())
  }

  if (request.binary === true) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    await writeFile(out!, bytes)
    io.stdout(`${stringifyJson({ wrote: out, bytes: bytes.byteLength, contentType: response.headers.get('content-type') })}\n`)
    return
  }

  const text = await response.text()
  if (getBool(values, 'json')) {
    io.stdout(text.endsWith('\n') ? text : `${text}\n`)
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
    io.stdout(`${stringifyJson(parsed)}\n`)
  }
  if (out !== undefined) await writeFile(out, text, 'utf8')
}

if (isEntrypoint(import.meta.url)) {
  process.exitCode = await runOperatorCli(process.argv.slice(2), {
    fetch: (url, init) => fetch(url, init),
    env: process.env,
    stdout: (text) => {
      process.stdout.write(text)
    },
    stderr: (text) => {
      process.stderr.write(text)
    },
  })
}
