/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { randomUuid } from '@hydranium/protocol';
// Not the `@theia/core/lib/browser` barrel, which touches DOM globals at load.
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { injectable, type interfaces } from '@theia/core/shared/inversify';

/** The `sessionStorage` key of the window's {@link WindowSession}. */
export const WINDOW_SESSION_KEY = 'hydranium.glsp.windowSession';
/** Holds the id of the window session the last page in the tab left, for the next page to take up. */
export const RELEASED_WINDOW_SESSION_KEY = 'hydranium.glsp.releasedWindowSession';

/** The window's part of every diagram client id it opens, and the token its diagrams resume with. */
export interface WindowSession {
   readonly id: string;
   readonly resumeToken: string;
}

export function isWindowSession(value: unknown): value is WindowSession {
   return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as WindowSession).id === 'string' &&
      typeof (value as WindowSession).resumeToken === 'string'
   );
}

export const WindowSessionService = Symbol('WindowSessionService');

/**
 * The page's window session: the one the last page in this tab left, so a
 * reload resumes its diagrams, and a new one otherwise.
 *
 * A reload only has a session to resume on a server that outlives the page; a
 * server started per frontend, as a Theia plugin host's is, is new after one.
 */
export interface WindowSessionService {
   current(): WindowSession;
}

/**
 * Keeps the window session in `sessionStorage` and hands it on only as the page
 * leaves. A duplicated tab copies `sessionStorage` while the original page is
 * still live, so the copy finds no released session and draws its own; taking
 * the original's would end the original's diagram sessions. Where
 * `sessionStorage` is unavailable the session lasts for the page, and a reload
 * resumes nothing.
 *
 * Claimed as the frontend starts, not with the first diagram: until then the
 * released mark stays, and a tab duplicated meanwhile would take it too. A page
 * restored from the back-forward cache takes the mark back, since Theia
 * before 1.75 leaves it live without a reload.
 */
@injectable()
export class DefaultWindowSessionService implements WindowSessionService, FrontendApplicationContribution {
   protected session?: WindowSession;

   initialize(): void {
      this.current();
   }

   current(): WindowSession {
      this.session ??= this.claim();
      return this.session;
   }

   protected claim(): WindowSession {
      const created: WindowSession = { id: randomUuid(), resumeToken: randomUuid() };
      try {
         const storage = globalThis.sessionStorage;
         const stored = this.parse(storage.getItem(WINDOW_SESSION_KEY));
         const session = stored && storage.getItem(RELEASED_WINDOW_SESSION_KEY) === stored.id ? stored : created;
         storage.setItem(WINDOW_SESSION_KEY, JSON.stringify(session));
         storage.removeItem(RELEASED_WINDOW_SESSION_KEY);
         globalThis.addEventListener?.('pagehide', () => storage.setItem(RELEASED_WINDOW_SESSION_KEY, session.id));
         globalThis.addEventListener?.('pageshow', event => {
            if ((event as PageTransitionEvent).persisted) {
               storage.removeItem(RELEASED_WINDOW_SESSION_KEY);
            }
         });
         return session;
      } catch {
         return created;
      }
   }

   protected parse(text: string | null): WindowSession | undefined {
      try {
         const value: unknown = text ? JSON.parse(text) : undefined;
         return isWindowSession(value) ? value : undefined;
      } catch {
         return undefined;
      }
   }
}

/**
 * Bind {@link WindowSessionService} once per container, and claim it as the
 * frontend starts. An adopter rebinds {@link WindowSessionService}.
 */
export function bindWindowSessionService(bind: interfaces.Bind, isBound: interfaces.IsBound): void {
   if (!isBound(WindowSessionService)) {
      bind(DefaultWindowSessionService).toSelf().inSingletonScope();
      bind(WindowSessionService).toService(DefaultWindowSessionService);
      bind(FrontendApplicationContribution).toService(WindowSessionService);
   }
}
