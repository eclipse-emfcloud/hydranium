# Third-party notices

Hydranium is distributed under the MIT License; see [`LICENSE`](./LICENSE).
This file records the third-party notices that other licences in the dependency
tree require us to carry, and the one local patch we apply at install time.

It covers what a consumer is **forced to install** — the transitive closure of
the published packages' `dependencies`. Peer dependencies (Theia, GLSP and the
Eclipse ecosystem beneath them) are installed by the consuming application,
which carries its own notices for them; a short summary is at the end for
orientation only.

## Runtime dependency licences

The hard runtime closure is 51 packages: 41 MIT, 6 Apache-2.0, 3 ISC, 1
BSD-3-Clause. It contains **no** GPL, AGPL, LGPL, SSPL or BUSL code.

### Apache-2.0

The Chevrotain parser toolkit, reached through Langium:

- `chevrotain`
- `@chevrotain/regexp-to-ast`
- `@chevrotain/cst-dts-gen`
- `@chevrotain/gast`
- `@chevrotain/types`
- `@chevrotain/utils`

These packages are licensed under the Apache License, Version 2.0, available at
http://www.apache.org/licenses/LICENSE-2.0. Each ships its own copy of the
licence text, which npm installs alongside it.

Apache-2.0 §4(d) requires redistributing the contents of a `NOTICE` file **if
the licensed work provides one**. Checked against the installed packages: they
ship the Apache-2.0 text with no filled-in copyright line and no `NOTICE` file,
so there is no notice text to propagate and this section is the disclosure.

### BSD-3-Clause

- `diff` — Copyright (c) 2009-2015, Kevin Decker &lt;kpdecker@gmail.com&gt;.
  Redistribution in binary form must reproduce the copyright notice, this list
  of conditions and the disclaimer; neither the name of the author nor the names
  of contributors may be used to endorse products derived from this software
  without specific prior written permission.

### MIT and ISC

The remaining 44 packages are MIT or ISC. Both require the copyright notice and
permission notice to accompany the software, which npm satisfies by installing
each package with its own `LICENSE` file. Notable direct dependencies:
`langium`, `vscode-jsonrpc`, `vscode-languageserver`,
`vscode-languageserver-protocol`, `vscode-uri`, `commander`, `@clack/prompts`,
`ts-morph`, `uuid`, `fast-json-patch`.

## Patched dependency

`patches/vscode-jsonrpc+9.0.1.patch` is applied to `vscode-jsonrpc@9.0.1` at
install time via `patch-package`, wired to the root `postinstall` script.

`vscode-jsonrpc` is MIT-licensed, Copyright (c) Microsoft Corporation. The
patch is **additive and changes no runtime logic**: it restores the `main` and
`typings` fields that 9.x dropped in favour of an exports-only map, adds four
one-line re-export shims (`node.js`, `node.d.ts`, `browser.js`, `browser.d.ts`,
each carrying Microsoft's own header verbatim), and adds a `default` export
condition beside the existing `node` and `browser` conditions. Together these
let consumers on classic `moduleResolution: "Node"` — the Theia client packages,
and Theia itself — keep resolving the package.

The patch applies only to a local `node_modules` tree. It is not redistributed:
no published Hydranium package contains patched Microsoft code.

## Assets

- `@vscode/codicons` is licensed **CC-BY-4.0**, under which attribution is a
  condition rather than a courtesy. Icons are Copyright (c) Microsoft
  Corporation, licensed under the Creative Commons Attribution 4.0
  International Public License. It is reached through the Theia peer stack, so
  an application that renders those icons carries this attribution too.

## Peer dependencies, for orientation

Not installed by Hydranium, and listed only so the licence picture is complete.
Adding peers grows the closure to roughly 699 packages and is where every
copyleft licence enters:

- **Theia** (`@theia/*`) and **GLSP** (`@eclipse-glsp/*`, `sprotty`) are
  dual-licensed `EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0`. The
  EPL-2.0 option applies here.
- `jschardet` is LGPL-2.1+ and `lightningcss` is MPL-2.0, both reached through
  Theia and both consumed unmodified as separately installed packages.
- `dompurify` is `MPL-2.0 OR Apache-2.0`; the Apache-2.0 option applies.
- `font-awesome` is `OFL-1.1 AND MIT`; the OFL requires the font retain its own
  notice.

Four peer-reachable packages (`fuzzy`, `xmlhttprequest-ssl`, `busboy`,
`streamsearch`) declare no `license` field in their published metadata. They are
reached only through Theia and are recorded here as a known gap in this
inventory rather than as a resolved question.
