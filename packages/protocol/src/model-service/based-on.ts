/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

declare const snapshotMarker: unique symbol;

/**
 * A text-document version that came out of a SNAPSHOT read: a document
 * envelope's `version`, which cannot move once the envelope exists.
 *
 * A plain number at runtime, usable anywhere a number is, and it travels the
 * wire as one. The marker exists only so the compiler can tell it apart from a
 * version read off a LIVE document, which is the same number type and is the
 * defect the conflict gate exists to prevent: read at write time it is whatever
 * the server is at now, which is the number the gate is about to compare it
 * against, so the gate passes unconditionally and a concurrent edit is
 * overwritten with nothing logged.
 */
export type SnapshotVersion = number & { readonly [snapshotMarker]: true };

/**
 * What a write declares it was based on: a version from a snapshot read, or
 * `'anything'`.
 *
 * `'anything'` is a precondition that always holds — the write accepts whatever
 * the server currently has, and therefore overwrites it. It is the honest
 * answer wherever the write was authored against no particular server version,
 * and a lie anywhere a reader handed the writer a document. The field carrying
 * it is required, so an ungated write is a word someone chose rather than a
 * field someone forgot.
 */
export type BasedOn = SnapshotVersion | 'anything';

/**
 * Whether `basedOn` names a version, and so arms the gate.
 *
 * Branch on this rather than on `basedOn !== 'anything'`, which reads as "not
 * based on anything" — the opposite of what the branch tests.
 */
export function isSnapshotVersion(basedOn: BasedOn): basedOn is SnapshotVersion {
   return typeof basedOn === 'number';
}

/**
 * Mark a version as having come from a snapshot read.
 *
 * **For the envelope constructors, not for callers.** Every door that builds a
 * document envelope applies it on the way in, so anything a read returns
 * already carries it and a writer never needs this. A caller reaching for it is
 * asserting a provenance the compiler was about to deny — the read-late defect
 * written out where a reviewer can see it.
 */
export function asSnapshotVersion(version: number): SnapshotVersion {
   return version as SnapshotVersion;
}
