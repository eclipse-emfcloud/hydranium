/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import { LogLevel } from '@eclipse-glsp/client';
import { AbstractLogger, type LogLevel as HydraniumLogLevel, Logger } from '@hydranium/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SprottyLoggerAdapter } from '../src/sprotty-logger-adapter';

class Viewer {}
class SetModelCommand {}

interface Line {
   readonly level: HydraniumLogLevel;
   readonly component?: string;
   readonly message: string;
   readonly args: readonly unknown[];
}

/**
 * A real `AbstractLogger`, so `for`, `sub` and `with` carry their real
 * component semantics: a double that records the name it was handed cannot
 * tell a nested tag from a replaced one.
 */
class CapturingLogger extends AbstractLogger {
   constructor(
      readonly lines: Line[],
      component?: string
   ) {
      super(component);
   }

   protected emit(level: HydraniumLogLevel, _label: string, message: string, args: readonly unknown[]): void {
      this.lines.push({ level, component: this.component, message, args });
   }

   protected derive(component: string): this {
      return new CapturingLogger(this.lines, component) as this;
   }
}

/** The adapter over a host logger already tagged, as the browser page tags its. */
function makeAdapter(): { adapter: SprottyLoggerAdapter; lines: Line[] } {
   const lines: Line[] = [];
   const adapter = new SprottyLoggerAdapter();
   Object.assign(adapter, { logger: new CapturingLogger(lines).with('GLSP client') });
   return { adapter, lines };
}

describe('SprottyLoggerAdapter', () => {
   let previousLevel: ReturnType<typeof Logger.getLevel>;
   beforeEach(() => {
      previousLevel = Logger.getLevel();
      Logger.setLevel('trace');
   });
   afterEach(() => {
      Logger.setLevel(previousLevel);
   });

   it("nests the calling class under the host's own tag and forwards an error's parameters whole", () => {
      const { adapter, lines } = makeAdapter();
      adapter.error(new Viewer(), 'No view registered', 'type-one');
      expect(lines).toEqual([{ level: 'error', component: 'GLSP client :: Viewer', message: 'No view registered', args: ['type-one'] }]);
   });

   it('forwards a warning with its parameters whole', () => {
      const { adapter, lines } = makeAdapter();
      adapter.warn(new Viewer(), 'Unknown element', { id: 'one' });
      expect(lines).toEqual([{ level: 'warn', component: 'GLSP client :: Viewer', message: 'Unknown element', args: [{ id: 'one' }] }]);
   });

   it("prefixes the message with the sentence sprotty's layout registry passes as the caller", () => {
      // sprotty's `logger.warn('Layout kind is already defined: ', layout.layoutKind)`.
      const { adapter, lines } = makeAdapter();
      adapter.warn('Layout kind is already defined: ', 'hbox');
      expect(lines).toEqual([{ level: 'warn', component: 'GLSP client', message: 'Layout kind is already defined: hbox', args: [] }]);
   });

   it('demotes info to debug, naming its parameters rather than forwarding them', () => {
      const { adapter, lines } = makeAdapter();
      adapter.info(new Viewer(), 'Dispatched feedback', { kind: 'whole-model', children: [] });
      expect(lines).toEqual([{ level: 'debug', component: 'GLSP client :: Viewer', message: 'Dispatched feedback whole-model', args: [] }]);
   });

   it("raises GLSP's silently resolved request timeout to warn", () => {
      const { adapter, lines } = makeAdapter();
      adapter.info(new Viewer(), 'Request one (requestModel) time out after 2000ms.');
      expect(lines.map(line => line.level)).toEqual(['warn']);
   });

   it('demotes log to trace, naming an action by its kind and an object by its class', () => {
      const { adapter, lines } = makeAdapter();
      adapter.log(new Viewer(), 'Handle', { kind: 'requestModel', requestId: 'one' });
      adapter.log(new Viewer(), 'Executing', new SetModelCommand());
      expect(lines.map(line => [line.level, line.message])).toEqual([
         ['trace', 'Handle requestModel'],
         ['trace', 'Executing SetModelCommand']
      ]);
   });

   it('names the action inside the message GLSP sends, so the outgoing half reads as the incoming one', () => {
      const { adapter, lines } = makeAdapter();
      adapter.log(new Viewer(), 'sending', { clientId: 'one', action: { kind: 'requestModel' } });
      expect(lines.map(line => line.message)).toEqual(['sending requestModel']);
   });

   it('formats no line that the threshold would drop', () => {
      // `log` and `info` run on every action and render; the line must not be
      // built only to be discarded by the host logger.
      Logger.setLevel('info');
      const { adapter, lines } = makeAdapter();
      const formatMessage = vi.spyOn(adapter as unknown as { formatMessage: () => string }, 'formatMessage');
      adapter.log(new Viewer(), 'Handle', { kind: 'requestModel' });
      adapter.info(new Viewer(), 'Dispatched feedback');
      expect(formatMessage).not.toHaveBeenCalled();
      expect(lines).toEqual([]);
   });

   it('survives a parameter with no prototype', () => {
      const { adapter, lines } = makeAdapter();
      adapter.log(new Viewer(), 'Handle', Object.create(null));
      expect(lines.map(line => line.message)).toEqual(['Handle']);
   });

   it('derives one logger per calling class', () => {
      const { adapter, lines } = makeAdapter();
      adapter.warn(new Viewer(), 'one');
      adapter.warn(new Viewer(), 'two');
      expect(lines.map(line => line.component)).toEqual(['GLSP client :: Viewer', 'GLSP client :: Viewer']);
      expect((adapter as unknown as { loggers: Map<string, unknown> }).loggers.size).toBe(1);
   });

   it("logs under the host's own tag when the caller is neither an object nor a sentence", () => {
      const { adapter, lines } = makeAdapter();
      adapter.error(undefined, 'failed');
      expect(lines).toEqual([{ level: 'error', component: 'GLSP client', message: 'failed', args: [] }]);
   });

   it("lets the framework threshold filter by reporting sprotty's most verbose level", () => {
      expect(makeAdapter().adapter.logLevel).toBe(LogLevel.log);
   });
});
