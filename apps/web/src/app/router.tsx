import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

/**
 * A path router in sixty lines, because this app has four routes and a routing
 * library would be the largest dependency in it.
 *
 * PATHS, NOT HASHES. The publisher stamps `${receiptsBaseUrl}/${vault}` into
 * every disclosure it emits, so the public coin page has to live at that exact
 * path. A hash router would make every published receipt link wrong.
 */

export const OPS_PAGES = ['queue', 'narrative', 'creative', 'accounts', 'purchases', 'kyb'] as const
export type OpsPage = (typeof OPS_PAGES)[number]

export type Route =
  | { name: 'directory' }
  | { name: 'coin'; vault: string }
  /** The coin's agent team. A sub-path of the coin page, not a sibling. */
  | { name: 'agent'; vault: string }
  | { name: 'dev'; vault: string | null }
  | { name: 'onboarding' }
  /**
   * The operator console. `id` is an onboarding id (narrative, creative,
   * accounts) or a vault (purchases); the bearer is never part of the path.
   */
  | { name: 'ops'; page: OpsPage; id: string | null }
  | { name: 'not_found'; path: string }

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
/** An onboarding id as apps/api accepts it. */
const OPS_ID = /^[A-Za-z0-9_.:-]{1,64}$/

export function parseRoute(pathname: string): Route {
  const segments = pathname.split('/').filter((segment) => segment.length > 0)

  if (segments.length === 0) return { name: 'directory' }

  const [first, second] = segments
  if (first === 'onboarding') return { name: 'onboarding' }
  if (first === 'dev') {
    return { name: 'dev', vault: second !== undefined && ADDRESS.test(second) ? second.toLowerCase() : null }
  }
  if (first === 'ops') {
    if (second === undefined) return { name: 'ops', page: 'queue', id: null }
    const page = OPS_PAGES.find((candidate) => candidate === second)
    if (page === undefined || segments.length > 3) return { name: 'not_found', path: pathname }
    const third = segments[2]
    if (third === undefined) return { name: 'ops', page, id: null }
    const id = decodeURIComponent(third)
    if (page === 'purchases' ? !ADDRESS.test(id) : !OPS_ID.test(id)) return { name: 'not_found', path: pathname }
    return { name: 'ops', page, id: page === 'purchases' ? id.toLowerCase() : id }
  }
  if (first !== undefined && ADDRESS.test(first)) {
    if (segments.length === 1) return { name: 'coin', vault: first.toLowerCase() }
    // Deliberately a sub-path of the coin page rather than /agent/<vault>: the
    // team is a view OF a coin, and the URL says so.
    if (segments.length === 2 && second === 'agent') {
      return { name: 'agent', vault: first.toLowerCase() }
    }
  }
  return { name: 'not_found', path: pathname }
}

export function hrefFor(route: Route): string {
  switch (route.name) {
    case 'directory':
      return '/'
    case 'coin':
      return `/${route.vault}`
    case 'agent':
      return `/${route.vault}/agent`
    case 'dev':
      return route.vault === null ? '/dev' : `/dev/${route.vault}`
    case 'onboarding':
      return '/onboarding'
    case 'ops':
      return route.id === null ? `/ops/${route.page}` : `/ops/${route.page}/${encodeURIComponent(route.id)}`
    case 'not_found':
      return route.path
  }
}

interface RouterValue {
  route: Route
  navigate: (route: Route) => void
}

const RouterContext = createContext<RouterValue | null>(null)

export function RouterProvider({ children }: { children: ReactNode }) {
  const [pathname, setPathname] = useState(() => globalThis.location?.pathname ?? '/')

  useEffect(() => {
    const onPop = () => setPathname(globalThis.location.pathname)
    globalThis.addEventListener('popstate', onPop)
    return () => globalThis.removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((route: Route) => {
    const href = hrefFor(route)
    globalThis.history.pushState({}, '', href)
    setPathname(href)
    globalThis.scrollTo({ top: 0 })
  }, [])

  const value = useMemo<RouterValue>(() => ({ route: parseRoute(pathname), navigate }), [pathname, navigate])

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext)
  if (value === null) throw new Error('useRouter called outside RouterProvider')
  return value
}

export function Link({
  to,
  children,
  className,
  ...rest
}: {
  to: Route
  children: ReactNode
  className?: string
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'>) {
  const { navigate, route } = useRouter()
  const href = hrefFor(to)
  const current = hrefFor(route) === href

  return (
    <a
      href={href}
      className={className}
      {...(current ? { 'aria-current': 'page' as const } : {})}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
        event.preventDefault()
        navigate(to)
      }}
      {...rest}
    >
      {children}
    </a>
  )
}
