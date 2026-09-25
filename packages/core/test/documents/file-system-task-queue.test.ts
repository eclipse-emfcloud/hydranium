/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { asCanonicalUri, Deferred } from '@hydranium/protocol';
import { tick } from '@hydranium/protocol/testing';
import { DefaultFileSystemTaskQueue } from '../../src/documents/file-system-task-queue.js';
import { DefaultDocumentUriPolicy, type DocumentUriPolicy } from '../../src/langium/workspace/document-uri-policy.js';

/** A policy that resolves the `link` directory to `real`, as a symlink would be. */
const linkPolicy: DocumentUriPolicy = {
   canonicalUri: uri => asCanonicalUri(uri.toString().replace('/link/', '/real/')),
   loadUri: uri => new DefaultDocumentUriPolicy().loadUri(uri)
};

function makeQueue(): DefaultFileSystemTaskQueue {
   return new DefaultFileSystemTaskQueue({ workspace: { DocumentUriPolicy: linkPolicy } });
}

describe('DefaultFileSystemTaskQueue', () => {
   it('runs a task of a file only once the task enqueued before it under another of its URIs has settled', async () => {
      const queue = makeQueue();
      const first = new Deferred();
      const order: string[] = [];

      void queue.enqueue('file:///ws/real/a.x', async () => {
         await first.promise;
         order.push('first');
      });
      const second = queue.enqueue('file:///ws/link/a.x', async () => {
         order.push('second');
      });
      await tick(0);
      expect(order).toEqual([]);

      first.resolve();
      await second;
      expect(order).toEqual(['first', 'second']);
   });

   it('runs tasks of different files in parallel, whatever their scheme', async () => {
      const queue = makeQueue();
      const held = new Deferred();
      void queue.enqueue('file:///ws/a.x', () => held.promise);

      await expect(queue.enqueue('memory:///b.x', async () => 'ran')).resolves.toBe('ran');
      held.resolve();
   });

   it('runs the next task of a file after one that failed, and hands each caller its own outcome', async () => {
      const queue = makeQueue();

      const failed = queue.enqueue('file:///ws/a.x', async () => {
         throw new Error('write failed');
      });
      const next = queue.enqueue('file:///ws/a.x', async () => 'next');

      await expect(failed).rejects.toThrow('write failed');
      await expect(next).resolves.toBe('next');
   });
});
