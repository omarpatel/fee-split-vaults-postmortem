/**
 * SECRET SCAN.
 *
 * A repository that deploys vaults and signs claims will eventually have someone
 * paste a key into a fixture "just to test it". This runs on every push, needs
 * no network and no third-party binary, and is deliberately biased towards false
 * positives on high-value patterns: a wasted minute triaging a hit is cheaper by
 * several orders of magnitude than an operator key in git history.
 *
 * WHAT IT DOES NOT DO. It does not scan history - that is a one-time audit with
 * a dedicated tool, not a per-push gate - and it is not a substitute for keys
 * living in a KMS. It is the last line, not the first.
 *
 * Exit codes: 0 clean, 1 findings, 2 the scanner could not run.
 */

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { collectFiles, lines, matchesGlob, readTextFile } from './scan.js'
import { repoRootFromHere } from './no-hardcoded-rates.js'

export interface SecretRule {
  id: string
  description: string
  pattern: RegExp
  severity: 'critical' | 'high' | 'medium'
}

export const SECRET_RULES: readonly SecretRule[] = [
  {
    id: 'pem-private-key',
    description: 'A PEM-encoded private key block. There is no version of this that belongs in a repository.',
    pattern: /-----BEGIN\s+(?:RSA|EC|OPENSSH|PGP|DSA|ENCRYPTED)?\s*PRIVATE KEY-----/g,
    severity: 'critical',
  },
  {
    id: 'evm-private-key',
    description:
      'A 32-byte hex string in a variable that names a key. On this chain that is a vault operator key or ' +
      'a deployer key, and either one is a total compromise.',
    pattern: /(?:private_?key|priv_?key|secret_?key|deployer_?key|signer_?key)\W{0,4}(?:0x)?[a-fA-F0-9]{64}\b/gi,
    severity: 'critical',
  },
  {
    id: 'bip39-mnemonic',
    description: 'A variable named mnemonic or seed phrase assigned a long lowercase word list.',
    pattern: /(?:mnemonic|seed_?phrase)\W{0,4}["'`](?:[a-z]{3,10}\s+){11,23}[a-z]{3,10}["'`]/gi,
    severity: 'critical',
  },
  {
    id: 'anthropic-api-key',
    description: 'An Anthropic API key. Model spend is metered per coin, so a leaked key is a direct cost as well as a data exposure.',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
    severity: 'critical',
  },
  {
    id: 'aws-access-key-id',
    description: 'An AWS access key id. Harmless alone, but it names the account whose secret to go looking for.',
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    severity: 'critical',
  },
  {
    id: 'aws-secret-access-key',
    description: 'An AWS secret access key assigned to a plausibly named variable.',
    pattern: /aws_?secret_?access_?key\W{0,4}["'`]?[A-Za-z0-9/+=]{40}["'`]?/gi,
    severity: 'critical',
  },
  {
    id: 'github-token',
    description: 'A GitHub personal access, OAuth, or app token. Repository write access is deploy access.',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
    severity: 'critical',
  },
  {
    id: 'slack-token',
    description: 'A Slack bot, user or app token. Enough to read and post in whatever workspace it belongs to.',
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
    severity: 'high',
  },
  {
    id: 'telegram-bot-token',
    description: 'A Telegram bot token. The desk publishes through Telegram, so this one is live ammunition.',
    pattern: /\b\d{8,12}:AA[A-Za-z0-9_-]{30,}\b/g,
    severity: 'critical',
  },
  {
    id: 'generic-bearer-secret',
    description: 'A long opaque string assigned to a variable named like a credential.',
    pattern:
      /(?:api_?key|api_?secret|auth_?token|access_?token|client_?secret|bearer_?token)\W{0,4}["'`][A-Za-z0-9_\-./+=]{24,}["'`]/gi,
    severity: 'high',
  },
  {
    id: 'postgres-url-with-password',
    description: 'A database URL with an embedded password that is not an obvious local placeholder.',
    pattern: /\b(?:postgres|postgresql|mysql|mongodb)(?:\+\w+)?:\/\/[^\s:@/]+:[^\s:@/]{6,}@/g,
    severity: 'high',
  },
]

/**
 * Paths whose hits are structurally not secrets: the scanner's own patterns, its
 * fixtures, and the example env file, whose entire purpose is to name the
 * variables without their values.
 */
export const SECRET_ALLOWLIST: ReadonlyArray<{ path: string; reason: string }> = [
  { path: 'ops/ci/secret-scan.ts', reason: 'The scanner. It contains the patterns it looks for.' },
  { path: 'ops/ci/__tests__/**', reason: 'Fixtures deliberately contain synthetic secrets.' },
  { path: '.env.example', reason: 'Names variables without values, by design.' },
  { path: 'package-lock.json', reason: 'Integrity hashes are base64 digests, not credentials.' },
  { path: 'ops/docker-compose*.yml', reason: 'Local-development credentials for a throwaway container.' },
  { path: 'docker-compose*.yml', reason: 'Local-development credentials for a throwaway container.' },
]

/** Substrings that mark a hit as a placeholder rather than a live credential. */
const PLACEHOLDER = /(example|placeholder|redacted|dummy|sample|fake|test|xxx+|your[-_]?|change[-_]?me|<[^>]+>|\$\{)/i

export interface SecretFinding {
  path: string
  line: number
  ruleId: string
  severity: SecretRule['severity']
  /** The match with its middle removed. Never the full credential. */
  redacted: string
}

export interface SecretReport {
  filesScanned: number
  findings: SecretFinding[]
  skippedAsPlaceholder: number
}

export function redact(value: string): string {
  if (value.length <= 12) return `${value.slice(0, 2)}***`
  return `${value.slice(0, 6)}***${value.slice(-4)}`
}

export function scanForSecrets(root: string): SecretReport {
  const files = collectFiles({
    root,
    // Every extension: a key is just as dangerous in a .txt as in a .ts.
    extensions: [],
    excludedPaths: ['contracts/out', 'contracts/cache', 'contracts/lib'],
  })
  const findings: SecretFinding[] = []
  let skippedAsPlaceholder = 0

  for (const file of files) {
    if (SECRET_ALLOWLIST.some((entry) => matchesGlob(file.path, entry.path))) continue
    if (isProbablyBinary(file.path)) continue

    let source: string
    try {
      source = readTextFile(file.absolutePath)
    } catch {
      continue
    }
    const fileLines = lines(source)
    for (let index = 0; index < fileLines.length; index += 1) {
      const line = fileLines[index] ?? ''
      if (line.length > 4000) continue
      for (const rule of SECRET_RULES) {
        const pattern = new RegExp(rule.pattern.source, rule.pattern.flags)
        let match: RegExpExecArray | null
        while ((match = pattern.exec(line)) !== null) {
          if (match[0].length === 0) break
          if (PLACEHOLDER.test(match[0])) {
            skippedAsPlaceholder += 1
            continue
          }
          findings.push({
            path: file.path,
            line: index + 1,
            ruleId: rule.id,
            severity: rule.severity,
            redacted: redact(match[0]),
          })
        }
      }
    }
  }

  return { filesScanned: files.length, findings, skippedAsPlaceholder }
}

function isProbablyBinary(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|eot|mp4|wasm|node|so|dll|exe)$/i.test(path)
}

export function formatSecretReport(report: SecretReport): string {
  if (report.findings.length === 0) {
    return `secret-scan: clean (${report.filesScanned} files scanned, ${report.skippedAsPlaceholder} placeholder hit(s) ignored)`
  }
  const out = [`secret-scan: ${report.findings.length} finding(s) in ${report.filesScanned} files`, '']
  for (const finding of report.findings) {
    const rule = SECRET_RULES.find((r) => r.id === finding.ruleId)
    out.push(`  ${finding.path}:${finding.line}  [${finding.severity}] ${finding.ruleId}  ${finding.redacted}`)
    if (rule) out.push(`    -> ${rule.description}`)
  }
  out.push('')
  out.push('If this is a real credential: rotate it FIRST, then remove it. A deleted commit is still in the')
  out.push('reflog, in every clone, and in any CI cache that fetched it.')
  return out.join('\n')
}

export function runSecretCli(argv: readonly string[]): number {
  const rootFlag = argv.indexOf('--root')
  const root = rootFlag === -1 ? repoRootFromHere() : resolve(argv[rootFlag + 1] ?? '.')
  const report = scanForSecrets(root)
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`${formatSecretReport(report)}\n`)
  }
  return report.findings.length === 0 ? 0 : 1
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (invokedDirectly) {
  try {
    process.exitCode = runSecretCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`secret-scan: scanner failed: ${String(error)}\n`)
    process.exitCode = 2
  }
}
