/**
 * THE OPERATOR CLI HAS TO ANSWER WHEN IT IS UNCONFIGURED.
 *
 * `npm run status` produced nothing usable: there was no `status` script at the
 * repository root at all, and inside ops/ the only output was one line on
 * stderr about DATABASE_URL. There was no --help, so the command list existed
 * solely in a source comment. During an incident -- which is the only time
 * anyone runs this -- that reads as a broken tool.
 *
 * The refusal itself is right: this CLI talks to the operations tables directly
 * because the application may be exactly what is broken, so there is no
 * in-memory mode for it to fall back to. What changed is that it now says what
 * it can do and how to get a database.
 */

import { describe, expect, it, vi } from 'vitest'
import type { SqlDriver } from '../../migrations/driver.js'
import { STATUS_COMMANDS, renderStatusHelp, runStatus, wantsHelp, STATUS_NO_DATABASE_HELP } from '../status.js'

/** A driver that fails loudly: help must never reach the database. */
const refusingDriver: SqlDriver = {
  query: vi.fn(async () => {
    throw new Error('help must not touch the database')
  }),
  execute: vi.fn(async () => {
    throw new Error('help must not touch the database')
  }),
} as unknown as SqlDriver

function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk)
    return true
  })
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err += String(chunk)
    return true
  })
  return fn()
    .then((code) => ({ code, out, err }))
    .finally(() => {
      stdout.mockRestore()
      stderr.mockRestore()
    })
}

describe('--help', () => {
  it.each(['--help', '-h', 'help'])('is recognised as %s', (token) => {
    expect(wantsHelp([token])).toBe(true)
  })

  it('is not triggered by a real command', () => {
    expect(wantsHelp(['jobs'])).toBe(false)
    expect(wantsHelp([])).toBe(false)
  })

  it('prints on stdout, exits 0, and never queries', async () => {
    const { code, out, err } = await capture(() => runStatus(['--help'], refusingDriver, 0))
    expect(code).toBe(0)
    expect(err).toBe('')
    expect(out).toContain('USAGE')
    expect(refusingDriver.query).not.toHaveBeenCalled()
  })

  it('lists every command the dispatch switch handles, so the two cannot drift', () => {
    const help = renderStatusHelp()
    for (const command of STATUS_COMMANDS) {
      expect(help, `${command.name} missing from --help`).toContain(command.name)
      expect(help).toContain(command.summary)
    }
  })

  it('names both money-moving commands and the flag they demand', () => {
    const help = renderStatusHelp()
    for (const command of STATUS_COMMANDS.filter((c) => c.dangerous === true)) {
      expect(help).toContain(command.name)
    }
    expect(help).toContain('--i-understand')
    expect(help).toContain('COST MONEY')
  })

  it('says a database is needed rather than implying one is optional', () => {
    expect(renderStatusHelp()).toMatch(/--database-url|DATABASE_URL/)
  })
})

describe('the unconfigured message', () => {
  it('gives a runnable path to a database instead of one bare line', () => {
    expect(STATUS_NO_DATABASE_HELP).toContain('docker compose up -d db')
    expect(STATUS_NO_DATABASE_HELP).toContain('npm run migrate')
    // The way to see the commands without standing a database up first.
    expect(STATUS_NO_DATABASE_HELP).toContain('--help')
    // And the thing that genuinely needs no database, so the reader is not
    // stuck believing nothing in ops/ can be exercised locally.
    expect(STATUS_NO_DATABASE_HELP).toContain('scheduler:local')
  })
})

describe('an unknown command', () => {
  it('names the known commands rather than pointing at a source file', async () => {
    const { code, err } = await capture(() => runStatus(['jbos'], refusingDriver, 0))
    expect(code).toBe(2)
    expect(err).toContain('jbos')
    expect(err).toContain('dead-letters')
    expect(err).toContain('--help')
  })
})
