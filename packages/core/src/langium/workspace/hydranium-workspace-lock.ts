/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DefaultWorkspaceLock, type MaybePromise } from '@hydranium/langium';
import { type CancellationToken } from 'vscode-languageserver-protocol';
import { runInWriteLockScope } from './write-lock-scope.js';

/**
 * Langium's {@link DefaultWorkspaceLock} with the write action marked as a
 * write-lock scope, so anything it reaches can be asked whether the lock is
 * already held (see `isInsideWriteLock`).
 *
 * The wrapping has to live HERE rather than at the facade's own `write` call
 * sites, because the holders worth detecting are mostly not the facade: Langium's
 * `DefaultWorkspaceManager.initialized` and `DefaultDocumentUpdateHandler` both
 * take this lock, and the reentrant shape that matters is an integrity rule or
 * build-phase pass running *inside* one of those builds and writing back through
 * the facade. Marking the scope at the lock covers every holder, present and
 * future, including an adopter's own `write` calls.
 *
 * `read` is deliberately NOT marked. Read actions do not cancel a running holder,
 * so reaching the facade from inside one is not the hazard, and marking them
 * would turn ordinary read-then-write sequences into false positives.
 */
export class HydraniumWorkspaceLock extends DefaultWorkspaceLock {
   override write(action: (token: CancellationToken) => MaybePromise<void>): Promise<void> {
      return super.write(token => runInWriteLockScope(() => action(token)));
   }
}
