/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A client that read the model of a text that does not parse, over the data
 * head's wire against the real stack: its save of that model is refused, and
 * the file keeps the text the parser skipped.
 */

import { readFileSync } from 'node:fs';
import { DataServer } from '@hydranium/data-server';
import { makeDataServerHarness, type DataServerHarness } from '@hydranium/data-server/testing';
import { isDocumentSyntaxError } from '@hydranium/protocol';
import { afterEach, expect, it } from 'vitest';
import type { DomainModel } from '@hydranium/example-order-flow-protocol';
import { makeScratchWorkspaceHarness, type ScratchOrderFlowHarness } from './order-flow-harness.js';

const FILE = 'syntax-error.domain';
// `b` lost its type: a model read from this parse has no `b`.
const WITH_SYNTAX_ERROR = 'entity Solo {\n   a : string\n   b :\n}\n';

let scratch: ScratchOrderFlowHarness | undefined;
let head: DataServerHarness<DataServer<DomainModel>, DomainModel> | undefined;

afterEach(() => {
   head?.dispose();
   head = undefined;
   scratch?.workspace.dispose();
   scratch = undefined;
});

it.each([
   ['', {}],
   [' even when marked as a restore', { restore: true }]
])('refuses to save a model read from a text that does not parse%s, and the file keeps that text', async (_label, marks) => {
   scratch = await makeScratchWorkspaceHarness(workspace => workspace.write(FILE, WITH_SYNTAX_ERROR));
   const shared = scratch.harness.shared;
   head = makeDataServerHarness<DataServer<DomainModel>, DomainModel>({ server: channel => new DataServer<DomainModel>(channel, shared) });
   const uri = scratch.workspace.uri(FILE);
   await head.proxy.createSession({ clientId: 'form' });
   await head.proxy.openModelDocument({ uri, clientId: 'form' });
   const { model } = await head.proxy.getModelDocument({ uri });

   // Not a literal: a save's args have no `restore`, which only a client off the typed API sends.
   const args = { uri, clientId: 'form', model: model!.root, baseVersion: model!.version, ...marks };
   const save = head.proxy.saveModelDocument(args);

   await expect(save).rejects.toSatisfy(isDocumentSyntaxError);
   expect(readFileSync(scratch.workspace.resolve(FILE), 'utf8')).toBe(WITH_SYNTAX_ERROR);
});

it.each([
   ['empty', ''],
   ['blank', '  \n']
])('writes a model over %s text that does not parse, since the write deletes none', async (_label, text) => {
   scratch = await makeScratchWorkspaceHarness(workspace => {
      workspace.write('solo.domain', 'entity Solo {\n   a : string\n}\n');
      workspace.write('valid.process', 'process Valid for Solo {\n}\n');
      workspace.write('target.process', text);
   });
   const shared = scratch.harness.shared;
   head = makeDataServerHarness<DataServer<DomainModel>, DomainModel>({ server: channel => new DataServer<DomainModel>(channel, shared) });
   const uri = scratch.workspace.uri('target.process');
   await head.proxy.createSession({ clientId: 'form' });
   await head.proxy.openModelDocument({ uri: scratch.workspace.uri('valid.process'), clientId: 'form' });
   const opened = await head.proxy.openModelDocument({ uri, clientId: 'form' });
   const { model: valid } = await head.proxy.getModelDocument({ uri: scratch.workspace.uri('valid.process') });

   await head.proxy.updateModelDocument({ uri, clientId: 'form', model: valid!.root, baseVersion: opened.model!.version });

   expect(shared.workspace.TextDocuments.get(uri)?.getText()).toContain('process Valid for Solo');
});
