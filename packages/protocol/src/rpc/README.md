# JSON-RPC primitives

Exported from the package root, `@hydranium/protocol`. There is no
`@hydranium/protocol/rpc` subpath: the package's `exports` map publishes `.`,
`./client`, `./data` and `./testing` (plus their `./lib/*` twins), so importing
this directory by path fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

Generic JSON-RPC primitives for typed protocol heads over a vscode-jsonrpc
`MessageConnection`. This page is the reference; the shape of the pattern and
why the two helpers mirror each other are in the
[package README](../../README.md#the-rpc-pattern).

## The pair

### `bindRpcMethods(connection, target, methodNames, options?)`

Server side. Registers each method named in `methodNames` on `target` as a
handler on `connection` under the wire name `<methodNamespace><methodName>`.
Notification methods (by the configured heuristic) register with
`onNotification`; request methods register with `onRequest`. Returns a
`Disposable` that tears down every registration.

### `createRpcProxy<T>(connection, options?)`

Caller side. Returns a JS `Proxy` typed as `T & RpcProxyLifecycle`. Each
property access lowers to `sendRequest` (request methods) or
`sendNotification` (notification methods, by the same heuristic) under the
same wire-name composition. The lifecycle events (`onDidOpenConnection` /
`onDidCloseConnection`) let proxy-only consumers react to the connection
without holding the `MessageConnection` reference directly.

## Shared semantics

The options are deliberately mirrored across both helpers. Server and client
MUST agree on each — a mismatch produces silent routing failures.

### Wire-name composition: `methodNamespace`

Both helpers compose the wire method name as
`(methodNamespace ?? '') + methodName`. Adopters that share a connection
across multiple protocol heads partition the wire surface with namespaced
prefixes — the LSP analogy is `textDocument/*` / `workspace/*`. The
data-server head ships with `'data-server/'` by default; adopters that
combine the data-server with their own protocol head under one prefix pass
their adopter namespace (e.g. `'myapp/'`) on both sides.

Trailing-slash discipline is the adopter's responsibility — `'foo'` is a
literal prefix, not interpreted as a namespace segment.

### Notification discrimination: `isNotification`

Default: property names starting with `'on'` followed by an uppercase letter
are notifications. That matches the observer-pattern convention used
throughout the framework's contracts (`onDocumentUpdated`, `onDocumentSaved`,
etc.), while leaving request-shaped names that merely begin with the letters
"on" (`onboardUser`, `onlineCheck`) routed as requests.

For contracts that don't fit the convention, both helpers accept an
`isNotification: (name: string) => boolean` override. Pass the same
predicate on both sides — they must agree on every method, otherwise one
end will register a request handler while the other sends a notification
(no reply, silent timeout).

### Single-arg-per-method convention

Method dispatch passes JSON-RPC `params` to the target as a single argument.
This is the framework's convention throughout — adopters define methods as
`doStuff(args: { x, y })`, not `doStuff(x, y)`. The proxy enforces the
convention at runtime: calling `proxy.doStuff(a, b)` with more than one
argument throws (loose `any` / `unknown` proxies would otherwise drop extra
args silently).

### Deferred connection

Both helpers accept `MessageConnection | Promise<MessageConnection>`. When
the promise form is passed:

- `createRpcProxy` — outgoing calls queue until the connection resolves,
  then dispatch in order.
- `bindRpcMethods` — handler registration queues until the connection
  resolves, then attaches in one pass. The returned disposable cancels
  queued work if disposed before resolve; otherwise it tears down the
  attached handlers as usual.

Wire-side safety: vscode-jsonrpc buffers nothing on the *receiving* side
until `connection.listen()` is called, so adopters wiring handlers in
`@postConstruct` (before the connection's other end opens) cannot drop a
message that arrives during the queue window.

## Reserved property names on `RpcProxy<T>`

The proxy's `get` trap intercepts four property names. A wire method
declared on `T` with one of these names would shadow the reserved
behaviour instead of dispatching a wire call. Adopters defining wire
methods should avoid:

- `onDidOpenConnection` / `onDidCloseConnection` — return the lifecycle events
- `then` — returns `undefined` so the proxy isn't auto-awaited by host-environment promise detection
- `toJSON` — returns `undefined` so serialisers don't try to flatten the proxy

Symbol property accesses also return `undefined` (the proxy is not
iterable, not a thenable, not serialisable).

## Example

A minimal adopter contract paired across the wire:

<!-- snippet-preamble
import { bindRpcMethods, createRpcProxy } from '@hydranium/protocol';
import type { MessageConnection } from 'vscode-jsonrpc';
declare const connection: MessageConnection;
-->

```ts
interface CounterApi {
   increment(args: { by: number }): Promise<{ value: number }>;
   onChanged(event: { value: number }): void;
}

// Server side — adopter implements the contract on a class:
class CounterServer implements CounterApi {
   private value = 0;
   async increment(args: { by: number }): Promise<{ value: number }> {
      this.value += args.by;
      return { value: this.value };
   }
   onChanged(): void {
      throw new Error('outbound notification — never called on the server');
   }
}

const server = new CounterServer();
const disposable = bindRpcMethods<CounterApi>(
   connection,
   server,
   ['increment', 'onChanged'],
   { methodNamespace: 'counter/' }
);

// Caller side — typed proxy over the same wire prefix:
const proxy = createRpcProxy<CounterApi>(connection, { methodNamespace: 'counter/' });
const { value } = await proxy.increment({ by: 3 });
```

The data-server head is built from these same two primitives rather than from
a data-specific wrapper: `DataServer` binds its own contract and its client
proxy in a single `createRpcProxy` call, over the method-name lists
`@hydranium/protocol/data` publishes (`DATA_SERVER_PROTOCOL_METHODS` and its
client dual). An adopter composing a head of their own follows the same shape.

## Relationship to other RPC libraries

- **vscode-jsonrpc directly.** These helpers are a thin typed shell over
  `connection.sendRequest` / `onRequest` / `sendNotification` /
  `onNotification`. Adopters wanting to opt out for one specific method
  can always reach the connection underneath.
- **LSP `RequestType` / `NotificationType` keys.** LSP-style codebases
  declare each wire method as a typed symbol; this framework declares the
  whole protocol as an interface and walks its keys. Interface-based is
  the right call for a *generic* framework (one declaration, N adopters);
  adopters coming from LSP looking for `RequestType` helpers won't find
  them — the equivalent here is the contract interface plus its
  method-name list (e.g. `DATA_SERVER_PROTOCOL_METHODS`).
