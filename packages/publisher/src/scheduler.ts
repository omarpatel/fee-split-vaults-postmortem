export interface Clock {
  nowUnix(): number
}

export const systemClock: Clock = {
  nowUnix: () => Math.floor(Date.now() / 1000),
}

export interface FixedClock extends Clock {
  advance(seconds: number): void
  set(unix: number): void
}

export function createFixedClock(startUnix = 1_757_000_000): FixedClock {
  let current = startUnix
  return {
    nowUnix: () => current,
    advance(seconds) {
      current += seconds
    },
    set(unix) {
      current = unix
    },
  }
}

export interface DelayedTaskScheduler {
  schedule(id: string, afterSeconds: number, task: () => Promise<void>): void
  cancel(id: string): void
}

/**
 * Real scheduler. A process restart loses in-flight timers, so read-back is also
 * driven by a sweep over post records whose readBack is still unset - the timer
 * is the fast path, not the guarantee.
 */
export function createTimerScheduler(
  onError: (id: string, error: unknown) => void = () => undefined,
): DelayedTaskScheduler {
  const timers = new Map<string, NodeJS.Timeout>()

  return {
    schedule(id, afterSeconds, task) {
      const existing = timers.get(id)
      if (existing !== undefined) clearTimeout(existing)
      const timer = setTimeout(() => {
        timers.delete(id)
        void task().catch((error: unknown) => onError(id, error))
      }, Math.max(0, afterSeconds) * 1000)
      timer.unref?.()
      timers.set(id, timer)
    },
    cancel(id) {
      const timer = timers.get(id)
      if (timer !== undefined) {
        clearTimeout(timer)
        timers.delete(id)
      }
    },
  }
}

export interface ManualScheduler extends DelayedTaskScheduler {
  pending(): Array<{ id: string; dueAtUnix: number }>
  /** Run every task whose due time has arrived on the supplied clock. */
  runDue(): Promise<void>
  runAll(): Promise<void>
}

export function createManualScheduler(clock: Clock): ManualScheduler {
  const tasks = new Map<string, { dueAtUnix: number; task: () => Promise<void> }>()

  async function run(filter: (dueAtUnix: number) => boolean): Promise<void> {
    const due = [...tasks.entries()]
      .filter(([, entry]) => filter(entry.dueAtUnix))
      .sort((a, b) => a[1].dueAtUnix - b[1].dueAtUnix)
    for (const [id, entry] of due) {
      tasks.delete(id)
      await entry.task()
    }
  }

  return {
    schedule(id, afterSeconds, task) {
      tasks.set(id, { dueAtUnix: clock.nowUnix() + Math.max(0, afterSeconds), task })
    },
    cancel(id) {
      tasks.delete(id)
    },
    pending() {
      return [...tasks.entries()].map(([id, entry]) => ({ id, dueAtUnix: entry.dueAtUnix }))
    },
    async runDue() {
      await run((dueAtUnix) => dueAtUnix <= clock.nowUnix())
    },
    async runAll() {
      await run(() => true)
    },
  }
}
