/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The webview half of the clone hop, tested in the package that ships it.
 *
 * No `MessageConnection` is built here, on purpose and for the same reason the
 * module under test does not build one: vscode-jsonrpc 9's package ROOT installs
 * no runtime abstraction layer and throws on the first message. The reader and
 * the writer are the whole surface, so they are driven directly.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Disposable, Message } from 'vscode-jsonrpc';
import { createPostMessageTransport, type PostMessageChannel } from '../../src/client';
import { tick } from '../../src/testing';
import { ClonePipeEnd, notification } from './clone-pipe';

const toDispose: Disposable[] = [];

function track<T extends Disposable>(disposable: T): T {
   toDispose.push(disposable);
   return disposable;
}

afterEach(() => {
   for (const disposable of toDispose.reverse()) {
      disposable.dispose();
   }
   toDispose.length = 0;
});

describe('createPostMessageTransport', () => {
   it('delivers a message the far end posted, having crossed structured clone', async () => {
      const [near, far] = ClonePipeEnd.pair();
      track(near);
      track(far);
      const transport = track(createPostMessageTransport(near));

      const received: Message[] = [];
      track(transport.reader.listen(message => received.push(message)));
      const sent = notification('ns/one', 1);
      far.post(sent);
      await tick();

      expect(received).toEqual([sent]);
      // A copy, not the object posted: the boundary clones, so a sender holding a
      // reference to what it sent cannot observe the far side mutating it.
      expect(received[0]).not.toBe(sent);
   });

   it('posts what the writer writes', async () => {
      const [near, far] = ClonePipeEnd.pair();
      track(near);
      track(far);
      const transport = track(createPostMessageTransport(near));

      const farTransport = track(createPostMessageTransport(far));
      const received: Message[] = [];
      track(farTransport.reader.listen(message => received.push(message)));
      await expect(transport.writer.write(notification('ns/two', 2))).resolves.toBeUndefined();
      await tick();

      expect(received).toEqual([notification('ns/two', 2)]);
   });

   it('fires close on both reader and writer when the channel closes', () => {
      const end = track(new ClonePipeEnd());
      const transport = track(createPostMessageTransport(end));

      let readerClosed = 0;
      let writerClosed = 0;
      track(transport.reader.onClose(() => (readerClosed += 1)));
      track(transport.writer.onClose(() => (writerClosed += 1)));
      end.fireClose();

      expect([readerClosed, writerClosed]).toEqual([1, 1]);
   });

   it('stops delivering once disposed', async () => {
      const [near, far] = ClonePipeEnd.pair();
      track(near);
      track(far);
      const transport = createPostMessageTransport(near);

      const received: Message[] = [];
      transport.reader.listen(message => received.push(message));
      transport.dispose();
      far.post(notification('ns/three', 3));
      await tick();

      expect(received).toEqual([]);
   });

   it('works over a channel that offers no close', async () => {
      // `onClose` is optional on the contract, and a host whose pipe has no
      // observable end must still get a usable reader rather than a throw.
      const delivered = new Set<(message: Message) => void>();
      const closeless: PostMessageChannel = {
         post: message => delivered.forEach(listener => listener(message)),
         onMessage: listener => {
            delivered.add(listener);
            return { dispose: () => delivered.delete(listener) };
         }
      };
      const transport = track(createPostMessageTransport(closeless));

      const received: Message[] = [];
      track(transport.reader.listen(message => received.push(message)));
      await transport.writer.write(notification('ns/four', 4));

      expect(received).toEqual([notification('ns/four', 4)]);
   });
});
