/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { LatencyCollector } from '@hydranium/protocol';
import type { ConnectionOptions, Message } from 'vscode-jsonrpc';

/**
 * Connection options that time every inbound LSP message into `latency` under
 * its method name — the LSP analog of the data-server RPC chokepoint.
 *
 * Pass the result to `createConnection` where the head builds its connection:
 * `createConnection(ProposedFeatures.all, lspLatencyOptions(latency))`. The
 * transport is untouched, so a head keeps whatever `--stdio` / `--socket`
 * selection its arguments make.
 *
 * **`messageStrategy` is the seam because it is the only one the handlers
 * actually pass through.** `vscode-languageserver` builds its `Connection` as an
 * object whose `onHover`, `onCompletion` and every other named helper register
 * against the inner protocol connection captured in their closure — not against
 * the returned object's own `onRequest`. Langium registers exclusively through
 * those helpers, so decorating the `Connection` reaches none of them and reports
 * an empty LSP half no matter how much traffic ran. `handleMessage` sits on the
 * dispatch path itself, which every request and notification crosses, so it also
 * catches `initialize` — special-cased into `onInitialize` and invisible to any
 * `onRequest` decoration.
 *
 * What it measures is **dispatch plus handler**, not handler alone: the wait a
 * client actually experiences, including time queued behind other work.
 *
 * When `latency` is `undefined` the seam is off and this returns `undefined`, so
 * a head can pass the result of an env-gated factory (`latencyFromEnv()`)
 * straight through and pay nothing when timing is not enabled.
 */
export function lspLatencyOptions(latency: LatencyCollector | undefined): ConnectionOptions | undefined {
   if (!latency) {
      return undefined;
   }
   return {
      messageStrategy: {
         handleMessage: (message: Message, next: (message: Message) => void | Promise<void>) => {
            // Responses to requests the SERVER sent carry no method and are not
            // work this head performed; timing them would report the client's
            // latency under a name this collector cannot supply.
            if (!hasMethod(message)) {
               return next(message);
            }
            return latency.time(message.method, () => next(message));
         }
      }
   };
}

/** Narrow to the messages that name an operation — requests and notifications. */
function hasMethod(message: Message): message is Message & { method: string } {
   return typeof (message as { method?: unknown }).method === 'string';
}
