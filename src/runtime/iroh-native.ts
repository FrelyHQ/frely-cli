/**
 * The iroh native module as a single-file build embeds it. Left null in the repository: `build:standalone` writes the
 * target's `.node` import here for the build and restores this file afterwards, so the npm package loads `@number0/iroh`
 * from node_modules instead (see p2p.ts).
 */
export const embeddedIroh: unknown = null;
