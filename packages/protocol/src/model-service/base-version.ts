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
 * The version of the text a model was parsed from: a snapshot of the store's
 * {@link TextVersion}, not a counter of its own. A document envelope carries
 * it, and it cannot move once the envelope exists.
 *
 * A plain number at runtime, usable anywhere a number is, and it travels the
 * wire as one. The marker exists only so the compiler can tell it apart from a
 * version read off a LIVE document, which is the same number type and is the
 * defect the conflict gate exists to prevent: read at write time it is whatever
 * the server is at now, which is the number the gate is about to compare it
 * against, so the gate passes unconditionally and a concurrent edit is
 * overwritten with nothing logged.
 */
export type ModelVersion = number & { readonly [snapshotMarker]: true };

/**
 * The store's version of a document's text, which moves with every change of it.
 * Unbranded, so a write refuses it as `baseVersion`: it can name text newer than
 * the caller's model, and a write based on it would pass the gate with older content.
 */
export type TextVersion = number;

/**
 * The version a write was authored against, from a snapshot read, or `'any'`: a
 * precondition that always holds, so the write overwrites whatever the server has.
 * `'any'` is a lie for a write authored against a document a read handed over.
 */
export type BaseVersion = ModelVersion | 'any';

/** Whether `baseVersion` names a version, and so arms the gate. */
export function isModelVersion(baseVersion: BaseVersion): baseVersion is ModelVersion {
   return typeof baseVersion === 'number';
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
export function asModelVersion(version: number): ModelVersion {
   return version as ModelVersion;
}

/**
 * The model version of a root no document factory path built, so nothing
 * records the text it came from. No write matches it, so a write based on it
 * conflicts.
 */
export const UNRECORDED_VERSION: ModelVersion = asModelVersion(-2);

/**
 * The model version of a root parsed from text the store holds under no
 * version: the file, read while the store held the document open with other
 * text. Below every text version, so the model reads as behind and a write
 * based on it conflicts.
 */
export const STALE_VERSION: ModelVersion = asModelVersion(-1);
