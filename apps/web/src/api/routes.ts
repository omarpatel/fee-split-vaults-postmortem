/**
 * THE ROUTE CONTRACT this app expects from apps/api.
 *
 * apps/api did not exist when this client was written, so this table IS the
 * expectation rather than a description of something already shipped. It is
 * kept as data, not prose, so the HTTP client below builds every URL from it
 * and a route that moves breaks the build in one place.
 *
 * CONVENTIONS THE SERVER MUST HOLD TO:
 *
 *  1. Amounts on the wire are DECIMAL STRINGS of integers, never JSON numbers.
 *     Asset amounts are minor units of the named asset; USD amounts are cents.
 *     JSON numbers are IEEE doubles and a fee ledger does not survive that.
 *     The one exception is qfPerDayUsd, which is a measurement rather than an
 *     amount and is documented as such at its use site.
 *
 *  2. Every USD figure derived from a price carries { priceSource, pricedAtUnix,
 *     blockHash? }. An unattributed dollar figure on a receipts page is a claim.
 *
 *  3. Public routes take no credentials and set no cookie. The coin page is an
 *     artifact anyone can read and cache.
 *
 *  4. Dev routes take `Authorization: Bearer <session>` from the signature
 *     exchange. There are no passwords anywhere in this app.
 *
 *  5. NO ROUTE EVER SIGNS OR SENDS A TRANSACTION. State-changing dev controls
 *     return an UnsignedTx and the dev's own wallet sends it. The operator
 *     holds no key that can move a dev's money, and the API surface is shaped
 *     so that stays true.
 */

export const API_ROUTES = {
  // --- public -------------------------------------------------------------
  /** GET -> ProtocolInfoWire. Deployment addresses, operator identity, terms. */
  protocol: () => '/v1/protocol',
  /** GET -> CoinSummaryWire[]. The member directory. */
  coins: () => '/v1/coins',
  /**
   * GET -> PublicCoinWire. The receipts artifact for one coin. Carries the
   * scrubbed `subject` and `narrativeApproved`; never links, sources or socials.
   */
  coin: (vault: string) => `/v1/coins/${vault}`,
  /** GET -> ReceiptPageWire. Cursor-paged, newest first. */
  coinReceipts: (vault: string) => `/v1/coins/${vault}/receipts`,
  /** GET -> VendorScorecardWire[]. Measured, not vendor-reported. */
  coinVendors: (vault: string) => `/v1/coins/${vault}/vendors`,

  /**
   * The agent team. THESE THREE ARE NOT ASPIRATIONAL.
   *
   * Every other entry in this table describes a route apps/api has yet to
   * serve, which is why the header calls this file an expectation. These three
   * name paths apps/api actually implements today, so they carry no `/v1`
   * prefix: they are written exactly as the server routes them, and pointing
   * VITE_API_BASE_URL at apps/api makes the agent page work for real.
   *
   * All three are read-only and gated by the operator bearer token, the same as
   * every non-public route on that service.
   */
  /** GET -> CoinAgentWire. The six roles, the last tick, spend against the cap. */
  coinAgent: (vault: string) => `/coins/${vault}/agent`,
  /** GET ?cursor=&limit= -> AgentRunPageWire. Per-tick history, newest first. */
  coinAgentRuns: (vault: string) => `/coins/${vault}/agent/runs`,
  /** GET -> { roles }. What each role may and may not do at this vault's tier. */
  coinAgentRoles: (vault: string) => `/coins/${vault}/agent/roles`,

  // --- wallet auth --------------------------------------------------------
  /** POST { address } -> AuthChallengeWire. */
  authNonce: () => '/v1/auth/nonce',
  /** POST { address, message, signature } -> SessionWire. */
  authVerify: () => '/v1/auth/verify',

  // --- dev dashboard (bearer session) -------------------------------------
  /** GET -> CoinSummaryWire[] for the signed-in address only. */
  devVaults: () => '/v1/dev/vaults',
  /** GET -> DevVaultDetailWire. */
  devVault: (vault: string) => `/v1/dev/vaults/${vault}`,
  /** GET -> WeeklyReportWire[], newest first. */
  devReports: (vault: string) => `/v1/dev/vaults/${vault}/reports`,
  /** GET -> EscalationWire[]. The desk's queue for a human. */
  devEscalations: (vault: string) => `/v1/dev/vaults/${vault}/escalations`,
  /** POST { decision, note } -> EscalationWire. */
  devEscalationAck: (vault: string, id: string) =>
    `/v1/dev/vaults/${vault}/escalations/${id}/ack`,
  /** POST { budgetBps } -> UnsignedTxWire. Raising is instant; lowering waits. */
  devDialTx: (vault: string) => `/v1/dev/vaults/${vault}/dial-tx`,
  /** GET -> UnsignedTxWire for terminate(). onlyDev on chain. */
  devTerminateTx: (vault: string) => `/v1/dev/vaults/${vault}/terminate-tx`,

  // --- onboarding ---------------------------------------------------------
  /**
   * POST { devSigner, devPayout, token, budgetBpsMax, referrer?, narrativeSources?,
   * socials? } -> ConsentQuoteWire. narrativeSources: <=4 https URLs on public
   * hosts, deduped server-side. socials: { x? } handle, '@' tolerated.
   */
  onboardingQuote: () => '/v1/onboarding/quote',
  /** POST { consent, signature } -> DeploymentTicketWire. */
  onboardingSubmit: () => '/v1/onboarding/submit',
  /** GET ?vault= -> RetrofitPlanWire, including the strandable-credit preflight. */
  onboardingRetrofit: (token: string) => `/v1/onboarding/retrofit/${token}`,
} as const

export type ApiRouteName = keyof typeof API_ROUTES
