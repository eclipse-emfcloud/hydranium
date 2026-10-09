# `@hydranium/example-order-flow-theia-app`

The minimum **Theia browser application** that hosts the order-flow example. It
mounts [`../theia`](../theia/README.md) for the diagram and the properties view,
and sideloads [`../vscode-servers`](../vscode-servers/README.md) through
`@theia/plugin-ext` so a real VS Code extension host launches the language
server. Why the split, and how to build the same for your language:
[Host in Theia](../../../docs/guides/host-in-theia.md).

It is also the home of the **Playwright e2e suite**, which drives the whole
chain through a real UI: browser frontend, Theia backend, plugin host, language
server, and the data and GLSP heads over their own sockets.

| Spec | What it observes |
| ---- | ---------------- |
| [`order-flow-properties`](test/e2e/order-flow-properties.spec.mts) | a panel write reaching the server: an unresolvable reference comes back as a diagnostic, and the repair clears it |
| [`order-flow-diagram`](test/e2e/order-flow-diagram.spec.mts) | the diagram loading, its loading overlay coming down, and a reopened diagram that still edits and saves |
| [`order-flow-diagram-readonly`](test/e2e/order-flow-diagram-readonly.spec.mts) | a diagram over a document with a syntax error, saying why it is read-only |
| [`order-flow-log-level`](test/e2e/order-flow-log-level.spec.mts) | the diagram still loading with the server log level at `warn` |
| [`order-flow-diagnostics`](test/e2e/order-flow-diagnostics.spec.mts) | a diagnostics command reaching the data head over the connection the panel shares |
| [`order-flow-editor-sync`](test/e2e/order-flow-editor-sync.spec.mts) | an editor whose file is written with its unsaved text turning clean |
| [`order-flow-save-all`](test/e2e/order-flow-save-all.spec.mts) | Save All over a diagram and an editor on one unsaved file applying the edit once |
| [`order-flow-save-all-trim`](test/e2e/order-flow-save-all-trim.spec.mts) | the same with a save participant that trims whitespace |
| [`order-flow-stale-update`](test/e2e/order-flow-stale-update.spec.mts) | an editor saved after its file took some of its edits writing its whole text |
| [`order-flow-reload`](test/e2e/order-flow-reload.spec.mts) | what a reloaded page shows of the old page's saved and unsaved edits |
| [`order-flow-restart`](test/e2e/order-flow-restart.spec.mts) | `@restart`: the panel and the diagnostics commands recovering after the language server is killed |
| [`order-flow-diagram-restart`](test/e2e/order-flow-diagram-restart.spec.mts) | `@restart`: the diagram loading again on the replacement server |
| [`order-flow-reconnect`](test/reconnect/order-flow-reconnect.spec.mts) | edits landing across a dropped browser connection, through a proxy |

## Running it

```bash
npm --prefix examples/order-flow/theia-app run build
npm --prefix examples/order-flow/theia-app start      # http://localhost:3001
```

`npm run start:order-flow` from the repo root does both, and
`npm run dev:order-flow` runs the whole watch chain (framework, server, client,
theia, app). `build` is three steps: a native rebuild
(`theia rebuild:browser`), `link:plugin`, then `theia build`.

`npm start` opens `../workspace` in place; read the
[order-flow README](../README.md#the-fixture-workspace-is-edited-in-place) on
the fixture workspace before you edit anything in a manual session.

**Port 3001, not Theia's default 3000**, because a second Theia app is routinely
run beside this one and a shared port silently makes one suite drive the other's
binary. `THEIA_PORT` moves it, for `npm start` and for every e2e tier: the
reconnect tier's backend and proxy take the two ports above it.

## The e2e suite

```bash
npm --prefix examples/order-flow/theia-app run test:e2e:install   # once: Chromium
npm run build:all                                                 # the suite runs the BUILT bundle
npm --prefix examples/order-flow/theia-app run test:e2e           # headless
npm --prefix examples/order-flow/theia-app run test:e2e:headed
npm --prefix examples/order-flow/theia-app run test:e2e:ui
npm --prefix examples/order-flow/theia-app run test:e2e:restart
npm --prefix examples/order-flow/theia-app run test:e2e:reconnect
```

**`test:e2e` and `test:e2e:headed` both carry `--grep-invert @restart`, so
running only the obvious commands never runs the restart specs.** They need
`test:e2e:restart`, which greps them back in and pins `--workers=1`: restarting
the backend invalidates the shared app instance every other spec reuses, and a
spec kills a process by command-line pattern, so a second spec sharing the
backend would lose its language server too. The reconnect spec has its own
config, `playwright.reconnect.config.mts`, and runs only through
`test:e2e:reconnect`.

Pitfalls:

- **`reuseExistingServer` is on outside CI.** If anything already holds the
  port, Playwright tests _that_ server instead of booting ours, and a
  suspiciously fast pass is the tell. A backend you started by hand also never
  saw the log-capture environment, so no server log is produced.
- **The suite runs the bundle, not `tsc` output.** Rebuild after changing
  framework code or you are testing stale bytes.
- **`link:plugin` replaces the link on every build**, because a dangling link
  from a moved extension directory fails with a message naming the target.

Server logs land under `test-results/server-logs/`, renamed per spec once every
server process has exited. A failed multi-process handshake shows as a promise
that never settles, so read the log to find which hop stalled.

## Changing this example

There is no `test` script, so `npm run check` needs no browser binary. The specs
are still typechecked by `typecheck:test`, and `lint` covers `test` because this
app has no `src`: `theia build` assembles it from the generated `src-gen`.
