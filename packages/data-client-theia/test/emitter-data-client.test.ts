/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { ProjectsChangedEvent, TransferDocumentSavedEvent, TransferDocumentUpdatedEvent, TransferElement } from '@hydranium/protocol';
import { EmitterDataClient } from '../src/common/emitter-data-client';

interface FakeRoot extends TransferElement {
   readonly $type: 'FakeRoot';
}

const updateEvent = { document: { uri: 'a' }, sourceClientId: 'c', reason: 'changed' } as unknown as TransferDocumentUpdatedEvent<FakeRoot>;
const saveEvent = { document: { uri: 'a' }, sourceClientId: 'c' } as unknown as TransferDocumentSavedEvent<FakeRoot>;
const projectEvent = { project: { id: 'p' }, reason: 'added' } as unknown as ProjectsChangedEvent;

describe('EmitterDataClient', () => {
   it('fans each inbound notification out to its paired Event', () => {
      const client = new EmitterDataClient<FakeRoot>();
      const updates: unknown[] = [];
      const saves: unknown[] = [];
      const projects: unknown[] = [];
      client.onDidUpdateDocument(event => updates.push(event));
      client.onDidSaveDocument(event => saves.push(event));
      client.onDidChangeProjects(event => projects.push(event));

      client.onDocumentUpdated(updateEvent);
      client.onDocumentSaved(saveEvent);
      client.onProjectsChanged(projectEvent);

      expect(updates).toEqual([updateEvent]);
      expect(saves).toEqual([saveEvent]);
      expect(projects).toEqual([projectEvent]);
   });

   it('lets a subclass alias a channel under a domain name', () => {
      class Sub extends EmitterDataClient<FakeRoot> {
         readonly onModelsChange = this.onDidChangeProjects;
      }
      const sub = new Sub();
      const aliased: unknown[] = [];
      sub.onModelsChange(event => aliased.push(event));

      sub.onProjectsChanged(projectEvent);

      expect(aliased).toEqual([projectEvent]);
   });
});
