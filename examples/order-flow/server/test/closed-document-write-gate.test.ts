/********************************************************************************
 * Copyright (c) 2026 CrossBreeze.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Whether the optimistic `baseVersion` gate accepts a write to a document no
 * client holds open.
 *
 * `update` is an upsert, so it opens the document before applying — and for a
 * closed URI that open assigns the shared version from the INCOMING text. A gate
 * reading the version after it therefore compares the caller's `baseVersion`
 * against a number the caller's own write produced, and rejects every modifying
 * write to a closed document.
 *
 * The real store is required and a stub cannot stand in: the value under test is
 * the persisted version SEQUENCE, which only exists once a URI has been opened
 * and closed for real, and the framework's own stub answers 0 for anything not
 * currently open.
 *
 * Both directions are pinned here, because the fix moves a safety check: a write
 * based on the current version must be accepted, and one based on a stale
 * version must still be refused.
 */

import { isConflictError } from '@hydranium/protocol';
import { DocumentState, URI } from '@hydranium/langium';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { isDomainModel } from '../src/language-server/ast.js';
import { makeScratchWorkspaceHarness, type ScratchOrderFlowHarness } from './order-flow-harness.js';

const FILE = 'closed-write.domain';
const CLEAN = `entity Solo {
   a : string
}
`;
const EDITED = `entity Solo {
   a : string
   b : string
}
`;
const WRITTEN_BACK = `entity Renamed {
   a : string
}
`;

let scratch: ScratchOrderFlowHarness | undefined;

afterEach(() => {
   scratch?.workspace.dispose();
   scratch = undefined;
});

/**
 * Boot, then open / edit / close so the URI carries a persisted version
 * sequence above zero and is no longer in the store. `EDITED` is written to disk
 * too, so a last-close revert re-reads identical content and cannot step the
 * sequence underneath the assertions.
 */
async function closedWithSequence(): Promise<{ harness: ScratchOrderFlowHarness['harness']; uri: URI; version: number }> {
   scratch = await makeScratchWorkspaceHarness(workspace => workspace.write(FILE, CLEAN));
   const { harness, workspace } = scratch;
   const uri = URI.file(workspace.resolve(FILE));
   const uriString = uri.toString();
   const textDocuments = harness.shared.workspace.TextDocuments;
   const builder = harness.shared.workspace.DocumentBuilder;

   textDocuments.notifyDidOpenTextDocument({
      textDocument: { uri: uriString, languageId: 'domain', version: 1, text: CLEAN }
   });
   await builder.waitUntil(DocumentState.Validated, uri);
   textDocuments.notifyDidChangeTextDocument({
      textDocument: { uri: uriString, version: 2 },
      contentChanges: [{ text: EDITED }]
   });
   await builder.waitUntil(DocumentState.Validated, uri);
   writeFileSync(workspace.resolve(FILE), EDITED, 'utf8');
   textDocuments.notifyDidCloseTextDocument({ textDocument: { uri: uriString } });
   await builder.waitUntil(DocumentState.Validated, uri);

   const version = textDocuments.version(uriString);
   expect(version).toBeGreaterThan(0);
   return { harness, uri, version };
}

describe('the baseVersion gate on a document no client holds open', () => {
   it('accepts a modifying write based on the version the store reports', async () => {
      const { harness, uri, version } = await closedWithSequence();

      // Caught rather than left to reject so a failure names the conflict it got
      // instead of an unhandled rejection.
      let rejection: string | undefined;
      const updated = await harness.shared.model.ModelService.update({
         uri: uri.toString(),
         clientId: 'form-editor',
         model: WRITTEN_BACK,
         baseVersion: version
      }).catch((err: unknown) => {
         rejection = String(err);
         return undefined;
      });
      expect(rejection).toBeUndefined();

      // Accepted AND applied — a gate that let the call through without the write
      // landing would pass the assertion above on its own.
      const root = updated?.root;
      if (root === undefined) {
         throw new Error('The write was accepted but returned no document');
      }
      if (!isDomainModel(root)) {
         throw new Error(`Expected a DomainModel root, got ${root.$type}`);
      }
      expect(root.declarations.map(declaration => declaration.name)).toEqual(['Renamed']);
   });

   it('still refuses a write based on a stale version', async () => {
      const { harness, uri, version } = await closedWithSequence();

      // One behind whatever the sequence reached: the genuine conflict the gate
      // exists for, and the half that must not be lost by reading earlier.
      const stale = version - 1;
      await expect(
         harness.shared.model.ModelService.update({
            uri: uri.toString(),
            clientId: 'form-editor',
            model: WRITTEN_BACK,
            baseVersion: stale
         })
      ).rejects.toSatisfy(isConflictError);
   });
});
