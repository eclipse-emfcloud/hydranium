# Host in VS Code

Use this when your language's editors live in a VS Code extension: text
through the LSP head, forms and views through the data head in a webview, and
diagrams through the GLSP head in a custom editor. The order-flow example
splits it over two extensions:
[`vscode`](../../examples/order-flow/vscode/README.md), the editors, and
[`vscode-servers`](../../examples/order-flow/vscode-servers/README.md), which
launches the server. `init --hosts vscode` scaffolds the same two extensions
for your own language, with the language client, a command reading a file
through the data head, and a diagram editor, which
[bookstore's](../../examples/bookstore/host-vscode/README.md) shows as
emitted.

Heads: LSP · data · GLSP

## The seam

Three libraries carry the VS Code side. What runs in the extension host is
imported from `./node`, what runs in a webview from `./browser`:

- `@hydranium/client-vscode`: the language client's content middleware, the
  lookup of a socket head's port and the commands that publish it, all in
  `./node`;
- `@hydranium/data-client-vscode`: the data head's relay from the extension
  host into a webview, and the webview's end of it;
- `@hydranium/glsp-client-vscode`: the diagram, over GLSP's VS Code
  integration and `@hydranium/glsp-client`, whose classes it binds for you.

The LSP head's client is `vscode-languageclient`, with the content
middleware from `@hydranium/client-vscode` in its options. The extension
host holds the sockets, because a webview has none, and forwards each
webview's messages over one `vscode-messenger` hop shared by every head.

## Steps

1. **Launch the server.** Fork the language server with
   `vscode-languageclient` over IPC, with `textDocumentContentMiddleware` as
   its `middleware`, so a document only the server holds opens, and start the
   client. If a Theia app also sideloads the extension, publish each socket
   head's port as a host command with `registerPortCommands`, and keep that
   launch in an extension that contributes nothing else, so Theia does not get
   your custom editors too.
   Register the commands in that extension's activation, not in a launch your
   VS Code extension shares: VS Code throws on a second registration of one
   command id, so with both installed one would fail to activate.

2. **Connect the diagram.** Create a `HydraniumGlspVscodeServer`, with a
   `findPort` that calls `findPort` on your language client and the head's
   port request, and give it to a `HydraniumGlspVscodeConnector` without a
   `messenger` option: the connector's own keeps messages flowing to a hidden
   tab, a save that fails rejects with the documents it could not write, and
   the Problems view keeps the live markers when the user runs Validate.
   Start the server without awaiting it, and report its failure off `onReady`,
   since `start()` resolves either way. Register a subclass of
   `HydraniumGlspEditorProvider` that names the diagram type, the webview
   bundle and a title, under the view type your manifest's
   `contributes.customEditors` declares, with `retainContextWhenHidden`.

3. **Bundle the diagram webview.** Its entry point starts a subclass of
   `HydraniumGlspStarter` whose `createContainer` appends your diagram's
   modules last. Bundle it for the browser with a CSS loader and the codicon
   font inlined, and size the element of class `DIAGRAM_CONTAINER_CLASS` in its
   stylesheet. Never import the diagram module, or a barrel that re-exports it,
   from extension host code: its graph reaches stylesheets, and activation
   dies with `Unexpected token '.'`.

4. **Connect the data head.** For each webview that reads models, call
   `connectDataServer` with the connector's messenger, the webview, and a
   `findPort` for the data head. In the webview, build a `WebviewDataPort`
   over `createWebviewSideChannel`, start the messenger, and give the port to
   a data connection; see [Connect a data client](connect-a-data-client.md).
   When the relay's `onClose` fires, tell the webview, which calls
   `connectionLost` on its port; without that, its pending requests wait
   forever. To read models in the extension host itself, give a data
   connection a `SocketDataPort` from `@hydranium/data-client-vscode/node`
   instead, as the scaffold's Show Model command does.

5. **Check that it worked.** Open a diagram file: it opens in your custom
   editor and shows the diagram. A wrong port request shows your `onReady`
   error once the lookup gives up. The example's `test:host` opens a diagram
   file in a downloaded VS Code and compares the editor's view type with the
   constant, which catches a manifest that no longer matches the code.

## Things to know

- **The extension needs a Node extension host.** The heads are reached over
  sockets and the server is forked, so it cannot run as a web extension.
- **A webview's Content-Security-Policy grants no `eval`.** The editor's
  document allows what sprotty needs, inline styles and a data-URL font, and
  nothing more; a bundle that needs `eval` fails in the webview's own console.
