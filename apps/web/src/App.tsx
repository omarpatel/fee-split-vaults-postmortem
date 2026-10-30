import { AppProvider, useApp } from './app/context.js'
import { Link, RouterProvider, useRouter } from './app/router.js'
import { ThemeToggle } from './components/primitives.js'
import { AgentPage } from './pages/AgentPage.js'
import { CoinPage } from './pages/CoinPage.js'
import { DevDashboard } from './pages/DevDashboard.js'
import { Directory } from './pages/Directory.js'
import { Onboarding } from './pages/Onboarding.js'
import { OpsConsole } from './pages/ops/OpsConsole.js'
import { DISCLOSURE } from './protocol.js'
import { COMPENSATION_SENTENCE } from './domain/disclosure.js'

export function App() {
  return (
    <AppProvider>
      <RouterProvider>
        <Shell />
      </RouterProvider>
    </AppProvider>
  )
}

function Shell() {
  const { route } = useRouter()

  return (
    <>
      <Masthead />
      <main>
        {route.name === 'directory' && <Directory />}
        {route.name === 'coin' && <CoinPage vault={route.vault} />}
        {route.name === 'agent' && <AgentPage vault={route.vault} />}
        {route.name === 'dev' && <DevDashboard vault={route.vault} />}
        {route.name === 'onboarding' && <Onboarding />}
        {route.name === 'ops' && <OpsConsole page={route.page} id={route.id} />}
        {route.name === 'not_found' && <NotFound path={route.path} />}
      </main>
      <SiteFooter />
    </>
  )
}

function Masthead() {
  return (
    <header className="masthead">
      <div className="masthead-inner">
        <Link to={{ name: 'directory' }} className="brand">
          Fee split vaults <small>creator-fee vault receipts</small>
        </Link>
        <nav className="nav">
          <Link to={{ name: 'directory' }}>Members</Link>
          <Link to={{ name: 'dev', vault: null }}>Dev dashboard</Link>
          <Link to={{ name: 'onboarding' }}>Onboarding</Link>
          <Link to={{ name: 'ops', page: 'queue', id: null }}>Operator</Link>
        </nav>
        <span className="spacer" />
        <ThemeToggle />
      </div>
    </header>
  )
}

/**
 * The site footer carries the compensation sentence on every route.
 *
 * 17(b) is about the disclosure being IN the communication. A directory listing
 * and a dashboard are communications too, so the sentence is not confined to
 * the coin page's disclosure block.
 */
function SiteFooter() {
  const { protocol, env } = useApp()
  const operator = protocol?.operatorLegalName ?? 'SET_ME_BEFORE_LAUNCH'

  return (
    <footer className="footer">
      <div className="footer-inner stack-tight">
        <p>
          <strong>{DISCLOSURE.aiOperationTag}</strong> by {operator}. Disclosure:{' '}
          {COMPENSATION_SENTENCE}
        </p>
        <p className="tiny faint">
          Nothing on this site is investment advice, a price prediction, or a recommendation to buy
          or sell anything. The support desk refuses those questions as a class.
          {env.apiBaseUrl === null && ' Running on the in-memory fixture backend.'}
        </p>
      </div>
    </footer>
  )
}

function NotFound({ path }: { path: string }) {
  return (
    <div className="page stack" style={{ paddingTop: 'var(--gap-5)' }}>
      <h1>Not here</h1>
      <p className="lede">
        <code>{path}</code> is not a member coin page. Coin pages live at{' '}
        <code>/&lt;vault address&gt;</code>, which is the same link the desk publishes in its
        disclosures, and each coin&rsquo;s agent team lives at{' '}
        <code>/&lt;vault address&gt;/agent</code>.
      </p>
      <div>
        <Link to={{ name: 'directory' }} className="btn">
          All member coins
        </Link>
      </div>
    </div>
  )
}
