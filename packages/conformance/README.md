# `@hydranium/conformance`

The protocol conformance kit of the
[Hydranium](https://github.com/eclipse-emfcloud/hydranium) framework. You
install it as a dev dependency to check that your server speaks each head's
protocol: you supply a way to start the server and a few models, and the kit
adds one test per check to your own test runner.

## What it gives you

- A battery of checks per head, data, LSP and GLSP, that you run against your
  own server rather than write.
- A driver port per head that the framework's test harnesses already satisfy,
  so you can pass a harness in, or write a driver of your own.
- Adapters for vitest and Jest; the checks themselves name no test runner.
- Skips you can see: a check whose optional input you did not supply shows up
  skipped with its reason, and each suite prints what ran and what was skipped.
- A guard against a false green: every language needs an invalid model, so a
  model that parses clean fails the diagnostics checks.

## Install

```bash
npm install --save-dev @hydranium/conformance
```

| Peer                  | Range         |
| --------------------- | ------------- |
| `@hydranium/protocol` | `^1.0.0-next` |
| `@jest/globals`       | `^29.0.0`     |
| `vitest`              | `^4.0.0`      |
| `vscode-jsonrpc`      | `^9.0.0`      |

`vitest` and `@jest/globals` are optional peers: install the runner you use.

## Usage

Write one test file per head, and call the `run*Conformance` function from
your runner's adapter, `@hydranium/conformance/vitest` or
`@hydranium/conformance/jest`. The adapter also exports the driver ports, the
options and `GlspFixture`; `LanguageFixture` comes from the package root.

Each function takes `connect` and `languages`:

- **`connect`** returns a freshly wired driver. The kit calls it once per check
  and disposes the driver afterwards, so checks cannot interfere. The data
  slice wants the server ready, and saves documents beside each fixture's
  `valid`, so give each check a workspace the kit may write to and throw away.
  The LSP slice drives the `initialize` handshake itself, so `connect` must not
  initialise. The GLSP slice calls `start()` itself.
- **`languages`** is an array of `LanguageFixture`. `valid` and `invalid` are
  required, and every slice reads them. Every other field is opt-in: when you
  leave it out, its checks report skipped with a named reason. The
  `LanguageFixture` type says, per field, which slice reads it and what
  supplying it claims. A fixture's `uri` and `text` may be functions, read
  after `connect`, so they can point into the workspace `connect` just made.

The GLSP slice is generic over your action type and takes a `GlspFixture` per
diagram type. The fixture builds your native actions, and the kit matches the
responses by `kind`.

To check a deployed GLSP server rather than one built in your test process,
return `connectGlspSocketDriver({ port, diagramType, clientActionKinds })` from
`connect`. The driver sees only GLSP actions, so a create check's
`expectMutated` observes the write on a channel you hold, as a host would: the
`workspace/applyEdit` the server pushes on your LSP connection, for a document
you opened there first. It may return a promise for that push. A server that
lays out on the client finishes a load only once its `requestBounds` is
answered, so pass `respond` to send back the `computedBounds` a client would.

For where the kit fits among your other tests, see *Test your language* in
[Adopting Hydranium](https://github.com/eclipse-emfcloud/hydranium/blob/main/docs/ADOPTING.md).

## Entry points

| Subpath       | Use it for                                                   | Runs in |
| ------------- | ------------------------------------------------------------ | ------- |
| `.`           | `LanguageFixture` and the runner-agnostic check primitives.  | Node    |
| `./data`      | The data-head checks and driver port.                        | Node    |
| `./lsp`       | The LSP-head checks and driver port.                         | Node    |
| `./glsp`      | The GLSP-head checks and driver port.                        | Node    |
| `./glsp/node` | A GLSP driver over a socket, for a deployed server.          | Node    |
| `./vitest`    | Run the checks under vitest.                                 | Node    |
| `./jest`      | Run the checks under Jest.                                   | Node    |

The subpaths need a TypeScript `moduleResolution` that reads `exports`
(`NodeNext` or `Bundler`); see *Requirements* in
[Adopting Hydranium](https://github.com/eclipse-emfcloud/hydranium/blob/main/docs/ADOPTING.md).

## Status

Alpha: every release is a prerelease that may break the API, so pin an exact
version. Guides and known limitations:
[Adopting Hydranium](https://github.com/eclipse-emfcloud/hydranium/blob/main/docs/ADOPTING.md).

## License

`MIT` — see this package's [`LICENSE`](./LICENSE), and the repository
[`NOTICE.md`](https://github.com/eclipse-emfcloud/hydranium/blob/main/NOTICE.md)
for third-party notices.
