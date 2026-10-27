# @hydranium/bookstore-host-theia-browser

Bookstore in a Theia browser application: the Theia extension in `../theia`, and
`../vscode-servers` sideloaded through `@theia/plugin-ext`, which starts the
server and its language client. The backend runs the server, so this is a Node
application; Theia serves the page. The servers extension contributes no editor,
so a diagram file opens in the Theia diagram editor alone.

```bash
npm run build              # bundle and type-check; build the members first
npm run watch              # rebundle whenever the members’ builds change; reload the page to pick it up
npm start                  # Theia at http://localhost:3000 on ../workspace; THEIA_PORT picks another port
npm run test:e2e:install   # download the Chromium the smoke test drives, once
npm run test:e2e           # the smoke test, which starts the application itself
```

The `theia` block of `package.json` sets `frontendConnectionTimeout`, without
which Theia ends the session on any dropped socket and the page reloads, and
`connectionBufferBytes`, the messages kept while the socket is down; the Theia
extension’s connection modules read both.

## Layout

- `esbuild.mjs` — the bundling `theia build` runs. It keeps this file, so it is the place to adjust the bundle
- `start.mjs` — `npm start`: links `../vscode-servers` into `plugins/`, then starts the backend on `THEIA_PORT`, on a folder given as its argument or `../workspace`
- `playwright.config.mts` — the smoke tier, on port 4938 or `THEIA_PORT`, on a copy of `../workspace` in `smoke-workspace/`
- `test/smoke.spec.mts` — Theia opens the workspace and each head answers
