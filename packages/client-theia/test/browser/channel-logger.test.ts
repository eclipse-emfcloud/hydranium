/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Stub out the Theia OutputChannel module before importing the SUT. The real
// module transitively pulls in `@theia/monaco` → `@lumino/widgets` → DOM globals,
// which aren't available under Vitest's node environment. The SUT only uses
// `OutputChannelManager` as an Inversify @inject token at runtime; a plain class
// stand-in is enough.
vi.mock('@theia/output/lib/browser/output-channel', () => ({
   OutputChannelManager: class OutputChannelManager {},
   OutputChannel: class OutputChannel {}
}));

import { Logger } from '@hydranium/protocol';
import { type OutputChannelManager } from '@theia/output/lib/browser/output-channel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelLogger, ChannelLoggerOptions, bindChannelLogger, getRequestParentName } from '../../src/browser/channel-logger';
import { type StubOutputChannelManager, makeStubInversifyContext, makeStubOutputChannelManager } from '../../src/testing/index';

/** Build a `ChannelLogger` directly (bypassing Inversify) over a stub channel manager. */
function makeLogger(channels: StubOutputChannelManager, options: ChannelLoggerOptions): ChannelLogger {
   return new ChannelLogger(channels as unknown as OutputChannelManager, options);
}

describe('ChannelLogger', () => {
   let channels: StubOutputChannelManager;

   beforeEach(() => {
      channels = makeStubOutputChannelManager();
      Logger.setLevel('trace');
   });

   afterEach(() => {
      Logger.setLevel('info');
   });

   it('emits to the channel matching channelName', () => {
      const logger = makeLogger(channels, { channelName: 'MyChannel' });
      logger.info('hello');
      const lines = channels.channels.get('MyChannel')?.lines ?? [];
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^\[Info\s+- \d{2}:\d{2}:\d{2}\.\d{3}] hello$/);
   });

   it('formats the component segment when set via options', () => {
      const logger = makeLogger(channels, { channelName: 'Ch', component: 'MyClass' });
      logger.warn('uh oh');
      expect(channels.channels.get('Ch')?.lines[0]).toMatch(/^\[Warn\s+- \d{2}:\d{2}:\d{2}\.\d{3}] \[MyClass] uh oh$/);
   });

   it('derive() returns a free instance pinning the same channelName', () => {
      const logger = makeLogger(channels, { channelName: 'Shared' });
      const sub = logger.for('Component');
      expect(sub).not.toBe(logger);
      sub.info('sub-line');
      // Sub should write to the same channel.
      expect(channels.channels.get('Shared')?.lines[0]).toContain('[Component] sub-line');
   });

   it('threshold gating suppresses lines below the configured level', () => {
      Logger.setLevel('warn');
      const logger = makeLogger(channels, { channelName: 'Ch' });
      logger.info('hidden');
      logger.warn('visible');
      const lines = channels.channels.get('Ch')?.lines ?? [];
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('visible');
   });
});

describe('getRequestParentName', () => {
   it('returns undefined when there is no parent request', () => {
      expect(getRequestParentName(makeStubInversifyContext(undefined))).toBeUndefined();
   });

   it('returns undefined when the parent binding has no implementationType.name', () => {
      expect(getRequestParentName(makeStubInversifyContext(''))).toBeUndefined();
   });

   it('extracts the parent class name when present', () => {
      expect(getRequestParentName(makeStubInversifyContext('OuterClass'))).toBe('OuterClass');
   });
});

interface BindCall {
   token: unknown;
   method: string;
   arg?: unknown;
   factory?: (ctx: unknown) => unknown;
}

/** Minimal `bind` recorder capturing the chain `bindChannelLogger` issues. */
function recordBindings(): { bind: (token: unknown) => unknown; calls: BindCall[] } {
   const calls: BindCall[] = [];
   const bind = (token: unknown): unknown => ({
      toConstantValue(value: unknown): void {
         calls.push({ token, method: 'toConstantValue', arg: value });
      },
      to(target: unknown): { inSingletonScope(): void } {
         calls.push({ token, method: 'to', arg: target });
         return {
            inSingletonScope(): void {
               calls.push({ token, method: 'inSingletonScope' });
            }
         };
      },
      toDynamicValue(factory: (ctx: unknown) => unknown): { inSingletonScope(): void } {
         calls.push({ token, method: 'toDynamicValue', factory });
         return {
            inSingletonScope(): void {
               calls.push({ token, method: 'inSingletonScope' });
            }
         };
      }
   });
   return { bind, calls };
}

describe('bindChannelLogger', () => {
   let channels: StubOutputChannelManager;

   beforeEach(() => {
      channels = makeStubOutputChannelManager();
      Logger.setLevel('trace');
   });

   afterEach(() => {
      Logger.setLevel('info');
   });

   it('binds the options constant, the singleton base, and the class-scoped dynamic value', () => {
      const { bind, calls } = recordBindings();
      bindChannelLogger(bind as never, { channelName: 'Ch' });

      expect(calls.find(c => c.token === ChannelLoggerOptions)).toMatchObject({
         method: 'toConstantValue',
         arg: { channelName: 'Ch' }
      });
      // The base singleton binds the concrete class under a private token.
      expect(calls.find(c => c.method === 'to' && c.arg === ChannelLogger)).toBeDefined();
      expect(calls.some(c => c.method === 'inSingletonScope')).toBe(true);
      // The public ChannelLogger token resolves to a per-request dynamic value.
      const dynamic = calls.find(c => c.token === ChannelLogger && c.method === 'toDynamicValue');
      expect(dynamic?.factory).toBeDefined();
   });

   it('the dynamic value derives the base logger by parent class name', () => {
      const { bind, calls } = recordBindings();
      bindChannelLogger(bind as never, { channelName: 'Ch' });
      const factory = calls.find(c => c.token === ChannelLogger && c.method === 'toDynamicValue')!.factory!;

      const baseLogger = makeLogger(channels, { channelName: 'Ch' });
      const resolved = factory({
         currentRequest: { parentRequest: { bindings: [{ implementationType: { name: 'ParentClass' } }] } },
         container: { get: (): unknown => baseLogger }
      }) as ChannelLogger;
      resolved.info('hi');
      expect(channels.channels.get('Ch')?.lines[0]).toContain('[ParentClass] hi');
   });

   it('the dynamic value falls back to the base logger without a parent class name', () => {
      const { bind, calls } = recordBindings();
      bindChannelLogger(bind as never, { channelName: 'Ch' });
      const factory = calls.find(c => c.token === ChannelLogger && c.method === 'toDynamicValue')!.factory!;

      const baseLogger = makeLogger(channels, { channelName: 'Ch' });
      const resolved = factory({
         currentRequest: { parentRequest: null },
         container: { get: (): unknown => baseLogger }
      });
      expect(resolved).toBe(baseLogger);
   });
});
