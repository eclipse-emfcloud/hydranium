#!/usr/bin/env node
/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Test fixture: a standalone Node script that boots a {@link DataServer} over
 * stdio JSON-RPC. Run as an actual child process, so the wire crossing goes
 * through real OS pipes rather than the in-process Duplex pair the data-server's
 * own unit tests use.
 *
 * The services tree comes from {@link makeTestServices}; the one behaviour this
 * fixture adds on top of the stubs is the re-parse seam below.
 */

import { DataServer } from '@hydranium/data-server';
import { makeTestServices } from '@hydranium/core/testing';
import type { AstNode, URI } from '@hydranium/langium';
import { StreamMessageReader, StreamMessageWriter, createMessageConnection } from 'vscode-jsonrpc/node';

interface FakeRoot extends AstNode {
   readonly $type: 'FakeRoot';
   readonly name: string;
}

function parseFakeRoot(text: string): FakeRoot {
   const match = /^name:(.+)$/.exec(text);
   return { $type: 'FakeRoot', name: match ? match[1] : 'unknown' } as FakeRoot;
}

function main(): void {
   const bundle = makeTestServices<FakeRoot, never, FakeRoot>({
      serialize: (_uri, root) => `name:${root.name}`,
      seedDocuments: [
         {
            uri: 'file:///fixture/A.fake',
            root: { $type: 'FakeRoot', name: 'initial' } as FakeRoot
         },
         {
            // Echoes the log-level env var the child was spawned with, so the
            // subprocess-integration test can assert the CLI's `--log-level`
            // flag actually reaches the spawned server's environment.
            uri: 'file:///fixture/env.fake',
            root: { $type: 'FakeRoot', name: process.env.HYDRANIUM_LOG_LEVEL ?? 'unset' } as FakeRoot
         }
      ],
      seedProjects: [
         { id: 'fixture-p1', referenceName: 'fixture-p1', version: '1.0.0', dependencies: undefined },
         { id: 'fixture-p2', referenceName: 'fixture-p2', version: undefined, dependencies: ['fixture-p1'] }
      ]
   });

   // Re-parse seam: when DataServer.saveModelDocument fires DocumentBuilder.update
   // for a changed URI, replay the latest text into the LangiumDocuments registry
   // so the post-save `getModelDocument` return reflects the new content. A real
   // adopter's DocumentBuilder does this via Langium itself; the stub doesn't, so
   // the fixture supplies the equivalent here.
   const originalUpdate = bundle.documentBuilder.update.bind(bundle.documentBuilder);
   bundle.documentBuilder.update = async (changed: URI[], deleted: URI[]) => {
      await originalUpdate(changed, deleted);
      for (const uri of changed) {
         const uriStr = uri.toString();
         const recent = [...bundle.textDocuments.changes].reverse().find(change => change.uri === uriStr);
         if (recent) {
            bundle.documents.set(uri, parseFakeRoot(recent.text));
         }
      }
   };

   const connection = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));

   if (process.argv.includes('--exit-on-request')) {
      // Fail-fast fixture mode: read a full request (the reader parses the whole
      // message, so the parent's write completed — no partial-write race) then die
      // without replying. Exercises the CLI's `whenTerminated` premature-exit gate.
      connection.onRequest(() => process.exit(0));
      connection.listen();
      return;
   }

   new DataServer<FakeRoot>(connection, bundle.services);
   connection.listen();
   // The connection holds the event loop open via its message reader; we
   // don't need to wait on anything explicitly. SIGTERM from the parent
   // (the CLI's `shutdown()`) ends the process.
}

main();
