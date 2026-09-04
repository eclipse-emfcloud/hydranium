/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `isConnectionGoneError` — the predicate that decides whether a failed push to
 * a peer is routine teardown or a real fault.
 *
 * It exists because the condition arrives in two unrelated shapes whose typed
 * errors come from different classes and different code enums, so there is no
 * single discriminator to test. Both shapes are pinned here with the exact
 * `vscode-jsonrpc` wording, because the predicate is a **string match** and a
 * library rephrasing is precisely the regression that would silently reclassify
 * every shutdown as an error again.
 *
 * The negative cases matter as much: a predicate that answers `true` too often
 * downgrades genuine failures to `debug`, which is worse than the noise it was
 * written to remove.
 */

import { describe, expect, it } from 'vitest';
import { isConnectionGoneError } from '../../src/util/connection-liveness.js';

describe('isConnectionGoneError', () => {
   it('recognises a synchronous throw from throwIfClosedOrDisposed', () => {
      // What `sendRequest` / `sendNotification` / `RemoteConsole.send` raise.
      expect(isConnectionGoneError(new Error('Connection is disposed.'))).toBe(true);
      expect(isConnectionGoneError(new Error('Connection is closed.'))).toBe(true);
   });

   it('recognises the rejection of an already-issued request', () => {
      // A ResponseError from draining the pending-response map on teardown —
      // not a ConnectionError, which is why a check on the ConnectionError code
      // would miss it.
      expect(isConnectionGoneError(new Error('Pending response rejected since connection got disposed'))).toBe(true);
   });

   it('is case-insensitive, since the wording is not ours to fix', () => {
      expect(isConnectionGoneError(new Error('CONNECTION IS DISPOSED.'))).toBe(true);
   });

   it('accepts a non-Error rejection value', () => {
      expect(isConnectionGoneError('Connection is disposed.')).toBe(true);
   });

   it('does NOT classify a genuine failure as a gone connection', () => {
      // These must keep reaching `error`: downgrading them would hide the
      // failures the log line exists to report.
      expect(isConnectionGoneError(new Error('applyEdit rejected by the client'))).toBe(false);
      expect(isConnectionGoneError(new Error('Request failed: invalid params'))).toBe(false);
      expect(isConnectionGoneError(undefined)).toBe(false);
   });

   it('does not match an unrelated "disposed" that is not about the connection', () => {
      // Anchoring on `connection` is what keeps a disposed document, model or
      // registry from being read as a dead peer.
      expect(isConnectionGoneError(new Error('Document is disposed'))).toBe(false);
      expect(isConnectionGoneError(new Error('This model has been disposed'))).toBe(false);
   });
});
