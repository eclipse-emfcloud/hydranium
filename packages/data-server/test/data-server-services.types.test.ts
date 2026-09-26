/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Which shared services a {@link DataServer} with its own diagnostic accepts.
 *
 * The guarantees are type-level, so `typecheck:test` is what runs them. The
 * refusal is a `@ts-expect-error`, and an UNUSED one is itself an error, so a
 * clean compile proves it fired.
 *
 * Narrowing the encoder with a cast in the constructor, over the plain
 * {@link ServerSharedServices}, reddens this file: the data-server would then
 * accept services whose encoder never produces the diagnostic it promises.
 */

import { describe, expect, it } from 'vitest';
import type { ServerSharedServices } from '@hydranium/core';
import type { Project, TransferDiagnostic, TransferElement } from '@hydranium/protocol';
import type { MessageConnection } from 'vscode-jsonrpc';
import { DataServer } from '../src/data-server.js';

/** A diagnostic carrying more than the framework's wire shape. */
interface TaggedDiagnostic extends TransferDiagnostic {
   tag: string;
}

declare const connection: MessageConnection;
declare const plainServices: ServerSharedServices;
declare const taggedServices: ServerSharedServices<Project, TaggedDiagnostic>;

function typeAssertions(): void {
   // Accepted: the default diagnostic over plain services, which is what every
   // caller that names no diagnostic writes.
   const plain = new DataServer<TransferElement>(connection, plainServices);
   void plain;

   // Accepted: services whose encoder declares the diagnostic the data-server
   // sends.
   const tagged = new DataServer<TransferElement, TaggedDiagnostic>(connection, taggedServices);
   void tagged;

   // @ts-expect-error plain services: their encoder promises only the default
   // diagnostic, so every envelope would claim a `tag` nothing produced
   const untagged = new DataServer<TransferElement, TaggedDiagnostic>(connection, plainServices);
   void untagged;
}

describe('DataServer shared services', () => {
   it('compiles, which is the assertion', () => {
      expect(typeAssertions).toBeTypeOf('function');
   });
});
