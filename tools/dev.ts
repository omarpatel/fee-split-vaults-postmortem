/**
 * dev - bring the control plane and the web app up together, from one command.
 *
 * WHAT IT DOES, in order, and it says which of these it skipped:
 *   1. writes .env.local if there is none (tools/bootstrap-env.ts --dev-identity);
 *   2. builds apps/api if dist/main.js is missing or older than src/;
 *   3. starts apps/api on PORT with that env file;
 *   4. starts the Vite dev server for apps/web.
 *
 * Ctrl-C stops both. If either exits on its own, the other is stopped too --
 * half a stack still running is how you spend ten minutes debugging a UI
 * against a server that died at boot.
 *
 * WHY apps/web DEFAULTS TO ITS FIXTURE BACKEND, AND NOT TO THE API IT JUST
 * STARTED. apps/api serves the whole of apps/web/src/api/routes.ts under /v1
 * (public reads without a token, the dashboard behind a wallet-signed session),
 * but a freshly booted control plane has no coins: the directory is `[]`, every
 * coin page is a 404, and the agent page answers 503 from this process. The
 * fixture backend is a real in-memory implementation of the same ApiClient
 * interface -- same lag, same tier gating, same split arithmetic -- that labels
 * itself as demo data in the chrome, and it is the mode in which you can see
 * the whole product before a coin has been onboarded.
 *
 * So --web-api exists, and it is OFF by default. On, the web app reads apps/api
 * for real and shows exactly what it holds. The API is up on its own port either
 * way; `curl localhost:8080/v1/coins` is the thing to point at to see it serve.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { ParsedValues } from './lib/cli.ts'
import { CliError, getBool, getNumber, getString, isEntrypoint, runCli } from './lib/cli.ts'

export const REPO_ROOT = join(import.meta.dirname, '..')

const SPEC = {
  name: 'dev',
  summary: 'Start apps/api and apps/web together against in-memory backends.',
  detail: `
    Bootstraps .env.local if missing, builds apps/api if stale, then runs both processes
    until Ctrl-C. apps/web uses its in-memory fixture backend by default because a fresh
    apps/api holds no coins; --web-api points it at the API instead.
  `,
  options: [
    {
      name: 'api-port',
      type: 'number' as const,
      describe: 'Port for apps/api. Overrides PORT in the env file.',
      default: 8080,
    },
    {
      name: 'web-port',
      type: 'number' as const,
      describe: 'Port for the Vite dev server.',
      default: 5273,
    },
    {
      // NOT --env-file: Node intercepts that name anywhere in argv, even after
      // the script path, and tries to load the file itself. See the same note in
      // tools/bootstrap-env.ts.
      name: 'env',
      type: 'string' as const,
      placeholder: '<path>',
      describe: 'Environment file to start the API with. Created by bootstrap-env if absent.',
      default: '.env.local',
    },
    {
      name: 'web-api',
      type: 'boolean' as const,
      describe:
        'Point apps/web at the API via VITE_API_BASE_URL. OFF by default: a fresh API holds no coins, so the directory is empty.',
    },
    { name: 'no-build', type: 'boolean' as const, describe: 'Skip the apps/api build even if dist looks stale.' },
    { name: 'no-web', type: 'boolean' as const, describe: 'Start only apps/api.' },
    { name: 'no-api', type: 'boolean' as const, describe: 'Start only apps/web.' },
  ],
  examples: [
    'npm run dev                    # both, web on fixtures, API on :8080',
    'npm run dev -- --web-api       # web pointed at the API (empty until a coin is onboarded)',
    'npm run dev -- --no-web        # just the control plane',
  ],
  usage: 'npm run dev [-- options]   |   node tools/dev.ts [options]',
}

const log = (message: string): void => {
  process.stdout.write(`dev: ${message}\n`)
}

/** Newest mtime under a directory tree, or 0 when it does not exist. */
export function newestMtimeMs(dir: string): number {
  if (!existsSync(dir)) return 0
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue
    const path = join(dir, entry.name)
    const mtime = entry.isDirectory() ? newestMtimeMs(path) : statSync(path).mtimeMs
    if (mtime > newest) newest = mtime
  }
  return newest
}

/** True when apps/api/dist is missing or older than apps/api/src. */
export function apiBuildIsStale(root: string): boolean {
  const entry = join(root, 'apps', 'api', 'dist', 'main.js')
  if (!existsSync(entry)) return true
  return newestMtimeMs(join(root, 'apps', 'api', 'src')) > statSync(entry).mtimeMs
}

function runSync(command: string, args: readonly string[], label: string): void {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: 'inherit' })
  if (result.error !== undefined) throw new CliError(`${label} could not start: ${result.error.message}`)
  if (result.status !== 0) throw new CliError(`${label} failed with exit code ${String(result.status)}`)
}

export async function main(values: ParsedValues): Promise<void> {
  const envFileArg = getString(values, 'env') ?? '.env.local'
  const envFile = join(REPO_ROOT, envFileArg)
  const apiPort = getNumber(values, 'api-port', 8080)
  const webPort = getNumber(values, 'web-port', 5273)
  const startApi = !getBool(values, 'no-api')
  const startWeb = !getBool(values, 'no-web')

  if (!startApi && !startWeb) throw new CliError('--no-api and --no-web together leave nothing to run.')

  if (startApi && !existsSync(envFile)) {
    log(`${envFileArg} is missing; generating one with DEV-ONLY values.`)
    runSync(
      process.execPath,
      [join(REPO_ROOT, 'tools', 'bootstrap-env.ts'), '--dev-identity', '--env-out', envFileArg],
      'bootstrap-env',
    )
  }

  if (startApi && !getBool(values, 'no-build') && apiBuildIsStale(REPO_ROOT)) {
    log('apps/api/dist is missing or older than src; building.')
    runSync(process.execPath, [join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--build'], 'tsc --build')
  }

  const children: { name: string; child: ChildProcess }[] = []
  let stopping = false

  const stopAll = (): void => {
    if (stopping) return
    stopping = true
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }
  }

  const track = (name: string, child: ChildProcess): void => {
    children.push({ name, child })
    child.on('exit', (code, signal) => {
      if (stopping) return
      log(`${name} exited (code ${String(code)}, signal ${String(signal)}); stopping the rest.`)
      process.exitCode = code === 0 || code === null ? 0 : code
      stopAll()
    })
  }

  if (startApi) {
    log(`apps/api  -> http://127.0.0.1:${String(apiPort)}   (env: ${envFileArg})`)
    track(
      'apps/api',
      spawn(process.execPath, [`--env-file=${envFile}`, join(REPO_ROOT, 'apps', 'api', 'dist', 'main.js')], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        env: { ...process.env, PORT: String(apiPort) },
      }),
    )
  }

  if (startWeb) {
    const webApi = getBool(values, 'web-api')
    const baseUrl = `http://127.0.0.1:${String(apiPort)}`
    log(`apps/web  -> http://127.0.0.1:${String(webPort)}`)
    if (webApi) {
      log(`apps/web is pointed at ${baseUrl} (--web-api).`)
      log('The directory and coin pages read apps/api; they are empty until a coin is onboarded,')
      log('and the agent page answers 503 agent_not_wired from this process.')
    } else {
      log('apps/web is on its IN-MEMORY FIXTURE backend; --web-api points it at the API instead.')
    }
    track(
      'apps/web',
      spawn(
        process.execPath,
        [join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(webPort)],
        {
          cwd: join(REPO_ROOT, 'apps', 'web'),
          stdio: 'inherit',
          env: {
            ...process.env,
            ...(webApi ? { VITE_API_BASE_URL: baseUrl } : {}),
          },
        },
      ),
    )
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log(`${signal}; stopping.`)
      stopAll()
    })
  }

  await Promise.all(
    children.map(
      ({ child }) =>
        new Promise<void>((resolve) => {
          child.on('exit', () => {
            resolve()
          })
          child.on('error', () => {
            resolve()
          })
        }),
    ),
  )
}

if (isEntrypoint(import.meta.url)) {
  await runCli(SPEC, process.argv.slice(2), main)
}

export { SPEC as DEV_SPEC }
