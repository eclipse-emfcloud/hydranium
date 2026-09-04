# `@hydranium/example-order-flow-client`

The **host-agnostic** half of the order-flow web client. Nothing here imports a
host package, so one diagram implementation is mounted by every shell:

```
order-flow-client        diagram definition + the properties model
      | over @hydranium/protocol/client (port, session, events,
      |      both halves of the post-message hop)
      | adapter
Theia   -> @hydranium/glsp-client-theia / data-client-theia / client-theia
VS Code -> @eclipse-glsp/vscode-integration, plus a hand-rolled data hop
Browser -> MessagePorts to heads in a web worker, no host framework
      |
order-flow-theia / order-flow-vscode / order-flow-browser   thin shells
```

Three shells mount this package — `order-flow-theia`, `order-flow-vscode` and
`order-flow-browser` — which is the claim the split exists to make. Theia and
VS Code mount both halves, the diagram definition and the properties form,
verbatim; the browser shell mounts the diagram half — the module, the type ids
and the stylesheet — which is what shows the definition surviving a host with no
extension model and no widget framework under it.

The two heads reach their transport differently, and only one of them needs a
port. The **diagram** binds nothing transport-related: a GLSP diagram's
transport is GLSP's own `GLSPClient`, and
`IDiagramOptions.glspClientProvider` is a required field every shell already
supplies where it composes the container — the Theia and VS Code integrations
through `containerConfiguration`, the browser page directly. The **data head** does need
one, because in a VS Code webview there is no way to reach the extension host's
connection — so the port abstracts the transport hop, not merely the protocol.

This split is a requirement, not an implementation detail. `glsp-client-theia`
is not a diagram — it is the Theia *mounting* of one. Folding the diagram
definition into a Theia extension is the cheap path and it would leave the
framework's client tier with no adopter coverage, as well as making diagrams
look Theia-only.

## What is here

- `src/diagram/order-flow-process-diagram-types.ts` — the client half of the
  `.process` contract: diagram type, element type ids, file extension. Kept off
  `@eclipse-glsp/client` (it uses `@eclipse-glsp/protocol`) so the contract test
  runs headless.
- `src/diagram/order-flow-process-diagram-module.ts` — the diagram definition:
  GLSP's default model elements plus one model/view registration per element
  type the server stamps, and `initializeOrderFlowProcessDiagramContainer` for a
  host to compose its own modules into.
- `src/data/order-flow-properties-model.ts` — `OrderFlowPropertiesModel`, a
  document-scoped properties panel minus the drawing. It belongs here rather
  than in the framework because it carries a **policy**: which fields are
  editable.
- `src/properties/properties-form.ts` — `PropertiesForm`, the drawing half:
  plain DOM over the model's `fields`, mounted unchanged by the Theia widget
  and the VS Code webview alike. It is the only file here that touches the DOM.
- `src/data/order-flow-messenger-channel.ts` — the VS Code adapter, presenting
  a `vscode-messenger` `Messenger` as a `PostMessageChannel` so the data head
  rides the same hop the diagram already uses. Hand-rolled here because the
  framework ships Theia client packages and no VS Code equivalents, so a VS Code
  host has to supply this adapter itself.

Everything it stands on that is host-neutral and grammar-free lives in
**`@hydranium/protocol/client`**: `DataPort` (the seam a host fills in),
`DataSession` (typed proxy, readiness gate, open/watch ordering, echo
recognition, reconnect), `DataEvents` (the inbound `DataClientProtocol` fanned
out) and the two halves of the structured-clone hop,
`createPostMessageTransport` and `relayToPostMessageChannel`.

The tool palette is not defined here: GLSP drives it from the server's
`shapeTypeHints` / `edgeTypeHints`, so the palette and the operation handlers
behind it live in `order-flow-server`.

## The client tier it stands on

`@hydranium/protocol/client` supplies the transport seam and everything above
it, so this package re-derives none of it. In short:

- **`DataPort`** — what a host implements: `connect()`, `clientId`,
  `reportError`, `onDispose`. It abstracts the transport *hop*, not the
  protocol, because a VS Code webview cannot reach the extension host's
  connection.
- **`DataSession`** — the readiness gate, the open-then-watch order, echo
  recognition, and the reconnect policy. `connected()` hands back the ready
  proxy rather than `void`, so a cached proxy cannot outlive its connection.
- **`DataEvents`** — the inbound `DataClientProtocol` fanned out, since a
  connection binds exactly one and a host usually has several listeners.
- **`createPostMessageTransport`** — a `MessageReader` / `MessageWriter` pair
  over a structured-clone-only pipe, for a webview. It deliberately does not
  build the `MessageConnection`: that needs a vscode-jsonrpc runtime
  abstraction layer only `/node` and `/browser` install, and only the host
  knows its side.
- **`relayToPostMessageChannel`** — the other end of that hop, for the side
  that does hold a socket. It pumps whole JSON-RPC messages between a framed
  transport and the same channel shape, decoding neither, and buffers what
  arrives while the socket is still opening — a `DataSession`'s readiness
  handshake is already in flight before the relay is wired, and dropping it
  presents as a client hanging forever against a healthy server.

Those modules carry the reasoning in their own doc comments. The property worth
repeating here is the one that makes the split work: **`createRpcProxy` runs
unchanged across a webview hop**, measured in
`test/order-flow-post-message-transport.test.ts`, which drives a real data
server through `structuredClone` in both directions including a
server-initiated push and a conflict reconcile.

## The properties model

`OrderFlowPropertiesModel` is a properties panel with the drawing removed: it
loads a document, presents its editable top-level fields, writes one back, and
follows the document as it changes. A host renders `fields` and calls
`setField`; it supplies no policy.

<!-- snippet-preamble
import { DataEvents, DataSession, type DataPort } from '@hydranium/protocol';
import { OrderFlowPropertiesModel, type PropertyField } from '@hydranium/example-order-flow-client';
import type { DomainModel, LayoutModel, ProcessModel } from '@hydranium/example-order-flow-server/lib/language-server/generated-transfer/transfer-model.js';
declare const port: DataPort;
declare const uri: string;
declare const render: (fields: readonly PropertyField[]) => void;
-->

```ts
// The union of every grammar's transfer root, from the server's generated
// transfer model — the same union `main.ts` hands the data server.
type OrderFlowTransferRoot = DomainModel | LayoutModel | ProcessModel;

const events = new DataEvents<OrderFlowTransferRoot>();
const session = new DataSession<OrderFlowTransferRoot>(port, events);
const model = new OrderFlowPropertiesModel<OrderFlowTransferRoot>(session, events);

await model.open(uri);
model.onDidChange(() => render(model.fields));
const outcome = await model.setField('name', 'Fulfilment');
```

**Document-scoped, not selection-scoped**, and that is a decision. Nothing in
the framework bridges GLSP selection to a host widget, so selection is
shell-owned glue; and a transfer element carries only `$type` — no id — so the
only cross-rebuild address is a positional path, which a foreign insert
invalidates.

**Fields are derived, not declared**: every own property of the root whose value
is a string, minus `$`- and `_`-prefixed ones. So no grammar and no property
name appears in the source. The cost is that a cross-reference is presented like
any other string, because its transfer form *is* its reference text.

`setField` sends the **whole root**, because `TransferUpdateArgs.model` is the
document root and there is no path-scoped variant — the encoder is AST→transfer
only and the parser is the decoder. So a field edit is read-modify-write, and
what keeps it from clobbering a concurrent writer is `baseVersion` plus
`reconcileByPatchReplay`. A host renders each outcome differently, which is why
`setField` returns a status rather than `void`:

| Outcome | Meaning |
| --- | --- |
| `applied` | Landed against an unchanged document. |
| `merged` | Raced a foreign edit to a *different* field; both intents survive. |
| `conflict` | Raced a foreign edit to the *same* field; the write was dropped and the panel now shows the server's value. |
| `unchanged` | The value already matched; nothing was sent. |
| `unavailable` | The document could not be refetched to reconcile against. |

## The contract with the server

`test/process-diagram-contract.test.ts` asserts every duplicated value against
`order-flow-server`'s own constants. Drift is silent in both directions — an
unknown element type id renders a `MissingView` placeholder with nothing but a
browser-console warning, and an unknown diagram type makes GLSP drop the request
— so an empty canvas with no server-side error is the failure this test exists
to prevent.
