/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { type ActionMessage, type Operation } from '@eclipse-glsp/server';
import { asModelVersion, ConflictError, DocumentSyntaxError, SaveFailedError } from '@hydranium/protocol';
import { HydraniumGlspOperationActionHandler } from '../src/command/hydranium-glsp-operation-action-handler.js';
import { makeNoopGlspLogger } from '../src/testing/make-noop-glsp-logger.js';

/** A handler whose log and client are recorded, built without a container. */
class RecordingHandler extends HydraniumGlspOperationActionHandler {
   readonly errors: string[] = [];
   readonly warnings: string[] = [];
   readonly debugs: string[] = [];
   readonly sent: ActionMessage[] = [];
   /** The state's session, open until {@link closeDiagram}, as the storage leaves it. */
   readonly state: { clientId: string; modelSession?: object } = { clientId: 'client_1', modelSession: {} };

   constructor() {
      super([]);
      const logger = makeNoopGlspLogger();
      logger.error = (message: string, ...params: unknown[]): void => void this.errors.push([message, ...params.map(String)].join(' '));
      logger.warn = (message: string, ...params: unknown[]): void => void this.warnings.push([message, ...params.map(String)].join(' '));
      logger.debug = (message: string): void => void this.debugs.push(message);
      Object.assign(this, {
         logger,
         modelState: this.state,
         sharedServices: { MessageRenderer: { renderError: (error: Error) => `rendered: ${error.message}` } },
         clientProxy: { process: (message: ActionMessage): void => void this.sent.push(message) }
      });
   }

   fail(error: unknown): void {
      this.reportFailure({ kind: 'someOperation', isOperation: true } as Operation, error);
   }

   /** End the diagram's session, as the storage's dispose does. */
   closeDiagram(): void {
      this.state.modelSession = undefined;
   }
}

describe('HydraniumGlspOperationActionHandler.reportFailure', () => {
   it('logs a failure once, with its stack, and reports it to the client', () => {
      const handler = new RecordingHandler();
      handler.fail(new Error('boom'));
      expect(handler.errors).toHaveLength(1);
      expect(handler.errors[0]).toMatch(/someOperation[\s\S]*boom[\s\S]*\n\s+at /);
      expect(handler.sent.map(message => message.action.kind)).toEqual(['message']);
   });

   it("heads the notification with a typed error's rendered message", () => {
      const handler = new RecordingHandler();
      const error = new SaveFailedError([{ uri: 'file:///a.x', reason: 'disk full' }]);
      handler.fail(error);
      expect(handler.sent[0].action).toMatchObject({ message: `rendered: ${error.message}`, details: String(error) });
   });

   it('warns for a conflict, which is declined rather than failed, naming both versions', () => {
      const handler = new RecordingHandler();
      handler.fail(new ConflictError('file:///a.x', asModelVersion(1), 2));
      expect(handler.errors).toEqual([]);
      expect(handler.warnings).toHaveLength(1);
      expect(handler.warnings[0]).toContain('model v1 / text v2');
   });

   it('logs a conflict wrapped as the cause of a failure as an error, still naming both versions', () => {
      const handler = new RecordingHandler();
      handler.fail(new Error('refused after a step', { cause: new ConflictError('file:///a.x', asModelVersion(1), 2) }));
      expect(handler.warnings).toEqual([]);
      expect(handler.errors).toHaveLength(1);
      expect(handler.errors[0]).toContain('model v1 / text v2');
   });

   it('warns without a stack for a write to a document that does not parse, which is declined too', () => {
      const handler = new RecordingHandler();
      handler.fail(new DocumentSyntaxError('file:///a.x'));
      expect(handler.errors).toEqual([]);
      expect(handler.warnings).toHaveLength(1);
      expect(handler.warnings[0]).not.toMatch(/\n\s+at /);
   });

   it('logs a queued operation that fails once its diagram has closed at debug, and tells no client', () => {
      const handler = new RecordingHandler();
      handler.closeDiagram();
      handler.fail(new Error('No client session is registered for client_1; the diagram cannot write'));
      expect({ errors: handler.errors, warnings: handler.warnings, sent: handler.sent }).toEqual({ errors: [], warnings: [], sent: [] });
      expect(handler.debugs.some(line => line.includes('someOperation'))).toBe(true);
   });
});
