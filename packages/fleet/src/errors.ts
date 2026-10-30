/**
 * The one error this package throws on the way up.
 *
 * It lives in its own module because both `bootstrap.ts` and `adapters.ts`
 * throw it and bootstrap imports adapters; declaring it in either one would
 * make the other import a cycle.
 *
 * THERE IS ONLY ONE, AND THAT IS DELIBERATE. Startup has exactly one correct
 * failure mode - stop, and say what was asked for that could not be honoured -
 * so a taxonomy of startup errors would only invite a caller to catch some of
 * them and continue. A fleet that continues past a missing dependency is a
 * fleet serving fiction under a real name.
 */
export class FleetStartupRefused extends Error {
  constructor(message: string) {
    super(`fleet refusing to start: ${message}`)
    this.name = 'FleetStartupRefused'
  }
}
