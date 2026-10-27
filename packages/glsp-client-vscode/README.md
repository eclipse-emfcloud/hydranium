# `@hydranium/glsp-client-vscode`

The GLSP head's client side in a VS Code extension built on
[Hydranium](https://github.com/eclipse-emfcloud/hydranium). Install it when
your extension opens a diagram in a custom editor: it connects GLSP's VS Code
integration to the head's socket and hosts the diagram in a webview with the
framework's client classes.

## What it gives you

- GLSP's VS Code server over the head's socket, with the port looked up when
  the server starts rather than during activation.
- A custom editor whose webview document carries a Content-Security-Policy
  that grants sprotty what it needs and no `eval`, and the element the diagram
  mounts into.
- GLSP's connector, with each save settled by the server's answer to it: a
  save that fails rejects with the documents it could not write and why, and
  shows them, rather than settling as saved on a later save that succeeds.
  Its Problems view shows the markers of every reason, as the diagram does,
  so Validate keeps the live ones.
- A webview starter that adds `@hydranium/glsp-client`'s classes to the
  diagram container, after GLSP's VS Code modules and before your diagram's.

## Install

```bash
npm install @hydranium/glsp-client-vscode
```

| Peer                                       | Range         |
| ------------------------------------------ | ------------- |
| `@eclipse-glsp/client`                     | `^2.6.0`      |
| `@eclipse-glsp/vscode-integration`         | `^2.6.0`      |
| `@eclipse-glsp/vscode-integration-webview` | `^2.6.0`      |
| `@hydranium/glsp-client`                   | `^1.0.0-next` |
| `@hydranium/protocol`                      | `^1.0.0-next` |
| `inversify`                                | `^6.0.0`      |
| `vscode-jsonrpc`                           | `^9.0.0`      |

## Wiring

In the extension host, give a `HydraniumGlspVscodeConnector` the server,
start it without awaiting it, report a failure off `onReady`, and register
your editor, a subclass naming the diagram type, the webview bundle and a
title. `findPort` is your lookup of the head's port, such as `findPort` from
`@hydranium/client-vscode/node` on your language client:

<!-- snippet-preamble
declare function findGlspPort(): Promise<number>;
-->

```ts
import { HydraniumGlspEditorProvider, HydraniumGlspVscodeConnector, HydraniumGlspVscodeServer } from '@hydranium/glsp-client-vscode/node';
import { ConsoleLogger } from '@hydranium/protocol';
import { window, type ExtensionContext } from 'vscode';

class MyDiagramEditorProvider extends HydraniumGlspEditorProvider {
   override diagramType = 'my-diagram';
   protected override readonly scriptPath = 'out/webview/diagram.js';
   protected override readonly stylePath = 'out/webview/diagram.css';
   protected override readonly title = 'My Diagram';
}

export function activate(context: ExtensionContext): void {
   const server = new HydraniumGlspVscodeServer({
      clientId: 'my-language-glsp',
      clientName: 'My Language',
      findPort: findGlspPort,
      logger: new ConsoleLogger()
   });
   const connector = new HydraniumGlspVscodeConnector({ server });
   context.subscriptions.push(server, connector);
   void server.start();
   server.onReady.catch((error: unknown) => window.showErrorMessage(`Diagram unavailable: ${String(error)}`));
   context.subscriptions.push(
      window.registerCustomEditorProvider('myLanguage.diagram', new MyDiagramEditorProvider(connector, context.extensionUri), {
         webviewOptions: { retainContextWhenHidden: true }
      })
   );
}
```

The webview may load from the script's directory and the stylesheet's. The
diagram mounts into an element of class `DIAGRAM_CONTAINER_CLASS`, from the
package root, which your webview stylesheet sizes. In the webview bundle,
start the diagram with a `HydraniumGlspStarter` whose container appends your
diagram's own container module last:

<!-- snippet-preamble
import type { ContainerModule } from 'inversify';
declare const myDiagramModule: ContainerModule;
-->

```ts
import { initializeDiagramContainer, type ContainerConfiguration } from '@eclipse-glsp/client';
import { HydraniumGlspStarter } from '@hydranium/glsp-client-vscode/browser';
import { Container } from 'inversify';

class MyDiagramStarter extends HydraniumGlspStarter {
   createContainer(...containerConfiguration: ContainerConfiguration): Container {
      // `myDiagramModule` is yours: the model and view registrations of your diagram.
      return initializeDiagramContainer(new Container(), ...containerConfiguration, myDiagramModule);
   }
}
new MyDiagramStarter();
```

The extension host's tier never reaches `@eclipse-glsp/client`, whose
stylesheets Node cannot load. Keep your own extension host code off your
diagram module for the same reason.

For the whole setup, see *Host in VS Code* in
[Adopting Hydranium](https://github.com/eclipse-emfcloud/hydranium/blob/main/docs/ADOPTING.md).

## Entry points

| Subpath     | Use it for                                                     | Runs in                    |
| ----------- | -------------------------------------------------------------- | -------------------------- |
| `.`         | The class name both tiers share                                | anywhere                   |
| `./node`    | The GLSP server, the connector and the diagram's custom editor | the VS Code extension host |
| `./browser` | The diagram webview's starter                                  | a webview                  |

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
