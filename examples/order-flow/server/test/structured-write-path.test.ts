/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The **structured** write path: `ModelService.update` handed a transfer model
 * rather than pre-serialised text, which is what `DataServer.updateModelDocument`
 * does for every form-editor save.
 *
 * This lives in the example, not in `core`, because `core` cannot reach it.
 * `makeTestServices` takes a `serialize` function and gives it to
 * `StubModelService`, so the framework's own harness *substitutes* the hook under
 * test — its stub services tree has no `ServiceRegistry` for a per-language
 * `Serializer` to be resolved through. The real `ModelService.serialize`, which
 * resolves `ServiceRegistry.getServices(uri).serializer.Serializer`, therefore
 * only runs where real language services exist. That is here.
 *
 * A test that pins only the *dispatch* — that `serialize` was called, or that a
 * recording stub returned its constant — cannot see the failure that matters: an
 * emitter that blanks a transfer-mode cross-reference writes
 * `writes Order.status = PAID` back as `writes . = `, and the damaged text still
 * parses.
 *
 * So the assertions here are on the resulting TEXT, and they are exact.
 */

import { describe, expect, it, onTestFinished } from 'vitest';
import { URI } from '@hydranium/langium';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { makeWorkspaceHarness, WORKSPACE_ROOT, type OrderFlowHarness } from './order-flow-harness.js';

/**
 * Copy a workspace file into a temp directory and build it there.
 *
 * The copy is not incidental: `update` drives a rebuild, and the integrity
 * service's default `'silent'` sync mode persists any repair with
 * `FileSystemProvider.writeFile`. Updating a file in place would therefore risk
 * rewriting the committed sample workspace, whose only intended error is
 * `orders/audit-leak.domain`.
 */
async function loadCopy(harness: OrderFlowHarness, relativePath: string): Promise<string> {
   const scratch = mkdtempSync(path.join(tmpdir(), 'order-flow-write-'));
   // Returns a URI string, not the directory, so ownership stays here. Kept on
   // failure because this copy is what `update` wrote — the artefact that says
   // what the write path actually produced. stderr, not `console`, because
   // vitest drops output written after the test body.
   onTestFinished(context => {
      if (context.task.result?.state === 'fail') {
         process.stderr.write(`[order-flow] kept the written copy at ${scratch}\n`);
         return;
      }
      rmSync(scratch, { recursive: true, force: true });
   });
   const copy = path.join(scratch, path.basename(relativePath));
   copyFileSync(path.join(WORKSPACE_ROOT, relativePath), copy);
   const uri = URI.file(copy);
   const document = await harness.shared.workspace.LangiumDocuments.getOrCreateDocument(uri);
   await harness.shared.workspace.DocumentBuilder.build([document], { validation: true });
   return uri.toString();
}

describe('order-flow structured write path — ModelService.update with a transfer model', () => {
   it('writes back a .process transfer model with every cross-reference intact', async () => {
      const harness = await makeWorkspaceHarness();
      const uri = await loadCopy(harness, 'orders/fulfillment.process');

      const before = harness.shared.workspace.LangiumDocuments.getDocument(URI.parse(uri));
      const transfer = harness.shared.model.TransferEncoder.toTransfer(before!.parseResult.value, 'grammar');

      // Round-trip the projection unchanged: any difference in the resulting text
      // is the write path corrupting it, not the edit.
      await harness.shared.model.ModelService.update({ uri, clientId: 'form-editor', model: transfer });

      const after = harness.shared.workspace.TextDocuments.get(uri)?.getText();
      expect(after).toBe(
         [
            'process Fulfillment for Order {',
            '   task Pay',
            '      writes Order.status = PAID',
            '   gateway PaymentOk',
            '      yes -> Pick',
            '      no -> Cancel',
            '   task Pick',
            '      reads Order.id',
            '   task Ship',
            '      writes Order.status = SHIPPED',
            '   task Cancel',
            '      writes Order.status = CANCELLED',
            '   transition Pay -> PaymentOk',
            '   transition Pick -> Ship',
            '}'
         ].join('\n')
      );
   });

   it('writes back a .layout transfer model with its cross-document reference intact', async () => {
      const harness = await makeWorkspaceHarness();
      const uri = await loadCopy(harness, 'orders/fulfillment.layout');

      const before = harness.shared.workspace.LangiumDocuments.getDocument(URI.parse(uri));
      const transfer = harness.shared.model.TransferEncoder.toTransfer(before!.parseResult.value, 'grammar');

      await harness.shared.model.ModelService.update({ uri, clientId: 'form-editor', model: transfer });

      // The layout survives the TRANSFER round-trip, where `LayoutModel.process`
      // and `DiagramNode.flowNode` are plain strings rather than Langium
      // references. Worth asserting and not only in AST mode: the emitter reads
      // them through `serializeReferenceText`, the one seam that has to answer for
      // both a Langium `Reference` and a bare string. Both references here point
      // ACROSS a document boundary, so a regression would produce `layout X for ` and
      // `node  at …` rather than a merely unresolved name.
      expect(harness.shared.workspace.TextDocuments.get(uri)?.getText()).toBe(
         [
            'layout FulfillmentLayout for Fulfillment {',
            '   node Pay at 40, 100 size 160, 60',
            '   node PaymentOk at 260, 90',
            '   node Pick at 440, 200 size 160, 60',
            '   node Ship at 660, 200 size 160, 60',
            '}'
         ].join('\n')
      );
   });

   it('routes per URI, so a .domain transfer model gets the .domain serializer', async () => {
      // The structured path resolves the serializer per URI. With two grammars a
      // routing mistake writes `.process` syntax into a `.domain` file, and the
      // AST-mode serializer tests cannot see it because they never go through
      // `update`.
      const harness = await makeWorkspaceHarness();
      const uri = await loadCopy(harness, 'commerce-core/money.domain');

      const before = harness.shared.workspace.LangiumDocuments.getDocument(URI.parse(uri));
      const transfer = harness.shared.model.TransferEncoder.toTransfer(before!.parseResult.value, 'grammar');

      await harness.shared.model.ModelService.update({ uri, clientId: 'form-editor', model: transfer });

      const after = harness.shared.workspace.TextDocuments.get(uri)?.getText();
      expect(after).toContain('public valuetype Money {');
      // The declared-type references are the part a transfer-mode emitter blanks;
      // a field left as `value: ` is the signature of that failure.
      expect(after).not.toMatch(/:\s*$/m);
   });

   it('leaves the on-disk file untouched — update is an in-memory edit, not a save', async () => {
      // Pins the update/save split: `save` persists, `update` does not. If this
      // ever starts failing, an unexpected disk write appeared in the update path
      // (the integrity write-back is the candidate) and the temp-copy guard above
      // is the only thing standing between it and the sample workspace.
      const harness = await makeWorkspaceHarness();
      const uri = await loadCopy(harness, 'orders/returns.process');
      const onDisk = readFileSync(URI.parse(uri).fsPath, 'utf8');

      const before = harness.shared.workspace.LangiumDocuments.getDocument(URI.parse(uri));
      const transfer = harness.shared.model.TransferEncoder.toTransfer(before!.parseResult.value, 'grammar');
      await harness.shared.model.ModelService.update({ uri, clientId: 'form-editor', model: transfer });

      expect(readFileSync(URI.parse(uri).fsPath, 'utf8')).toBe(onDisk);
   });
});
