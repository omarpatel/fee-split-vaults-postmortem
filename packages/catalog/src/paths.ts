/**
 * Where the data directory lives.
 *
 * Resolved relative to this module rather than to process.cwd(), so a script
 * run from anywhere in the monorepo reads the same files. The depth is
 * identical from src/ and from dist/, which is why both work without a build
 * step in the middle.
 */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** Override for tests and for a deployment that ships data out of band. */
export const DATA_DIR_ENV = 'VENUE_DATA_DIR'

export function defaultDataDir(): string {
  const override = process.env[DATA_DIR_ENV]
  if (override !== undefined && override.length > 0) return override
  return fileURLToPath(new URL('../../../data/', import.meta.url))
}

export interface DataPaths {
  root: string
  vendors: string
  skus: string
  rateCardDir: string
  rateCardArchiveDir: string
  operatorRateSchedule: string
  snapshotDir: string
  screeningDir: string
  factsheetSchema: string
}

export function dataPaths(dataDir: string = defaultDataDir()): DataPaths {
  return {
    root: dataDir,
    vendors: join(dataDir, 'vendors.json'),
    skus: join(dataDir, 'skus.json'),
    rateCardDir: join(dataDir, 'rate-cards'),
    rateCardArchiveDir: join(dataDir, 'rate-cards', 'archive'),
    operatorRateSchedule: join(dataDir, 'rate-cards', 'operator-published-rates.json'),
    snapshotDir: join(dataDir, 'snapshots'),
    screeningDir: join(dataDir, 'screening'),
    factsheetSchema: join(dataDir, 'factsheet-schema.json'),
  }
}

/** Basename of the published operator rate schedule inside the rate-card dir. */
export const OPERATOR_SCHEDULE_BASENAME = 'operator-published-rates.json'
