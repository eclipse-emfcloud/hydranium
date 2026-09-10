#!/usr/bin/env node
/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Standalone entry point: a data-server head on **stdio**, with no LSP head in
// the process. This is the transport `hydranium-cli` speaks — `query`, `save`,
// `projects` and `watch` all spawn a server command and drive JSON-RPC over its
// stdin/stdout — so it is what makes those subcommands usable against this
// language.
//
// Invocation: `node lib/data-server-main.js [<workspace-path>]`, or the
// package's `bookstore-data-server` bin script. The workspace path defaults to
// the process cwd, which is what the CLI's `--cwd` sets on the child.
//
// Contrast with `main.ts`, the editor entry: there the LSP head owns stdio and
// the data head is a socket published over the LSP connection. Here there is no
// LSP connection at all, so the workspace initialization an
// `initialize`/`initialized` pair would otherwise drive has to happen here —
// which is why this entry uses `startStdioServer` rather than wiring a
// connection directly.
//
// Everything here runs at module scope, so this file is an executable rather
// than a library entry — import `./index.js` instead to compose the language.

import { NodeFileSystem, startStdioServer } from '@hydranium/core/node';
import { DataServer } from '@hydranium/data-server';
// The TRANSFER root, not the AST one — same reasoning as `main.ts`.
import type { BookstoreModel } from './language-server/generated-hydranium/transfer-model.js';
import { createBookstoreServices } from './language-server/bookstore-module.js';

const { shared } = createBookstoreServices({ ...NodeFileSystem });

// `startStdioServer` owns the transport AND the workspace bring-up, including
// the ordering between them: a head with no LSP connection never receives
// `initialize`/`initialized`, and initialization has to complete before the
// reader is attached or a request arriving during startup races an unpopulated
// project registry. The launcher exists so no adopter has to re-derive that
// ordering by hand.
const server = startStdioServer(
   {
      shared,
      // Defaults to the process cwd, which is what the CLI's `--cwd` sets on the
      // spawned child; an explicit path argument overrides it.
      workspace: process.argv[2] ?? process.cwd(),
      logger: shared.Logger,
      logTag: 'ModelServer'
   },
   connection => {
      new DataServer<BookstoreModel>(connection, shared);
      // The DataServer self-cleans via `connection.onClose`, so there is nothing
      // extra to tear down here.
      return { dispose: () => undefined };
   }
);

// Surfaces a failed bring-up as a non-zero exit instead of a silent, listening
// head that would answer against an empty workspace.
server.started.catch(() => process.exit(1));
