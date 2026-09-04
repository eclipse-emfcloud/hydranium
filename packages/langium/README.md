# `@hydranium/langium`

The pinned [Langium](https://langium.org/) re-export for the
[Hydranium](https://github.com/eclipse-emfcloud/hydranium) framework — the single chokepoint every
`@hydranium/*` package, and every adopter of them, imports Langium through.

You do not install this for its own API: it is almost entirely passthrough. You install it because a
framework package will resolve it anyway, and because importing Langium through it is how your
project stays in lockstep with the version the framework was built against.

## Why this package exists

Langium is pinned to **one exact version** here, to guarantee a **single physical copy** across the
workspace. Re-export is transparent — given one physical install, importing `AstNode` or `URI` from
`@hydranium/langium` and from `langium` yields the same class object and the same declaration. That
transparency is exactly what a split install destroys: two copies of Langium mean two `AstNode`
declarations and two `URI` classes, so `instanceof` and every nominal identity check across them
silently start returning `false`. Without the pin, single-copy is only a semver-dedup coincidence,
one minor bump away from breaking.

For an **adopter**, the reason to route imports here is not runtime identity (that already holds) —
it is **version coupling**. Langium sits in an atomic chain with `vscode-languageserver`,
`vscode-languageserver-protocol` and `vscode-jsonrpc`, with no independently movable link. An
adopter importing `langium` directly owns that pin itself and can drift out of lockstep with the
framework it composes; importing it from here means the framework owns it.

The chokepoint is **lint-enforced**, not merely conventional: an ESLint
`no-restricted-imports` rule over `packages/**` and `examples/**` rejects direct imports of
`langium`, `langium/lsp`, `langium/node`, `langium/test` and `vscode-uri` (whose `URI` Langium
re-exports and owns the version of). This package itself is exempt, as is any `generated` directory —
`langium-cli` emits direct imports there and rewrites them on every build, which is also why
`langium` stays a declared dependency of an adopter's own package.

## What it gives you

- Langium's full API surface, re-exported: `AstNode`, `AstUtils`, `URI`, `UriUtils`, the service
  types, the DI helpers — everything, unfiltered.
- A subpath per upstream subpath, so `langium/lsp`, `langium/node` and `langium/test` each have a
  chokepoint mirror.
- One ambient type augmentation: `AstNode.$synthetic`, a marker for a node that was programmatically
  constructed rather than parsed. Type-level only — the behaviour that reads it lives in
  `@hydranium/core`.
- Two additions to the `UriUtils` namespace, so framework URI helpers sit beside Langium's own:
  `UriUtils.toUri` (normalise a `URI | string`) and `UriUtils.isAncestorOrEqual` (a scheme- and
  authority-aware containment check, unlike `UriUtils.contains`).

## Install

```bash
npm install @hydranium/langium
```

No peer dependencies: `langium` is a direct, exact dependency of this package.

## Subpaths

| Subpath  | Re-exports     | Contents                                  |
| -------- | -------------- | ----------------------------------------- |
| `.`      | `langium`      | Core API + the framework's augmentations. |
| `./lsp`  | `langium/lsp`  | LSP service defaults.                     |
| `./node` | `langium/node` | `NodeFileSystem`.                         |
| `./test` | `langium/test` | Parsing / validation test helpers.        |

Each named subpath also resolves as `@hydranium/langium/lib/<name>`, so a consumer on classic
`moduleResolution: "Node"` can reach it.

## Usage

Replace `langium` with `@hydranium/langium` in your import specifiers; nothing else changes, because
the symbols are the same objects.

The one thing to know is that the root entry is **side-effecting**: importing anything from
`@hydranium/langium` loads the `UriUtils` augmentation, which mutates the runtime `UriUtils` object.
That is why the added helpers are visible process-wide once any framework package has loaded — and
why code that imports `UriUtils` from `langium` without ever loading the framework correctly sees
only the stock surface.

## Status

Alpha — pre-v0, not yet published. The API is Langium's and is stable to the extent Langium's is;
what is not yet settled is the augmentation set and the pinned version. See the
[repository README](../../README.md) for the current status and known limitations.

## License

`MIT` — see this package's [`LICENSE`](./LICENSE), and the repository
[`NOTICE.md`](../../NOTICE.md) for third-party notices.
