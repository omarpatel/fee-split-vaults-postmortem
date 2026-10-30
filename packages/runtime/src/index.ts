/**
 * @fee-split-vaults/runtime - the two-plane agent runtime.
 *
 * The plane split is the security argument, so it is structural:
 *
 *   Reader  (cognition, untrusted input)  - no tools, ever. READER_TOOLS is
 *           asserted empty at construction. Emits four fields of a Digest; the
 *           rest are filled in by trusted code the model cannot reach.
 *   Planner (cognition, trusted input)    - sees a re-validated Digest and
 *           nothing else. Calls only PLANNER_TOOL_NAMES, single-shot, with no
 *           tool_result ever returned, so no proposal executes.
 *   Desk    (cognition, untrusted input)  - no tools, fail-closed refusal
 *           classifier on the output, placeholders substituted by trusted code.
 *
 * Corpus assembly is deterministic and model-free, which is what makes a
 * 500,000-message flood cost exactly what a 500-message window costs.
 */

export * from './protocol.js'

export * from './model/ids.js'
export * from './model/client.js'
export * from './model/fake.js'
export * from './model/routing.js'
export { createAnthropicModelClient, toCreateParams, fromMessage } from './model/anthropic.js'
export type { AnthropicModelClientOptions } from './model/anthropic.js'

export * from './corpus/sanitize.js'
export * from './corpus/window.js'
export * from './corpus/assemble.js'

export * from './cognition/prompts.js'
export * from './cognition/guards.js'
export * from './cognition/reader.js'
export * from './cognition/plannerTools.js'
export * from './cognition/planner.js'
export * from './cognition/refusal.js'
export * from './cognition/desk.js'

export * from './narrative/derive.js'

export * from './divergence/detector.js'

export * from './cost/pricing.js'
export * from './cost/governor.js'

export * from './isolation/userId.js'

export * from './runtime/coinRuntime.js'
export * from './runtime/registry.js'
