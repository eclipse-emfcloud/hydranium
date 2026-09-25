/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type CanonicalUri } from '@hydranium/protocol';
import { type ServerSharedServices } from '../langium/module.js';
import { type DocumentUriPolicy } from '../langium/workspace/document-uri-policy.js';

/**
 * One queue of file-system tasks per file, shared by every server-side reader
 * and writer of a file whose accesses must not interleave with its saves.
 *
 * Two writes of one file that bypass the queue can land in either order, and
 * the older text then stays on disk. Tasks of different files run in
 * parallel.
 */
export interface FileSystemTaskQueue {
   /**
    * Run `task` once every task already enqueued for `uri` has settled, and
    * before any enqueued after it. `uri` is keyed by its canonical identity, so
    * every spelling of one file shares a queue. A task that has nothing to do
    * still resolves once the tasks before it have settled.
    *
    * A task must not await a build, nor a save, another task or an open of a
    * document no client has open, all of the same file: a build's integrity
    * repair enqueues its own write and the build waits for it, and such an
    * open reads the file here, so a task waiting on either never resolves,
    * which wedges the file's queue for good.
    */
   enqueue<T>(uri: string, task: () => Promise<T>): Promise<T>;
}

export class DefaultFileSystemTaskQueue implements FileSystemTaskQueue {
   /**
    * Per canonical URI, the settling of the last task enqueued for it; the next
    * task chains behind it. An entry leaves once its file's queue is idle. Kept
    * outside the workspace lock, whose `write` cancels the write before it: a
    * save cancelled that way reports success for text it never wrote.
    */
   protected readonly queues = new Map<CanonicalUri, Promise<void>>();

   protected readonly uriPolicy: DocumentUriPolicy;

   constructor(services: { readonly workspace: Pick<ServerSharedServices['workspace'], 'DocumentUriPolicy'> }) {
      this.uriPolicy = services.workspace.DocumentUriPolicy;
   }

   enqueue<T>(uri: string, task: () => Promise<T>): Promise<T> {
      const key = this.uriPolicy.canonicalUri(uri);
      const result = (this.queues.get(key) ?? Promise.resolve()).then(task);
      const settled = result.then(
         () => undefined,
         () => undefined
      );
      this.queues.set(key, settled);
      void settled.then(() => {
         if (this.queues.get(key) === settled) {
            this.queues.delete(key);
         }
      });
      return result;
   }
}
