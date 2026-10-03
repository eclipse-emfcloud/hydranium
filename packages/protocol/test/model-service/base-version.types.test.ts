/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * What `baseVersion` admits and refuses — the whole point of branding the version
 * rather than declaring the field `number | 'any'`.
 *
 * The guarantees are type-level, so `typecheck:test` is what runs them — a
 * separate turbo task from `build`, which does not typecheck tests. Each
 * refusal is a `@ts-expect-error`, and an UNUSED one is itself an error, so a
 * clean compile proves every one of them fired. The acceptances carry no
 * directive and fail outright if the field narrows.
 *
 * Widening `BaseVersion` to accept a bare `number` reddens this file and nothing
 * else in the tree: every other suite passes versions that came out of a read,
 * so they stay green under the widening that removes the guarantee.
 */

import { describe, expect, it } from 'vitest';
import { asModelVersion, type BaseVersion } from '../../src/model-service/base-version';
import type { TransferUpdateDocumentArgs } from '../../src/data/requests';
import { TransferDocument } from '../../src/transfer-document';
import type { TransferElement } from '../../src/transfer-element';

interface Root extends TransferElement {
   $type: 'TypeOne';
}

const URI_A = 'file:///a.x';
const CLIENT = 'client-1';

/** Stands in for a live handle's counter: the same `number` type, read at write time. */
declare const liveVersion: number;

function typeAssertions(): void {
   const snapshot = TransferDocument.assertLoaded(
      TransferDocument.create<Root>(URI_A, 7, { $type: 'TypeOne' }, 'hash', [], { version: 8, hash: 'text', dirty: true })
   );

   // Accepted: the version a read returned, sent straight back.
   const fromRead: TransferUpdateDocumentArgs<Root> = {
      uri: URI_A,
      clientId: CLIENT,
      model: { $type: 'TypeOne' },
      baseVersion: snapshot.model.version
   };
   void fromRead;

   // Accepted: the explicit opt-out.
   const ungated: TransferUpdateDocumentArgs<Root> = {
      uri: URI_A,
      clientId: CLIENT,
      model: { $type: 'TypeOne' },
      baseVersion: 'any'
   };
   void ungated;

   // Accepted: branded, but still a number wherever one is wanted — so nothing
   // downstream has to unwrap it.
   const arithmetic: number = snapshot.model.version + 1;
   void arithmetic;
   const compared: boolean = snapshot.model.version > 0;
   void compared;

   // @ts-expect-error a version read off a live handle at write time. THE defect
   // this type exists to catch: it is whatever the server is at now, so the gate
   // would compare the server's version against itself and pass unconditionally
   const live: BaseVersion = liveVersion;
   void live;

   // @ts-expect-error the version of the text the server holds, which the model
   // can be behind: a write based on it passes the gate with older content
   const textVersion: BaseVersion = snapshot.text!.version;
   void textVersion;

   // @ts-expect-error a hand-written number is the same defect, spelled shorter
   const literal: BaseVersion = 7;
   void literal;

   // @ts-expect-error the opt-out is one specific word, not any string
   const misspelled: BaseVersion = 'unchecked';
   void misspelled;

   // @ts-expect-error omitting it is a compile error, which is why it is required
   const omitted: TransferUpdateDocumentArgs<Root> = { uri: URI_A, clientId: CLIENT, model: { $type: 'TypeOne' } };
   void omitted;

   // Accepted: the escape hatch, for a caller who genuinely knows the version's
   // provenance. Deliberately reachable, and deliberately this conspicuous.
   const forced: BaseVersion = asModelVersion(liveVersion);
   void forced;
}

describe('BaseVersion', () => {
   it('compiles, which is the assertion', () => {
      expect(typeAssertions).toBeTypeOf('function');
   });
});
