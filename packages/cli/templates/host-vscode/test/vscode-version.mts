import { fileURLToPath } from 'node:url';

/**
 * The VS Code build the smoke test downloads and runs. Pinned rather than
 * `stable`, so a VS Code release cannot fail a run with no change here.
 */
export const VSCODE_VERSION = '1.141.0';

/** Where `@vscode/test-electron` keeps the download, below this package. */
export const VSCODE_CACHE = fileURLToPath(new URL('../.vscode-test', import.meta.url));
