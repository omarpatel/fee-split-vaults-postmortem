/**
 * Runtime wiring.
 *
 * With no VITE_API_BASE_URL set, the app runs entirely on the fixture backend.
 * That is the demo mode, and every surface says so in the chrome rather than
 * quietly showing invented numbers as if they were measured. Set the variable
 * and the identical UI runs against apps/api with no other change.
 */

import { FixtureApiClient } from './api/fixtures/client.js'
import { FIXTURE_OPERATOR_TOKEN } from './api/fixtures/operator.js'
import { HttpApiClient, type ApiClient } from './api/client.js'
import { HttpOperatorApiClient, type OperatorApiClient } from './api/operator.js'

export interface AppEnv {
  client: ApiClient
  /** The operator console's client. Same base URL; the bearer is supplied per call. */
  operator: OperatorApiClient
  /** True when the data on screen is fixture data. Rendered, never hidden. */
  isDemo: boolean
  apiBaseUrl: string | null
  /** In demo mode, the bearer the fixture accepts; shown on the gate. Null against a real API. */
  demoOperatorToken: string | null
}

function readBaseUrl(): string | null {
  const raw = import.meta.env?.VITE_API_BASE_URL
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
}

export function createAppEnv(): AppEnv {
  const apiBaseUrl = readBaseUrl()
  if (apiBaseUrl === null) {
    const client = new FixtureApiClient({ latencyMs: 140 })
    return {
      client,
      operator: client.operator,
      isDemo: true,
      apiBaseUrl: null,
      demoOperatorToken: FIXTURE_OPERATOR_TOKEN,
    }
  }
  return {
    client: new HttpApiClient({ baseUrl: apiBaseUrl }),
    operator: new HttpOperatorApiClient({ baseUrl: apiBaseUrl }),
    isDemo: false,
    apiBaseUrl,
    demoOperatorToken: null,
  }
}
