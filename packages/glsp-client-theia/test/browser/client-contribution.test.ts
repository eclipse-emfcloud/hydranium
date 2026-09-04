/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Stub Theia OutputChannel (DOM-pulling) + BaseGLSPClientContribution (which
// transitively imports from Theia's monaco-coupled chain). Both are used as
// the SUT's runtime base class / @inject target only — stubs are enough for
// the deferred-marker tests.
vi.mock('@theia/output/lib/browser/output-channel', () => ({
   OutputChannelManager: class OutputChannelManager {},
   OutputChannel: class OutputChannel {}
}));
vi.mock('@eclipse-glsp/theia-integration', () => ({
   BaseGLSPClientContribution: class BaseGLSPClientContribution {
      protected async start(): Promise<void> {
         // upstream sets up the GLSP wire — stubbed for the deferred-start tests.
      }
   }
}));
vi.mock('@theia/workspace/lib/browser', () => ({
   WorkspaceService: class WorkspaceService {}
}));

import { describe, expect, it, vi } from 'vitest';
import { HydraniumGlspClientContribution } from '../../src/browser/client-contribution';

interface FakeOutputChannel {
   text: string;
   listeners: Array<() => void>;
   resource: { textModel: { getValue(): string } };
   onContentChange(cb: () => void): { dispose: () => void };
}

function makeFakeChannel(initialText = ''): FakeOutputChannel {
   const listeners: Array<() => void> = [];
   const channel: FakeOutputChannel = {
      text: initialText,
      listeners,
      resource: {
         textModel: {
            getValue: () => channel.text
         }
      },
      onContentChange(cb: () => void): { dispose: () => void } {
         listeners.push(cb);
         return {
            dispose: () => {
               const idx = listeners.indexOf(cb);
               if (idx >= 0) {
                  listeners.splice(idx, 1);
               }
            }
         };
      }
   };
   return channel;
}

class TestContribution extends HydraniumGlspClientContribution {
   constructor(options: ConstructorParameters<typeof HydraniumGlspClientContribution>[0]) {
      super(options);
   }
   exposeWaitForBackend(): Promise<void> {
      return this.waitForBackendConnected();
   }
}

describe('HydraniumGlspClientContribution.waitForBackendConnected', () => {
   it('resolves immediately when the ready marker is already in the channel', async () => {
      const channel = makeFakeChannel('boot...\nStarting GLSP server connection\n');
      const contribution = new TestContribution({
         languageContributionId: 'foo',
         channelName: 'Foo',
         readyMarker: 'Starting GLSP server connection'
      });
      contribution['outputChannelManager'] = {
         getChannel: () => channel
      } as never;
      await expect(contribution.exposeWaitForBackend()).resolves.toBeUndefined();
      expect(channel.listeners).toHaveLength(0);
   });

   it('subscribes and resolves once the marker appears in the channel', async () => {
      const channel = makeFakeChannel('boot...\n');
      const contribution = new TestContribution({
         languageContributionId: 'foo',
         channelName: 'Foo',
         readyMarker: 'READY'
      });
      contribution['outputChannelManager'] = {
         getChannel: () => channel
      } as never;
      const waiter = contribution.exposeWaitForBackend();
      // Simulate a content append that doesn't include the marker yet.
      channel.text += 'still booting\n';
      channel.listeners.forEach(cb => cb());
      // Now write the marker.
      channel.text += 'READY\n';
      channel.listeners.forEach(cb => cb());
      await expect(waiter).resolves.toBeUndefined();
      // Listener disposed itself once the marker fired.
      expect(channel.listeners).toHaveLength(0);
   });
});
