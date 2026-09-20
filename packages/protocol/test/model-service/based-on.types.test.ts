/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * What `basedOn` admits and refuses — the whole point of branding the version
 * rather than declaring the field `number | 'anything'`.
 *
 * The guarantees are type-level, so `typecheck:test` is what runs them — a
 * separate turbo task from `build`, which does not typecheck tests. Each
 * refusal is a `@ts-expect-error`, and an UNUSED one is itself an error, so a
 * clean compile proves every one of them fired. The acceptances carry no
 * directive and fail outright if the field narrows.
 *
 * Widening `BasedOn` to accept a bare `number` reddens this file and nothing
 * else in the tree: every other suite passes versions that came out of a read,
 * so they stay green under the widening that removes the guarantee.
 */

import { describe, expect, it } from 'vitest';
import { asSnapshotVersion, type BasedOn } from '../../src/model-service/based-on';
import type { TransferUpdateArgs } from '../../src/model-service/args';
import { TransferDocument } from '../../src/transfer-document';
import type { TransferElement } from '../../src/transfer-element';

interface Root extends TransferElement {
   $type: 'TypeOne';
}

const URI_A = 'file:///a.x';

/** Stands in for a live handle's counter: the same `number` type, read at write time. */
declare const liveVersion: number;

function typeAssertions(): void {
   const snapshot = TransferDocument.create<Root>(URI_A, 7, { $type: 'TypeOne' });

   // Accepted: the version a read returned, sent straight back.
   const fromRead: TransferUpdateArgs<Root> = {
      uri: URI_A,
      clientId: 'client',
      model: { $type: 'TypeOne' },
      basedOn: snapshot.version
   };
   void fromRead;

   // Accepted: the explicit opt-out.
   const ungated: TransferUpdateArgs<Root> = {
      uri: URI_A,
      clientId: 'client',
      model: { $type: 'TypeOne' },
      basedOn: 'anything'
   };
   void ungated;

   // Accepted: branded, but still a number wherever one is wanted — so nothing
   // downstream has to unwrap it.
   const arithmetic: number = snapshot.version + 1;
   void arithmetic;
   const compared: boolean = snapshot.version > 0;
   void compared;

   // @ts-expect-error a version read off a live handle at write time. THE defect
   // this type exists to catch: it is whatever the server is at now, so the gate
   // would compare the server's version against itself and pass unconditionally
   const live: BasedOn = liveVersion;
   void live;

   // @ts-expect-error a hand-written number is the same defect, spelled shorter
   const literal: BasedOn = 7;
   void literal;

   // @ts-expect-error the opt-out is one specific word, not any string
   const misspelled: BasedOn = 'unchecked';
   void misspelled;

   // @ts-expect-error omitting it is a compile error, which is why it is required
   const omitted: TransferUpdateArgs<Root> = { uri: URI_A, clientId: 'client', model: { $type: 'TypeOne' } };
   void omitted;

   // Accepted: the escape hatch, for a caller who genuinely knows the version's
   // provenance. Deliberately reachable, and deliberately this conspicuous.
   const forced: BasedOn = asSnapshotVersion(liveVersion);
   void forced;
}

describe('BasedOn', () => {
   it('compiles, which is the assertion', () => {
      expect(typeAssertions).toBeTypeOf('function');
   });
});
