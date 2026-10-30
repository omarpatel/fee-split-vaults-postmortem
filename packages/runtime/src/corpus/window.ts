import { CORPUS_LIMITS } from '@fee-split-vaults/core'

/**
 * Fixed-schedule windows.
 *
 * There is deliberately NO wake-on-mention entry point on this module. Nothing
 * an attacker can write causes a reader call to happen; the only thing that
 * causes a reader call is the clock. That is what makes a mention flood cost the
 * same as a quiet window.
 *
 * Windows are aligned to the Unix epoch rather than to a coin's activation time,
 * so every coin's schedule is derivable from the clock alone and two coins never
 * drift into a pattern an observer could use to fingerprint activity.
 */

export interface CorpusWindow {
  /** `${coinRef}:${startUnix}`. Not attacker-controlled. */
  windowId: string
  coinRef: string
  startUnix: number
  endUnix: number
}

export function windowLengthSeconds(windowMinutes: number = CORPUS_LIMITS.windowMinutes): number {
  if (!Number.isInteger(windowMinutes) || windowMinutes <= 0) {
    throw new Error('windowMinutes must be a positive integer')
  }
  return windowMinutes * 60
}

export function windowStartFor(nowUnix: number, windowMinutes?: number): number {
  const len = windowLengthSeconds(windowMinutes)
  return Math.floor(nowUnix / len) * len
}

export function windowFor(coinRef: string, nowUnix: number, windowMinutes?: number): CorpusWindow {
  assertCoinRef(coinRef)
  const len = windowLengthSeconds(windowMinutes)
  const startUnix = windowStartFor(nowUnix, windowMinutes)
  return {
    windowId: `${coinRef}:${String(startUnix)}`,
    coinRef,
    startUnix,
    endUnix: startUnix + len,
  }
}

/** The window that has just closed at `nowUnix`, which is the one to read. */
export function closedWindowAt(
  coinRef: string,
  nowUnix: number,
  windowMinutes?: number,
): CorpusWindow {
  const len = windowLengthSeconds(windowMinutes)
  return windowFor(coinRef, windowStartFor(nowUnix, windowMinutes) - len, windowMinutes)
}

/**
 * Every window in [fromUnix, toUnix). The count is a pure function of the clock,
 * which is the property the flood test asserts.
 */
export function windowsBetween(
  coinRef: string,
  fromUnix: number,
  toUnix: number,
  windowMinutes?: number,
): CorpusWindow[] {
  if (toUnix < fromUnix) throw new Error('toUnix must not precede fromUnix')
  const len = windowLengthSeconds(windowMinutes)
  const out: CorpusWindow[] = []
  for (let start = windowStartFor(fromUnix, windowMinutes); start < toUnix; start += len) {
    out.push(windowFor(coinRef, start, windowMinutes))
  }
  return out
}

/** windowId feeds Digest.windowId, which validateDigest caps at 128 characters. */
function assertCoinRef(coinRef: string): void {
  if (coinRef.length === 0 || coinRef.length > 96) {
    throw new Error('coinRef must be a short non-empty opaque reference')
  }
  if (!/^[A-Za-z0-9_-]+$/.test(coinRef)) {
    throw new Error('coinRef must be opaque: [A-Za-z0-9_-] only')
  }
}
