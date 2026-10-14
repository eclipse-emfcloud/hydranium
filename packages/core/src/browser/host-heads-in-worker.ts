/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   describeErrorWithStack,
   isWorkerBootstrapMessage,
   WORKER_BOOTSTRAP_PHASE,
   WORKER_ERROR_MESSAGE_TYPE,
   WORKER_READY_MESSAGE_TYPE,
   type HeadPorts,
   type WorkerErrorMessage,
   type WorkerReadyMessage,
   type WorkerWorkspace
} from '@hydranium/protocol';
import { isOperationCancelled, URI } from '@hydranium/langium';
import type { ServerSharedServicesMinimal } from '../langium/shared-services.js';
import { isFileSystemProviderRegistry } from '../langium/workspace/file-system-provider.js';
import { PersistentFileSystemProvider } from '../langium/workspace/persistent-file-system-provider.js';
import { isConnectionGoneError } from '../util/connection-liveness.js';

/**
 * Report a failure to the page on the worker global, the channel no head is
 * allowed to bind, which is what keeps it free for this. A report under
 * {@link WORKER_BOOTSTRAP_PHASE} ends the page's heads; any other phase is
 * shown there and the heads stay. The stack goes with it: a worker has no log
 * anyone reads, so the page is the one place the stack can be seen.
 */
export function reportWorkerError(phase: string, error: unknown): void {
   const report: WorkerErrorMessage = { type: WORKER_ERROR_MESSAGE_TYPE, phase, message: describeErrorWithStack(error) };
   postMessage(report);
}

/** What the host's `start` hands back: the shared tier, and the readiness of any head that reports it later. */
export interface StartedHeads {
   readonly shared: ServerSharedServicesMinimal;
   /**
    * The `started` promise of every head that reports a failed start through
    * one rather than by throwing, such as the GLSP head's. The ready message
    * waits for them, and a rejection is a failed bootstrap.
    */
   readonly started?: ReadonlyArray<Promise<unknown>>;
}

/** What {@link hostHeadsInWorker} does beyond starting the heads. */
export interface HostHeadsInWorkerOptions {
   /**
    * The workspace root, as the page names it in `initialize`. Given one, the
    * ready message carries every file under it with its content, and the paths
    * restored from a {@link PersistentFileSystemProvider}'s store under it.
    * Left out, the ready message carries no files and nothing is read. Every
    * file's content goes in one message, so a workspace too large for that
    * wants a per-document read instead.
    */
   readonly rootUri?: string;
}

/**
 * Answer the page's bootstrap by starting the heads on its ports, once per
 * worker, and tell the page when they are up and when something fails.
 *
 * `start` is synchronous by type, and that is the ordering contract: every
 * head's transport starts its port as it is built but drops what arrives
 * before the head listens, so an `await` between building a head and
 * listening loses the page's first request with no error. Everything
 * asynchronous, the filesystem's restore above all, is `prepared`, which is
 * awaited before `start` is called. It may be a plain value where nothing has
 * to be awaited.
 *
 * Once `start` has returned and every `started` it handed back has resolved,
 * the ready message goes out, so a page never hears of heads that failed to
 * come up, and an uncaught error from then on is a report rather than the end
 * of the heads. It carries the workspace's files when
 * {@link HostHeadsInWorkerOptions.rootUri} is given. Then every document is
 * built with validation once the workspace has initialised: Langium's initial
 * build validates nothing, so a page that only opens its ports would see a
 * server that indexed the workspace and says nothing. An initial build that
 * a write during startup cancelled is built the same, since every document
 * exists by then.
 *
 * Call it once: a second call answers the same bootstrap with a second set of
 * heads on the same ports and reports every rejection twice. The worker's
 * `unhandledrejection` listener is this function's; it drops Langium's
 * `OperationCancelled` marker, which a build preempted by a write rejects
 * with, as the Node host does. An uncaught throw needs no listener, since it
 * reaches the page as the `Worker`'s own `error` event.
 */
export function hostHeadsInWorker<TPrepared>(
   prepared: TPrepared | PromiseLike<TPrepared>,
   start: (ports: HeadPorts, prepared: TPrepared) => ServerSharedServicesMinimal | StartedHeads,
   options: HostHeadsInWorkerOptions = {}
): void {
   const preparation = Promise.resolve(prepared);
   // Handled here, so a restore that fails before the bootstrap arrives reaches
   // the page once, under the bootstrap phase, and not first as an unhandled
   // rejection.
   preparation.catch(() => undefined);

   // Rejections only, and not the ones the framework's own handlers already
   // settle: a rejected LSP handler is caught by the connection, and a failed
   // workspace walk rejects `workspaceInitialized`, which is reported below.
   addEventListener('unhandledrejection', event => {
      if (isOperationCancelled(event.reason)) {
         // Dropped from the console too, as a Node listener's presence drops
         // it there; a reported rejection keeps its console entry, the one
         // place its stack stays navigable.
         event.preventDefault();
      } else {
         reportWorkerError('unhandled rejection', event.reason);
      }
   });

   // One bootstrap per worker: the heads are composed against a single shared
   // Langium tree, so a second would build a second tree over the same seed and
   // hand out sessions that silently disagree about the workspace.
   let bootstrapped = false;
   // The bare global rather than `self.addEventListener`: only the former is
   // typed against the dedicated worker's event map, where `message` carries a
   // `MessageEvent`.
   addEventListener('message', event => {
      if (bootstrapped || !isWorkerBootstrapMessage(event.data)) {
         return;
      }
      bootstrapped = true;
      // `.catch` rather than try/catch: a rejected restore, a `start` that
      // throws and a head whose `started` rejects arrive by the same route, and
      // all have to reach the page.
      onBootstrap(event.data.ports).catch((error: unknown) => reportWorkerError(WORKER_BOOTSTRAP_PHASE, error));
   });

   async function onBootstrap(ports: HeadPorts): Promise<void> {
      const value = await preparation;
      const result = start(ports, value);
      const { shared, started } = 'shared' in result ? result : { shared: result, started: undefined };
      // Safe to await now: every head listens already, so nothing is lost.
      await Promise.all(started ?? []);
      const ready: WorkerReadyMessage = {
         type: WORKER_READY_MESSAGE_TYPE,
         workspace: options.rootUri === undefined ? undefined : readWorkspace(shared, options.rootUri)
      };
      postMessage(ready);
      validateWorkspace(shared).catch((error: unknown) => reportWorkerError('workspace validation', error));
   }
}

/**
 * Every file under `rootUri`, walked through the bound provider, so a file
 * that exists only in the store is included, which the seed's keys would miss.
 */
function readWorkspace(shared: ServerSharedServicesMinimal, rootUri: string): WorkerWorkspace {
   const provider = shared.workspace.FileSystemProvider;
   const root = URI.parse(rootUri);
   // Keys past the root, a trailing slash on it or not.
   const prefix = `${root.toString().replace(/\/$/, '')}/`;
   // No prototype, so a file named `__proto__` is a key like any other.
   const files: Record<string, string> = Object.create(null);
   const visit = (uri: URI): void => {
      for (const node of provider.readDirectorySync(uri)) {
         if (node.isFile) {
            files[node.uri.toString().slice(prefix.length)] = provider.readFileSync(node.uri);
         } else {
            visit(node.uri);
         }
      }
   };
   visit(root);
   // The bound slot is the scheme registry, so the provider that holds the
   // root is the one its scheme selects. Its store may key under another
   // root, absolutely or unencoded, so a restored path is resolved as the
   // provider resolves it, and one outside this root names no file here.
   const holder = isFileSystemProviderRegistry(provider) ? provider.providerFor(root) : provider;
   // A set, since a store may hold one file under two spellings.
   const restored = new Set<string>();
   if (holder instanceof PersistentFileSystemProvider) {
      for (const path of holder.restoredPaths) {
         const uri = holder.storeUri(path).toString();
         if (uri.startsWith(prefix) && Object.hasOwn(files, uri.slice(prefix.length))) {
            restored.add(uri.slice(prefix.length));
         }
      }
   }
   return { rootUri, files, restored: [...restored] };
}

/**
 * The trailing validating build, after `workspaceInitialized`: building before
 * it would validate a partial document set. A cancelled or connection-gone
 * initial build is routine, so it is built through; any other failure is the
 * caller's to report.
 */
async function validateWorkspace(shared: ServerSharedServicesMinimal): Promise<void> {
   await shared.workspace.WorkspaceManager.workspaceInitialized.catch((error: unknown) => {
      if (!isOperationCancelled(error) && !isConnectionGoneError(error)) {
         throw error;
      }
   });
   await shared.workspace.DocumentBuilder.build(shared.workspace.LangiumDocuments.all.toArray(), { validation: true });
}
