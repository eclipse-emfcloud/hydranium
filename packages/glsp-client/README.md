# `@hydranium/glsp-client`

The host-neutral client classes for the
[Hydranium](https://github.com/eclipse-emfcloud/hydranium) GLSP head, the
companion of `@hydranium/glsp-server`. Install it to mount a Hydranium diagram
in any GLSP host: a Theia frontend through `@hydranium/glsp-client-theia`, a
VS Code webview, or a plain browser page. It builds on `@eclipse-glsp/client`.

## What it gives you

- Load failures reported through your logger and, unless the action
  dispatcher itself failed, on the diagram's status overlay, instead of
  vanishing as an uncaught rejection.
- Action traffic and bounds measurements in your log, so a slow diagram names
  its cost.
- Edge routes repaired before they go to the server while sprotty has not
  measured the obstacles yet.
- sprotty's own errors, such as an element type with no view, in your log
  rather than dropped.
- An edge whose labels keep finite bounds without bendpoints, so fit to
  screen frames the diagram instead of blanking it.
- A plain click on an unselected element that replaces a selection still
  pending, so two quick clicks on different elements leave only the second
  selected.
- One binder that mounts all of it in a diagram container.
- For a plain page, one call that builds the container, loads the model and
  supplies what a shell would: framing, canvas bounds that follow the
  element's size and position, touch input, and a context menu GLSP stops
  warning about.

## Install

```bash
npm install @hydranium/glsp-client
```

| Peer                   | Range         |
| ---------------------- | ------------- |
| `@eclipse-glsp/client` | `^2.6.0`      |
| `@hydranium/protocol`  | `^1.0.0-next` |
| `inversify`            | `^6.0.0`      |
| `snabbdom`             | `^3.5.1`      |

## Wiring

Call `createGlspClientModule` from a container module your host adds after
GLSP's default modules, since it replaces tokens those modules bind:

<!-- snippet-preamble
import type { Logger } from '@hydranium/protocol';
declare const logger: Logger;
-->

```ts
import { createGlspClientModule } from '@hydranium/glsp-client';
import { ContainerModule } from 'inversify';

const hostModule = new ContainerModule((bind, unbind, isBound, rebind) => {
   createGlspClientModule({ bind, unbind, isBound, rebind }, { logger });
});
```

Pass your `Logger` from `@hydranium/protocol`, which replaces any binding on
`HydraniumClientTypes.Logger`, or bind that token yourself and pass none; with
neither, a `ConsoleLogger` is bound.
Bind `HydraniumClientTypes.Clock` to drive time in a test. To render the load
failure in the user's language, subclass `HydraniumDiagramLoader`, override
`loadFailureLabel` and rebind `DiagramLoader` after the call. In Theia, call
`createGlspClientTheiaModule` from `@hydranium/glsp-client-theia` instead,
which does all of this with the Output channel.

In your diagram module, call `configureHydraniumModelElements` in place of
GLSP's `configureDefaultModelElements`, and register your own edge types with
`HydraniumGEdge` in place of `GEdge`: GLSP's edge gives a label on an edge
without bendpoints `NaN` bounds, and a fit to screen over such a label blanks
the canvas. The class is fixed per registered type, so a type registered with
`GEdge` keeps the defect.

In a plain page, call `mountGlspDiagram` instead of building the container
yourself. It takes the element, your `HydraniumGlspClient` over the head's
connection, and your diagram module's initializer in GLSP's own shape, and it
calls `createGlspClientModule` for you:

<!-- snippet-preamble
import type { GlspDiagramMountOptions } from '@hydranium/glsp-client';
import type { Logger } from '@hydranium/protocol';
import type { MessageConnection } from 'vscode-jsonrpc';
declare const connection: MessageConnection;
declare const logger: Logger;
declare const initializeMyDiagramContainer: GlspDiagramMountOptions['initializeDiagramContainer'];
-->

```ts
import { glspConnection, HydraniumGlspClient, mountGlspDiagram } from '@hydranium/glsp-client';

const glspClient = new HydraniumGlspClient({ id: 'my-app', connectionProvider: glspConnection(connection) });
const diagram = await mountGlspDiagram({
   mount: document.getElementById('my-diagram')!,
   diagramType: 'my-diagram',
   sourceUri: 'file:///workspace/my.model',
   glspClient,
   initializeDiagramContainer: initializeMyDiagramContainer,
   logger
});
```

Wrap the connection with `glspConnection`: GLSP's client sends message types
built by its own copy of `vscode-jsonrpc`, which another copy rejects, and
`glspConnection` sends them by method name through `sendByMethodName` from
`@hydranium/protocol`, typed as the connection GLSP's client takes.
One client serves every diagram on the page, each mounted as its own session.
The element's `id` is the diagram's `clientId`, so it needs one; give it a
height, `position: relative` so the palette stays on it, `touch-action: none`
for touch, and size its `<svg>` to it, or sprotty draws into 300×150. The
first render replaces the element with sprotty's own under the same id, so
keep no reference to it and find it by id when you need it. A failed load
resolves the mount; read `diagram.loadOutcome` to report it, since the status
overlay cannot show a failure of the action dispatcher itself. A page that
asks before a reload also reads `diagram.editsInFlight`, the edits the server
has not answered yet, which no dirty state shows, and a save or a file
switch awaits `diagram.whenEditsSettled()` so it does not run ahead of one,
and stops when it resolves `false`, its bound passed with one unanswered.
A host that calls `createGlspClientModule` itself counts them only when it
passes `trackEditsInFlight: true`, and reads them from
`HydraniumGlspActionDispatcher`.

For a browser page, see *Host in a browser* in
[Adopting Hydranium](https://github.com/eclipse-emfcloud/hydranium/blob/main/docs/ADOPTING.md).

## Entry points

| Subpath      | Use it for                                                | Runs in         |
| ------------ | --------------------------------------------------------- | --------------- |
| `.`          | The classes, the binder, the DI tokens and the page mount | browser         |
| `./messages` | The codes of the messages this package raises             | browser-neutral |
| `./testing`  | A binding recorder for testing your modules               | browser-neutral |

The root loads `@eclipse-glsp/client`, whose graph imports stylesheets, so
your bundler needs a CSS loader. The subpaths need a TypeScript
`moduleResolution` that reads `exports` (`NodeNext` or `Bundler`); see
*Requirements* in
[Adopting Hydranium](https://github.com/eclipse-emfcloud/hydranium/blob/main/docs/ADOPTING.md).

## Status

Alpha: every release is a prerelease that may break the API, so pin an exact
version. Guides and known limitations:
[Adopting Hydranium](https://github.com/eclipse-emfcloud/hydranium/blob/main/docs/ADOPTING.md).

## License

`MIT` — see this package's [`LICENSE`](./LICENSE), and the repository
[`NOTICE.md`](https://github.com/eclipse-emfcloud/hydranium/blob/main/NOTICE.md)
for third-party notices.
