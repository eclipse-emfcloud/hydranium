# Host in Theia

Use this when your language's editors live in a Theia application: text
through the LSP head, forms and views through the data head, and diagrams
through the GLSP head. The order-flow example splits it over three packages:
[`theia`](../../examples/order-flow/theia/README.md), the Theia extension,
[`theia-app`](../../examples/order-flow/theia-app/README.md), the application
that loads it, and
[`vscode-servers`](../../examples/order-flow/vscode-servers/README.md), which
launches the server.

Heads: LSP · data · GLSP

## The seam

Three libraries carry the Theia side, and none of them is a Theia extension on
its own: your extension declares the `theiaExtensions` entries and binds from
them.

- `@hydranium/client-theia`: what every head shares, such as the output-channel
  logger, the editor's save handling, and the backend's socket bridge;
- `@hydranium/data-client-theia`: the data head's connection;
- `@hydranium/glsp-client-theia`: the diagram.

Each head gets a frontend module and a backend module. The backend forwards
the frontend's channel to the head's socket on the server, so the server runs
outside Theia's backend and announces its ports.

## Steps

1. **Launch the server.** In the example, a small VS Code extension, sideloaded
   through `@theia/plugin-ext`, forks the language server over IPC and
   publishes each socket head's port as a command, such as
   `order-flow.port.glsp`. It contributes nothing else: hosting your full VS
   Code extension in Theia as well would register its custom editors, and every
   diagram file would get two _Open With_ entries.

2. **Bind the shared pieces in a frontend module.** Call `bindChannelLogger`,
   so the frontend's log lines land beside the server's, and
   `bindLogLevelPreference`. Call `bindEditorDiskSync` as soon as any head can
   save a file an editor has open: without it, Theia keeps the editor dirty
   after the server saves, and the editor's next save applies its edits a
   second time.

3. **Connect the data head.** In the frontend, subclass `ChannelDataPort` with
   your service path, bind it as a singleton, and bind the connection over it
   with `bindDataConnection`. In the backend, export
   `createDataServerConnectionContainerModule(MyHandler)`, where `MyHandler`
   extends `DataServerConnectionHandler` and names the port command. Every part
   of your UI then takes its own session on that one connection; see
   [Connect a data client](connect-a-data-client.md). A second channel on the
   same service path is refused without an error, and the second consumer
   waits forever.

4. **Mount the diagram.** In the frontend, subclass
   `AbstractHydraniumGlspTheiaFrontendModule` and declare its
   `diagramLanguage`, `diagramConfiguration` and `diagramManager`. Return a
   subclass of `HydraniumGlspClientContribution` from its
   `bindClientContribution()`: it waits for a workspace before it starts the
   client, and starts a new one after a lost connection. In the backend, extend
   `GlspServerConnectionHandler`. When the LSP head already
   reports the same problems, set `propagateMarkersToProblemsView` to `false`
   in your diagram configuration, so the Problems view lists them once.

5. **Check the port command names with a test.** When a backend names a port
   command nobody registered, it keeps asking for the port forever, with no
   error. The example's `test/order-flow-host-port-commands.test.ts` checks the
   names against the server's own.

## Unsaved diagrams and reloads

A diagram keeps its unsaved changes across a reload or a reconnect of its
window, as long as the server is still the same one. The diagram comes back
under the same client id, with a resume token the window keeps, and takes its
old session over. That works when the server outlives the page, as one server
for all windows or a standalone socket server does. A server the plugin host
starts, as in the example, is a new process after a reload, because Theia
starts a new plugin host for every page load; there, only a reconnect within
Theia's `frontendConnectionTimeout` keeps the server and the unsaved text.

The window's id and token come from `WindowSessionService`, which keeps them in
`sessionStorage`: a reload resumes, and a duplicated tab starts afresh. Rebind
it if your application has its own notion of a window.

## Things to know

- **Theia themes do not colour semantic tokens**, so the server's semantic
  highlighting shows in VS Code but not in Theia; see
  [Status and limitations](../adopting/status.md#semantic-tokens-add-no-colour-in-theia).
- **A diagram whose identifier is still in use does not open**; see
  [Troubleshooting](../adopting/troubleshooting.md#a-diagram-does-not-open-saying-its-identifier-is-in-use).
