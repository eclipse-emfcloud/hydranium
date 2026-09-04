# Requirements for a consuming project

What your own project has to satisfy before `@hydranium/*` will install and
compile. Three requirements, and the second is the one that surprises people.

## Node 22.13 or newer

The published packages declare that floor in `engines.node`. It is not a
preference: the compiled CommonJS in the Theia client packages `require()`s the
ESM heads across a published package boundary, which Node supports unflagged
only from 22.13.

## One physical copy of Langium, and of the wire stack under it

Hydranium re-exports Langium's types through a single chokepoint package, and
identity-sensitive checks — `instanceof` on an AST node, on a `URI` — break
silently when two copies are installed. Nothing throws; the checks just answer
`false`.

The version is therefore pinned exactly, and so is everything beneath it. Treat
these four as **one atomic chain with no independently movable link**:

```text
langium 4.3.1
  → vscode-languageserver ~10.0.1
    → vscode-languageserver-protocol ~3.18.1
      → vscode-jsonrpc 9.0.1
```

Bumping one link alone reintroduces the split. So does downgrading
`vscode-jsonrpc` to `8.x`, which the declared peer range `^8.0.0 || ^9.0.0`
still permits — see the section below for why that is not an option.

Pins and patches take effect only on a **from-scratch install**. Deleting the
lockfile alone leaves stale nested copies behind:

```bash
rm -rf node_modules package-lock.json
npm install
```

## A resolver that reads `exports`

Every head package declares `vscode-jsonrpc` as a peer dependency, and the
version is not really yours to choose: `langium@4.3.1` depends on
`vscode-languageserver-protocol@~3.18.1`, which depends on `vscode-jsonrpc` at
the **exact** version `9.0.1`. Installing the framework installs that copy.

`vscode-jsonrpc@9.0.1` ships an `exports` map and no `main` or `typings` field.
A project compiled under classic `moduleResolution: "Node"` (node10) ignores
`exports` and resolves physically, so it cannot see the package at all and fails
with `TS2307: Cannot find module 'vscode-jsonrpc'` — before reaching any
Hydranium code. The subpaths do not rescue it: `9.0.1` publishes no `node.js` or
`browser.js` at the package root either, so `vscode-jsonrpc/node` fails the same
way.

**The framework does not repair this for you, and cannot.** This repository
repairs its own `node_modules` with a `patch-package` patch
(`patches/vscode-jsonrpc+9.0.1.patch`, described in
[`NOTICE.md`](../../NOTICE.md)), applied by a root `postinstall`. A patch to a
local install tree is not redistributable: no published `@hydranium/*` tarball
contains it, none of them declares a `postinstall`, and the patch file is in no
package's `files` list. Installing from npm gets you the unpatched dependency.

So a consuming project needs one of these, and the first is the supported path:

- **Compile with a resolver that reads `exports`** — `moduleResolution` set to
  `"Bundler"`, `"Node16"` or `"NodeNext"`. Nothing else is required, and every
  `@hydranium/*` subpath is declared for both resolvers regardless.
- **Apply the same patch in your own tree** — copy the patch file out of this
  repository and wire `patch-package` into your own `postinstall`. It is
  additive and changes no runtime logic; [`NOTICE.md`](../../NOTICE.md) lists
  exactly what it modifies.

### Why `vscode-jsonrpc@8` is not a third option

The Langium chain above pins `9.0.1` exactly, so an `8.x` install produces two
physical copies in one process, and this wire stack breaks on copy identity
rather than on structure — a request type built by one copy and sent over a
connection owned by the other throws `Unknown parameter structure auto`.

### Pinning it in your own root manifest

The published packages declare peer *ranges*, not overrides, and a graph that
satisfies every range can still contain two copies. If yours does, pin the
chain yourself:

```json
{
   "overrides": {
      "langium": "4.3.1",
      "vscode-languageserver-protocol": "3.18.2",
      "vscode-jsonrpc": "9.0.1"
   }
}
```

Then reinstall from scratch, as above. The `//overrides` note in this
repository's root `package.json` records the full chain and why each entry is
there.

## Related

- [Status, limitations and roadmap](status.md) — what the exact pin costs you,
  alongside the other known limitations.
- [Troubleshooting a server you are building](troubleshooting.md) — the two
  symptoms a duplicated copy actually produces.
