# Test your language

Use this when you add to your language and want tests that catch what you
break. `init` already writes a test for each layer of a new language; this
guide is how to grow them, from a parse to a whole head, and where the
framework's test helpers fit.

Heads: any

## The seam

Tests run on vitest, as `init` sets them up: `npm test` type-checks the tests
and runs them. The framework's helpers live in `/testing` subpaths, such as
`@hydranium/core/testing` and `@hydranium/glsp-server/testing`, and need Node
where the subpath ends in `/node`. They are how the framework and its examples
test themselves, and they can change between prereleases more freely than a
package's main entry; see
[Status and limitations](../adopting/status.md#stability-and-versioning).

## Steps

1. **Start from the scaffold's tests.** `test/` holds one file per layer:
   the services compose, the starter rules parse, references link within and
   across documents, a dangling reference is reported, and a model serializes
   back to text. With a diagram, a further test runs a create-node operation,
   an undo and a redo against a real GLSP server. Keep each layer's test next
   to the rules it checks as you change them.

2. **Test each validation check you add.** Parse a model with `parseHelper`,
   build it with validation, and assert the diagnostic, both where it must
   appear and where it must not. The scaffold's `validating.test.ts` has the
   shape:
   `await shared.workspace.DocumentBuilder.build([document], { validation: true })`,
   then `document.diagnostics`. Check that the test can fail: remove the
   check's binding, and it must turn red.

3. **Test a head in process.** Each head has a harness that runs it without a
   socket: `makeLspHarness` from `@hydranium/core/testing/node`,
   `makeDataServerHarness` from `@hydranium/data-server/testing`, and
   `makeGlspHarness` from `@hydranium/glsp-server/testing`. Give it a
   throwaway workspace from `makeScratchWorkspace`, so a test never writes to
   your committed models. The scaffold's diagram test is a complete example.

4. **Wait for events, never for time.** A head answers asynchronously. Wait
   with `waitFor` from `@hydranium/protocol/testing`, which resolves as soon as
   its condition holds, instead of a fixed sleep. Its default timeout is short,
   so give a slow step, such as starting a separate process, a longer one, or
   better, await the event that says it is ready.

5. **Run the conformance kit.** `@hydranium/conformance` checks that a head
   behaves as every client expects: sessions, saves, dirty state, diagnostics.
   You supply a valid and an invalid model per language and a way to connect;
   it supplies the checks. The order-flow server runs it for all three heads,
   in `test/data-conformance.integration.test.ts`,
   `test/lsp-conformance.integration.test.ts` and
   `test/glsp/glsp-conformance.integration.test.ts`; its
   [README](../../packages/conformance/README.md) explains the fixtures. Break
   one fixture on purpose once, and check that the check you expect turns red.

6. **Test the server as a process.** `startSpawnedServer` from
   `@hydranium/core/testing/node` spawns your built server and completes the
   LSP handshake with it, which is the only place a wrong launch argument or a
   log line written to stdout shows. When the server fails to start, the error
   quotes what it printed.

7. **Drive a UI with Playwright.** For an end-to-end test of a page or a
   Theia app, use Playwright. Its headless Chromium counts as a visible tab; a
   diagram never loads in a hidden one, so a browser you do not control can
   make a working diagram look hung.

## Going further

The framework's own test layers, and how it decides which one a change needs,
are in [Testing](../contributing/testing.md).
