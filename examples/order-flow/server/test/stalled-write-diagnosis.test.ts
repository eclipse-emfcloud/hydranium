/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A rule that rebuilds through the model service from inside the build running
 * it, in a host with no write-lock scope tracker. Nothing can reject that call
 * there, so the build waits for itself; what has to hold is that the lock says
 * so. The real services are needed because the diagnosis depends on the inner
 * request cancelling its enclosing build rather than joining it.
 */

import { HydraniumWorkspaceLock, IntegrityPhase, type IntegrityRule, setWriteLockScope } from '@hydranium/core';
import { nodeWriteLockScope } from '@hydranium/core/node';
import { type AstNode, type LangiumDocument, URI } from '@hydranium/langium';
import { waitFor } from '@hydranium/protocol/testing';
import { afterEach, expect, it } from 'vitest';
import type { OrderFlowSharedServices } from '../src/language-server/order-flow-module.js';
import { makeScratchWorkspaceHarness, type ScratchOrderFlowHarness } from './order-flow-harness.js';

const FILE = 'reentrant.domain';

class RecordingLock extends HydraniumWorkspaceLock {
   reported = 0;
   protected override reportStalledWrite(): void {
      this.reported++;
      super.reportStalledWrite();
   }
}

let scratch: ScratchOrderFlowHarness | undefined;
afterEach(() => {
   setWriteLockScope(nodeWriteLockScope);
   scratch?.workspace.dispose();
   scratch = undefined;
});

it('reports the stalled write when a rule rebuilds from inside its own build without a tracker', async () => {
   setWriteLockScope(undefined);
   let lock: RecordingLock | undefined;
   scratch = await makeScratchWorkspaceHarness(workspace => workspace.write(FILE, 'entity Solo {\n   a : string\n}\n'), {
      extraSharedModules: [
         {
            workspace: {
               WorkspaceLock: (services: OrderFlowSharedServices) => (lock = new RecordingLock(services, { stalledWriteWarnMs: 200 }))
            }
         }
      ]
   });
   const { harness, workspace } = scratch;
   const uriString = URI.file(workspace.resolve(FILE)).toString();
   const modelService = harness.shared.model.ModelService;

   let fired = false;
   const rule: IntegrityRule = {
      id: 'test-reentrant-rebuild',
      nodeType: 'DomainModel',
      phase: IntegrityPhase.Parsed,
      enforce: async (_node: AstNode, document: LangiumDocument) => {
         if (fired || document.uri.toString() !== uriString) {
            return false;
         }
         fired = true;
         await modelService.rebuild(uriString).catch(() => undefined);
         return false;
      }
   };
   harness.domain.integrity.IntegrityService.register(rule);

   let settled = false;
   void modelService.rebuild(uriString).then(
      () => (settled = true),
      () => (settled = true)
   );
   await waitFor(() => lock?.reported === 1, { timeoutMs: 5_000 });
   expect(fired).toBe(true);
   expect(settled).toBe(false);
});
