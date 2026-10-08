# `@hydranium/langium`

[Langium](https://langium.org/), re-exported for the
[Hydranium](https://github.com/eclipse-emfcloud/hydranium) framework. Import
Langium through this package so your install has one copy of it and the
framework owns the Langium version chain. `@hydranium/core` takes it as a peer,
so you install it alongside.

## What it gives you

- Langium's full API, unfiltered. Replace `langium` with `@hydranium/langium` in
  your imports; nothing else changes, because the symbols are the same objects.
- A mirror of each Langium subpath, so `langium/lsp`, `langium/node` and
  `langium/test` go through the same pin.
- Langium and its `vscode-languageserver`, `vscode-languageserver-protocol` and
  `vscode-jsonrpc` chain move together, at the versions the framework was built
  against, instead of a pin you maintain yourself.

## Install

```bash
npm install @hydranium/langium
```

No peer dependencies: `langium` is a direct, exact dependency of this package.

Still declare `langium` in your own package, at the version this package pins:
the code `langium-cli` generates imports `langium` directly. If your install
resolves a second copy, the framework refuses to start your language server.

## Entry points

| Subpath  | Use it for                    | Runs in         |
| -------- | ----------------------------- | --------------- |
| `.`      | instead of `langium`          | browser-neutral |
| `./lsp`  | instead of `langium/lsp`      | browser-neutral |
| `./node` | instead of `langium/node`     | Node-only       |
| `./test` | instead of `langium/test`     | Node-only       |

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
