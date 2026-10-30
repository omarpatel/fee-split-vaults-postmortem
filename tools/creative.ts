/**
 * creative - render a coin's banner, avatar and post card to disk and print
 * the asset ids and sha256s the planner and publisher will see.
 *
 * Inputs are the two chain-read strings (symbol, name) and, optionally, an
 * approved NarrativeProfile as JSON. The JSON goes through
 * validateNarrativeProfile: an unapproved or malformed profile is a hard error,
 * not a render with defaults. No network I/O.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { validateNarrativeProfile, type ImageAsset, type NarrativeProfile } from '@fee-split-vaults/core'
import { CreativeError, renderCoinAssets } from '@fee-split-vaults/creative'
import { CliError, getBool, getList, getString, isEntrypoint, requireString, runCli, type ParsedValues } from './lib/cli.ts'
import { TOOLS_DIR } from './lib/env.ts'
import { heading, table } from './lib/format.ts'
import { parseJson } from './lib/json.ts'
import { emit, emitDryRun, type Report } from './lib/report.ts'

const SCHEMA_VERSION = 'creative-1'
const DEFAULT_OUT_DIR = join(TOOLS_DIR, 'artifacts', 'creative')

const SPEC = {
  name: 'creative',
  summary: 'Render a coin\'s banner, avatar and post-card PNGs from trusted inputs.',
  detail: `
    Symbol and name are treated as hostile text (a contract can name itself
    anything): they are scrubbed and refused if destination-like. The narrative
    JSON, if given, must validate as an approved NarrativeProfile. Output is
    deterministic for a fixed font set; pass --font to pin fonts across hosts.
  `,
  options: [
    { name: 'coin', type: 'string' as const, placeholder: '<coinRef>', required: true, describe: 'Coin reference used in asset ids ([A-Za-z0-9_-]).' },
    { name: 'symbol', type: 'string' as const, placeholder: '<sym>', required: true, describe: 'Token symbol as read from chain.' },
    { name: 'name', type: 'string' as const, placeholder: '<name>', required: true, describe: 'Token name as read from chain.' },
    { name: 'narrative', type: 'string' as const, placeholder: '<path.json>', describe: 'Approved NarrativeProfile JSON. Omit to render the no-narrative default.' },
    { name: 'out-dir', type: 'string' as const, placeholder: '<dir>', default: DEFAULT_OUT_DIR, describe: 'Directory to write <coinRef>-<kind>.png into.' },
    { name: 'font', type: 'string[]' as const, placeholder: '<file,...>', describe: 'Font files to load in addition to system fonts.' },
  ],
  examples: [
    'node tools/creative.ts --coin venue-4663-pepe --symbol PEPE --name "Pepe on Venue"',
    'node tools/creative.ts --coin venue-4663-pepe --symbol PEPE --name "Pepe on Venue" --narrative ./pepe.narrative.json --json',
  ],
}

interface CreativeResult {
  coinRef: string
  narrative: 'approved' | 'none'
  assets: Array<{ kind: string; id: string; sha256: string; bytes: number; path: string }>
}

async function loadNarrative(path: string | undefined): Promise<NarrativeProfile | null> {
  if (path === undefined) return null
  const raw = await readFile(path, 'utf8')
  // AirlockViolation names the offending field; that is the whole message.
  return validateNarrativeProfile(parseJson(raw))
}

async function main(values: ParsedValues): Promise<void> {
  const coinRef = requireString(values, 'coin')
  const symbol = requireString(values, 'symbol')
  const name = requireString(values, 'name')
  const narrativePath = getString(values, 'narrative')
  const outDir = resolve(requireString(values, 'out-dir'))
  const fontFiles = getList(values, 'font')
  const json = getBool(values, 'json')

  if (getBool(values, 'dry-run')) {
    emitDryRun(
      {
        tool: SPEC.name,
        config: { coinRef, symbol, name, narrative: narrativePath ?? '(none)', outDir, fontFiles },
        steps: [
          { description: narrativePath ? `validate ${narrativePath} as a NarrativeProfile` : 'no narrative: default tone and palette' },
          { description: 'scrub symbol and name; refuse if destination-like' },
          { description: `render banner, avatar, card; write ${join(outDir, `${coinRef}-<kind>.png`)}` },
        ],
        estimatedRequestsTotal: 0,
        notes: ['This tool performs no network I/O under any flag.'],
      },
      json,
    )
    return
  }

  const narrative = await loadNarrative(narrativePath)
  let assets: readonly ImageAsset[]
  try {
    assets = await renderCoinAssets({ coinRef, symbol, name, narrative }, { fontFiles })
  } catch (error) {
    if (error instanceof CreativeError) throw new CliError(error.message, 1)
    throw error
  }

  await mkdir(outDir, { recursive: true })
  const written: CreativeResult['assets'] = []
  for (const asset of assets) {
    const path = join(outDir, `${coinRef}-${asset.kind}.png`)
    await writeFile(path, asset.bytes)
    written.push({ kind: asset.kind, id: asset.id, sha256: asset.sha256, bytes: asset.bytes.length, path })
  }

  const report: Report<CreativeResult> = {
    meta: {
      tool: SPEC.name,
      schemaVersion: SCHEMA_VERSION,
      generatedAtUnix: Math.floor(Date.now() / 1000),
      config: { coinRef, symbol, name, narrative: narrativePath ?? null, outDir, fontFiles },
      io: { httpRequests: 0, cacheHits: 0, cacheMisses: 0 },
      warnings: fontFiles.length === 0
        ? ['Rendered with system fonts only: the sha256s are stable on this host, not across hosts. Pass --font to pin.']
        : [],
      methodLimits: [],
    },
    result: { coinRef, narrative: narrative === null ? 'none' : 'approved', assets: written },
  }
  await emit(report, { json, outPath: getString(values, 'out'), human: renderReport })
}

function renderReport(report: Report<CreativeResult>): string {
  const { result } = report
  return `${heading(`creative: ${result.coinRef} (narrative: ${result.narrative})`)}\n\n${table(result.assets, [
    { header: 'kind', value: (a) => a.kind },
    { header: 'id', value: (a) => a.id },
    { header: 'sha256', value: (a) => a.sha256 },
    { header: 'bytes', value: (a) => String(a.bytes), align: 'right' },
    { header: 'path', value: (a) => a.path },
  ])}`
}

if (isEntrypoint(import.meta.url)) {
  await runCli(SPEC, process.argv.slice(2), main)
}

export { SPEC as CREATIVE_SPEC }
