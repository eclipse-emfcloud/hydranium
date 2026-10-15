# @hydranium/bookstore-host-browser

Bookstore in a browser page: every head runs in a web worker, with no backend
and no Node runtime. The page saves through the LSP head, and the worker
keeps each saved file in IndexedDB, laid over `../workspace` on the next
load.

```bash
npm run build              # type-check and bundle into out/
npm start                  # serve the page at the URL it prints, rebundled on every source change
npm run test:e2e:install   # download the Chromium the smoke test drives, once
npm run test:e2e           # the smoke test, which serves the page itself
```

`PORT` moves the page to another port, for `npm start` and the smoke test alike;
stop `npm start` before the smoke test, or give one of them another port.
`npm start` reads `../workspace` once, so restart it after editing a file
there.

## Layout

- `index.html` — the page, with a pane for each head that stays hidden until its part fills it
- `hydranium-mark.svg` — the tab icon
- `esbuild.mjs` — bundles the page, the worker and Monaco’s worker, reading `../workspace` in as the seed
- `src/worker.ts` — the worker: the heads over one store, seeded and persisted
- `src/page.ts` — starts the worker and runs the part of the page each head serves
- `src/editor.ts` — the LSP part: a Monaco editor, the file switch and Save
- `src/data-status.ts` — the data part: one document read through the data head
- `src/diagram.ts` — the GLSP part: the `Bookstore` diagram of the file the editor shows, defined in the client package
- `src/log.ts` — the status line and the log area
- `src/workspace.ts` — the workspace root URI both ends name
- `src/monaco-editor-worker.ts` — Monaco’s own worker, which hosts no head
- `src/posix-path-shim.ts` — the `path` function the framework imports, for the bundle
- `test/smoke.spec.mts` — the page loads, each head answers, and a saved edit survives a reload
