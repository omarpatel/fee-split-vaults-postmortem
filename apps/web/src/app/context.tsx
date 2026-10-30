import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import type { ApiClient } from '../api/client.js'
import type { ProtocolInfo, Session } from '../api/model.js'
import { createAppEnv, type AppEnv } from '../env.js'
import type { Wallet } from '../wallet/types.js'

/**
 * Application context.
 *
 * The API client, the connected wallet and the signed-in session are the three
 * things nearly every page needs. The session is deliberately NOT persisted to
 * storage: it is a bearer token for a wallet-signature login, and re-signing on
 * reload costs a click while a stored token is a token that can be stolen from
 * a shared machine.
 */

interface AppContextValue {
  env: AppEnv
  client: ApiClient
  protocol: ProtocolInfo | null
  protocolError: string | null
  wallet: Wallet | null
  setWallet: (wallet: Wallet | null) => void
  session: Session | null
  setSession: (session: Session | null) => void
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const env = useMemo(() => createAppEnv(), [])
  const [protocol, setProtocol] = useState<ProtocolInfo | null>(null)
  const [protocolError, setProtocolError] = useState<string | null>(null)
  const [wallet, setWallet] = useState<Wallet | null>(null)
  const [session, setSession] = useState<Session | null>(null)

  useEffect(() => {
    let live = true
    env.client
      .getProtocol()
      .then((info) => {
        if (live) setProtocol(info)
      })
      .catch((error: unknown) => {
        if (live) setProtocolError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      live = false
    }
  }, [env])

  // A session outlives its own expiry only as a stale object in memory; drop it
  // on the tick so a control cannot be enabled against a dead token.
  useEffect(() => {
    if (session === null) return
    const msRemaining = session.expiresAtUnix * 1_000 - Date.now()
    if (msRemaining <= 0) {
      setSession(null)
      return
    }
    const timer = setTimeout(() => setSession(null), msRemaining)
    return () => clearTimeout(timer)
  }, [session])

  const value = useMemo<AppContextValue>(
    () => ({
      env,
      client: env.client,
      protocol,
      protocolError,
      wallet,
      setWallet,
      session,
      setSession,
    }),
    [env, protocol, protocolError, wallet, session],
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext)
  if (value === null) throw new Error('useApp called outside AppProvider')
  return value
}

/**
 * A tiny async-resource hook. Enough for this app; no data library needed.
 * `error` is the message for an error panel; `cause` is the thrown value, for
 * the one page that needs to tell a 404 from an outage.
 */
export function useAsync<T>(
  load: () => Promise<T>,
  deps: unknown[],
): { data: T | null; error: string | null; cause: unknown; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cause, setCause] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    setCause(null)
    load()
      .then((result) => {
        if (!live) return
        setData(result)
        setLoading(false)
      })
      .catch((thrown: unknown) => {
        if (!live) return
        setData(null)
        setError(thrown instanceof Error ? thrown.message : String(thrown))
        setCause(thrown)
        setLoading(false)
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  return { data, error, cause, loading, reload: () => setNonce((value) => value + 1) }
}
