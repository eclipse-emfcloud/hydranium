/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { Container } from '@theia/core/shared/inversify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindWindowSessionService, DefaultWindowSessionService, WindowSessionService } from '../../src/browser/window-session.js';

/** A tab's `sessionStorage`, and the `pagehide` / `pageshow` listeners of the pages loaded in it. */
function makeTab(items = new Map<string, string>()): { items: Map<string, string>; leave(): void; restore(): void } {
   const listeners = new Map<string, Array<(event: unknown) => void>>();
   vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key)
   });
   vi.stubGlobal('addEventListener', (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
   });
   const fire = (type: string, event: unknown): void => listeners.get(type)?.forEach(listener => listener(event));
   return {
      items,
      leave: () => fire('pagehide', { persisted: true }),
      // Back from the back-forward cache without a reload, as Theia before 1.75 leaves it.
      restore: () => fire('pageshow', { persisted: true })
   };
}

/** A page's frontend starting: its service claims the window session. */
function startPage(): DefaultWindowSessionService {
   const service = new DefaultWindowSessionService();
   service.initialize();
   return service;
}

describe('DefaultWindowSessionService', () => {
   afterEach(() => {
      vi.unstubAllGlobals();
   });

   it('is the same for every diagram of a page', () => {
      makeTab();
      const page = startPage();

      expect(page.current()).toBe(page.current());
   });

   it('claims nothing until the frontend starts it', () => {
      const tab = makeTab();

      new DefaultWindowSessionService();

      expect(tab.items.size).toBe(0);
   });

   it('takes up the session the last page in the tab left, so a reload resumes', () => {
      const tab = makeTab();
      const first = startPage().current();
      tab.leave();

      makeTab(tab.items);
      expect(startPage().current()).toEqual(first);
   });

   it('draws its own session in a tab duplicated from a reloaded page that opened no diagram yet', () => {
      const tab = makeTab();
      const left = startPage().current();
      tab.leave();
      const reloaded = startPage();

      makeTab(new Map(tab.items));
      const copy = startPage().current();

      expect(reloaded.current()).toEqual(left);
      expect(copy.id).not.toBe(left.id);
   });

   it('draws its own session in a duplicated tab, whose original page is still open', () => {
      const tab = makeTab();
      const original = startPage().current();

      makeTab(new Map(tab.items));
      const copy = startPage().current();

      expect(copy.id).not.toBe(original.id);
      expect(copy.resumeToken).not.toBe(original.resumeToken);
   });

   it('keeps its session for a page back from the back-forward cache, so a tab duplicated after draws its own', () => {
      const tab = makeTab();
      const page = startPage().current();
      tab.leave();
      tab.restore();

      makeTab(new Map(tab.items));
      const copy = startPage().current();

      expect(copy.id).not.toBe(page.id);
   });

   it('draws a session outside a secure context, where crypto has no randomUUID', () => {
      makeTab();
      vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });

      const session = startPage().current();

      expect(session.id).not.toBe(session.resumeToken);
   });
});

describe('bindWindowSessionService', () => {
   it('binds one service that the frontend starts, and leaves a rebinding alone', () => {
      const container = new Container();
      bindWindowSessionService(container.bind.bind(container), container.isBound.bind(container));
      bindWindowSessionService(container.bind.bind(container), container.isBound.bind(container));

      const service = container.get<WindowSessionService>(WindowSessionService);
      expect(container.getAll(FrontendApplicationContribution)).toEqual([service]);

      const rebound = { current: () => ({ id: 'own', resumeToken: 'own' }) };
      container.rebind(WindowSessionService).toConstantValue(rebound);
      expect(container.getAll(FrontendApplicationContribution)).toEqual([rebound]);
   });
});
