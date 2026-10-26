# `@hydranium/cli`

The `hydranium-cli` binary of the
[Hydranium](https://github.com/eclipse-emfcloud/hydranium) framework. You
install it when you build a Hydranium language: `init` scaffolds the project,
and the other commands drive your built head from a shell or a CI step.

## What it gives you

- Scaffold a buildable language project with one `init` command, or answer a
  wizard that echoes the command it composed.
- Fail a CI step on a diagnostic or a grammar-convention violation, with no
  editor running.
- Dump your grammar's reflection, or write a Markdown model reference for your
  own docs.
- Generate the serializable transfer model from Langium's generated AST.
- Measure model-store memory and analyze a V8 heap snapshot.
- List, read, create, save and watch documents through a spawned data server,
  printing JSON a script can pipe, and delete them.

## Install

`init` needs no install:

```bash
npx @hydranium/cli init ./my-lang --name MyLang
```

For the commands you run repeatedly, add it to the project it inspects, or
install it globally:

```bash
npm install --save-dev @hydranium/cli
npm install --global @hydranium/cli
```

| Peer                     | Range         |
| ------------------------ | ------------- |
| `@hydranium/core`        | `^1.0.0-next` |
| `@hydranium/data-server` | `^1.0.0-next` |
| `@hydranium/langium`     | `^1.0.0-next` |
| `@hydranium/protocol`    | `^1.0.0-next` |
| `@memlab/core`           | `^2.0.3`      |
| `@memlab/heap-analysis`  | `^2.0.3`      |
| `vscode-jsonrpc`         | `^9.0.0`      |

The two memlab packages are optional peers that only `analyze-heap` loads:
install them with `npm install @memlab/core @memlab/heap-analysis` before its
first run.

## Commands

`hydranium-cli --help` lists the commands, and `hydranium-cli <command> --help`
lists each command's flags.

- **Scaffolding.** `init` writes a project you can build right away: a server
  package, a protocol package its clients share, a client package with a
  diagram, a browser page around the heads with `--hosts browser`, VS Code
  extensions with `--hosts vscode`, a Theia extension with a browser
  application with `--hosts theia-browser` or an Electron one with
  `--hosts theia-electron`, and a starter workspace.
- **Grammar and workspace.** Boot your built head to reflect its grammar, lint
  it, write a model reference, validate a workspace, or count its AST nodes.
- **Codegen.** `generate-transfer-model` turns the AST into a transfer model,
  once or on watch, and can also write each grammar's language id and
  extensions for a package your clients share without Langium, and a
  `transferNode` builder for your tests.
- **Memory.** Measure a workspace's model-store memory, and analyze a heap
  snapshot.
- **Data server.** Spawn your data head and list projects, or query, create,
  save, delete or watch a document.

The commands that boot your head take `--services <module>`. That is an ESM
module exporting a zero-arg `createServices()` that returns `{ shared }`; in a
scaffolded project, that is `./server/lib/node/services.js` from the project
root. To run the head from its TypeScript source instead, register a loader
with `--import`:
`npx hydranium-cli reflect --import tsx --services ./server/src/node/services.ts`.

The data-server commands take `--server "<cmd> [args...]"`. Point it at the
data head's stdio entry, `server/lib/data-server-main.js` in a scaffolded
project, not at the editor entry `server/lib/main.js`, whose stdio carries LSP.
Pass the workspace as the entry's argument rather than through `--cwd`:

```bash
hydranium-cli projects --server "node ./server/lib/data-server-main.js ./workspace"
```

`create`, `save` and `delete` spawn a data server of their own, and a
workspace has one writer. Writing in a workspace an editor has open makes two
writers, and one write is lost: an editor that holds a deleted file can save it
back.

`generate-transfer-model` emits a constant under each type's name, as Langium
does for the AST. If the module that re-exports the generated model narrows an
interface, its declaration hides the generated constant of the same name, so
re-export that constant beside it. The generated `<LanguageId>TransferTypes`
map still names the generated interface, so declare the map under its own
name too, and `transferNode` builds the narrowed type. That reaches only the
type's own entry: a property or a union that holds the type, here a
`Declaration`, still names the generated interface.

```ts
import * as generated from './generated-hydranium/transfer-model.js';
export * from './generated-hydranium/transfer-model.js';
export interface Entity extends generated.Entity {
   name: `${string}Entity`;
}
export const Entity = generated.Entity;
export type OrderFlowTransferTypes = Omit<generated.OrderFlowTransferTypes, 'Entity'> & { Entity: Entity };
```

Commands that spawn a child give it a heap ceiling; set
`HYDRANIUM_CLI_MAX_OLD_SPACE_MB` to state your own in MiB.

## Entry points

| Subpath          | Use it for                                                                   | Runs in |
| ---------------- | ---------------------------------------------------------------------------- | ------- |
| `hydranium-cli`  | The binary (`bin`).                                                          | Node    |
| `.`              | Spawn a data server and get a typed proxy; run the codegen as a function.    | Node    |
| `./lib/cli.js`   | Resolve the binary's file by specifier, to spawn it from a script or a test. | Node    |

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
