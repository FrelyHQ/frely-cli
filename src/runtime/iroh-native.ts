/**
 * Loads the iroh native module a single-file build embeds. Left null in the repository: `build:standalone` writes a loader for the
 * target's `.node` file here for the build and restores this file afterwards, so the npm package loads `@number0/iroh`
 * from node_modules instead (see p2p.ts). The loader runs only when transfers are used, so a module that cannot load on this
 * system (for example an older glibc) turns off direct transfers instead of stopping the CLI at start-up.
 */
export const loadEmbeddedIroh: (() => unknown) | null = null;
