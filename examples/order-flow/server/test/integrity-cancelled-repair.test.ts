/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A build cancelled after an integrity rule mutated the AST and before the
 * repair reached the text. The next build re-parses only text that changed, so
 * a repair left unsynced survives in the AST against text that never had it,
 * and the rule, seeing it already applied, never repairs the text. What has to
 * hold is that the AST, the text it was parsed from and the file all carry the
 * repair once the builds settle.
 *
 * The real builder, factory and lock are needed: the defect is in how the next
 * build treats a document the cancelled one left behind.
 */

import { IntegrityPhase, type IntegrityRule } from '@hydranium/core';
import { type AstNode, DocumentState, type LangiumDocument, setInterruptionPeriod, URI } from '@hydranium/langium';
import { waitFor } from '@hydranium/protocol/testing';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { isDomainModel } from '../src/language-server/ast.js';
import { makeScratchWorkspaceHarness, type ScratchOrderFlowHarness } from './order-flow-harness.js';

const FILE = 'repaired.domain';
const OTHER = 'other.domain';
const REPAIRED = 'Marked__repaired';

let scratch: ScratchOrderFlowHarness | undefined;
afterEach(() => {
   setInterruptionPeriod(10);
   scratch?.workspace.dispose();
   scratch = undefined;
});

async function boot(): Promise<{ uri: URI; uriString: string; otherUri: URI }> {
   scratch = await makeScratchWorkspaceHarness(workspace => {
      workspace.write(FILE, 'entity Marked {\n   a : string\n}\n');
      workspace.write(OTHER, 'entity Other {\n   a : string\n}\n');
   });
   const uri = URI.file(scratch.workspace.resolve(FILE));
   return { uri, uriString: uri.toString(), otherUri: URI.file(scratch.workspace.resolve(OTHER)) };
}

/** Rename `Marked` in `uriString`, once, then call `afterRename`. */
function renameRule(uriString: string, afterRename: () => Promise<void> | void): IntegrityRule {
   let renamed = false;
   return {
      id: 'test-rename',
      nodeType: 'Entity',
      phase: IntegrityPhase.Parsed,
      enforce: (node: AstNode, document: LangiumDocument) => {
         const named = node as AstNode & { name?: string };
         if (renamed || document.uri.toString() !== uriString || named.name !== 'Marked') {
            return false;
         }
         named.name = REPAIRED;
         renamed = true;
         const after = afterRename();
         return after instanceof Promise ? after.then(() => true) : true;
      }
   };
}

/** The AST's declaration names, and the first line of the CST's text and of the file. */
function settledState(uri: URI): { names: string[]; parsedFrom?: string; disk: string } {
   const { harness, workspace } = scratch!;
   const root = harness.shared.workspace.LangiumDocuments.getDocument(uri)!.parseResult.value;
   if (!isDomainModel(root)) {
      throw new Error(`Expected a DomainModel root, got ${root.$type}`);
   }
   return {
      names: root.declarations.map(declaration => declaration.name),
      parsedFrom: root.$cstNode?.root.fullText.split('\n')[0],
      disk: readFileSync(workspace.resolve(FILE), 'utf8').split('\n')[0]
   };
}

describe('a build cancelled between an integrity repair and its resync', () => {
   it.each(['the same document', 'another document'] as const)(
      'still lands the repair in the text when the cancelling build is of %s',
      async canceller => {
         const { uri, uriString, otherUri } = await boot();
         const { harness } = scratch!;
         const builder = harness.shared.workspace.DocumentBuilder;
         const lock = harness.shared.workspace.WorkspaceLock;
         let renamed!: () => void;
         const mutated = new Promise<void>(resolve => (renamed = resolve));
         let release!: () => void;
         const held = new Promise<void>(resolve => (release = resolve));
         harness.domain.integrity.IntegrityService.register(
            renameRule(uriString, () => {
               renamed();
               return held;
            })
         );

         const first = harness.shared.model.ModelService.rebuild(uriString).catch(() => undefined);
         await mutated;
         const cancelling = lock.write(token => builder.update([canceller === 'the same document' ? uri : otherUri], [], token));
         release();
         await cancelling;
         await first;
         await builder.waitUntil(DocumentState.Validated, uri);

         expect(settledState(uri)).toEqual({ names: [REPAIRED], parsedFrom: `entity ${REPAIRED} {`, disk: `entity ${REPAIRED} {` });
      }
   );

   it('still lands the repair when a synchronous rule is cancelled at the check after its mutation', async () => {
      // Every per-node check yields, so a write queued by the rule runs inside
      // that yield: the window an edit arriving mid-build lands in.
      setInterruptionPeriod(0);
      const { uri, uriString, otherUri } = await boot();
      const { harness } = scratch!;
      const builder = harness.shared.workspace.DocumentBuilder;
      const lock = harness.shared.workspace.WorkspaceLock;
      let cancelling: Promise<void> | undefined;
      harness.domain.integrity.IntegrityService.register(
         renameRule(uriString, () => {
            setImmediate(() => (cancelling = lock.write(token => builder.update([otherUri], [], token))));
         })
      );

      await harness.shared.model.ModelService.rebuild(uriString).catch(() => undefined);
      await waitFor(() => cancelling !== undefined);
      await cancelling;
      await builder.waitUntil(DocumentState.Validated, uri);

      expect(settledState(uri)).toEqual({ names: [REPAIRED], parsedFrom: `entity ${REPAIRED} {`, disk: `entity ${REPAIRED} {` });
   });
});
