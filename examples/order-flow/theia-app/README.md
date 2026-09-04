# `@hydranium/example-order-flow-theia-app`

The minimum **Theia browser application** that hosts the order-flow example. It
mounts [`../theia`](../theia/README.md) for the diagram and the properties view,
and sideloads [`../vscode-servers`](../vscode-servers/README.md) through
`@theia/plugin-ext` so a real VS Code extension host launches the language
server.

That split is the point rather than a shortcut. Hosting the **full** VS Code
shell would also register its `contributes.customEditors`, leaving `.process`
with two _Open With_ entries — the Theia GLSP diagram and the VS Code webview
editor. Any product shipping both hosts needs the same division.

**This package is also the home of the Playwright e2e tier** — the only place in
the repository where the whole four-process chain is exercised through a real
UI: browser frontend → Theia backend → plugin host → language server, with the
data and GLSP heads reached over their own sockets.

| Spec                              | What it observes                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `order-flow-properties.spec.mts`  | a panel write reaching the shared Langium workspace — renaming a `.process` root raises a diagnostic on its `.layout`, which is cross-document and cross-grammar |
| `order-flow-diagram.spec.mts`     | the diagram loading, with the ready-marker handshake read out of the **server's own log** rather than the UI, which cannot tell "never printed" from "never received" |
| `order-flow-diagnostics.spec.mts` | the extension's _second_ channel to the data head answering at all                                                                                     |
| `order-flow-restart.spec.mts`     | recovery after the language server is killed underneath the panel                                                                                      |

## Running it

```bash
npm --prefix examples/order-flow/theia-app run build
npm --prefix examples/order-flow/theia-app start      # http://localhost:3001
```

`npm run start:order-flow` from the repo root does both, and
`npm run dev:order-flow` runs the whole watch chain (framework, server, client,
theia, app). `build` is three steps: a native rebuild
(`theia rebuild:browser`), `link:plugin`, then `theia build`.

**Port 3001, not Theia's default 3000**, because a second Theia app is routinely
run beside this one and a shared port silently makes one suite drive the other's
binary.

## The e2e suite

```bash
npm --prefix examples/order-flow/theia-app run test:e2e:install   # once: Chromium
npm run build:all                                                 # the suite runs the BUILT bundle
npm --prefix examples/order-flow/theia-app run test:e2e           # headless
npm --prefix examples/order-flow/theia-app run test:e2e:headed
npm --prefix examples/order-flow/theia-app run test:e2e:ui
npm --prefix examples/order-flow/theia-app run test:e2e:restart
```

**`test:e2e` and `test:e2e:headed` both carry `--grep-invert @restart`, so
running only the obvious commands never runs the restart spec.** It needs
`test:e2e:restart`, which greps it back in and pins `--workers=1`. Two reasons,
and both matter: restarting the backend invalidates the shared app instance
every other spec reuses, and the spec kills a process by command-line pattern —
Theia gives each frontend connection its own plugin host, so a second spec
sharing the backend would lose its language server too.

Four more things that have cost time:

- **`reuseExistingServer` is on outside CI.** If anything already holds `:3001`,
  Playwright tests _that_ server instead of booting ours, and a suspiciously
  fast pass is the tell. It also means a backend you started by hand never saw
  the log-capture environment, so no server log is produced. The port is 3001
  rather than 3000 precisely because another Theia app routinely holds 3000.
- **The suite runs the bundle, not `tsc` output.** Rebuild after changing
  framework code or you are testing stale bytes.
- **`npm start` opens `../workspace` in place**, so a manual session dirties the
  fixture. The specs do not: they copy the tree into a temp directory. See
  [the workspace README](../workspace/README.md) for the full rule.
- **`link:plugin` is replaced on every build**, not preserved — a moved or
  renamed extension directory otherwise leaves a dangling link whose failure
  message names the target rather than the link.

Server logs land under `test-results/server-logs/`, on by default here and
renamed per spec once every server process has exited. Failures in a
multi-process handshake present as a promise that never settles, and a bare
"expected visible" timeout says nothing about which hop stalled.

## Not part of `npm run check`

There is no `test` script, deliberately, so a full `check` needs no browser
binary. The specs are still typechecked — `typecheck:test` is a turbo task here,
and `lint` covers `test` because this app has no `src` at all (`theia build`
assembles it from the generated `src-gen`).
