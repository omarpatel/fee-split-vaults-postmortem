/**
 * @fee-split-vaults/api - the control plane.
 *
 * Consent signing and verification, vault deployment, the dual-consent
 * onboarding machine, receipts, and the weekly report. It holds no dev key and
 * no spending tool: the operator signer it carries can deploy a vault at the
 * address a dev's consent fixed, bind it to its token and activate it once
 * the dev's own acceptance is on chain, and nothing else; the only other
 * authority it has is the authority to REFUSE, which is the authority that
 * matters at this boundary.
 */

export * from './config.js'
export * from './crypto/address.js'
export * from './crypto/secp256k1.js'
export * from './eip712.js'
export * from './agent.js'
export * from './consent.js'
export * from './echo.js'
export * from './deploy.js'
export * from './onboarding.js'
export * from './promotion.js'
export * from './purchases.js'
export * from './report.js'
export * from './routes.js'
export * from './store/pg.js'
export * from './vault-chain.js'
export * from './diligence/kyb.js'
export * from './diligence/probe.js'
export { StartupRefused, resolveLiveDeps, type LiveDeps } from './live.js'
export { createApp, startupBanner, type App, type AppDeps } from './main.js'
export * from './http/router.js'
export * from './http/json.js'
export * from './http/server.js'
export * from './v1/ports.js'
export * from './v1/routes.js'
export * from './v1/sessions.js'
export * from './v1/pg.js'
export * from './v1/chain.js'
export * from './v1/calldata.js'
