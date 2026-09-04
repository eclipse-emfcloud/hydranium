/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { makeBindRecorder } from '../../src/testing/bind-recorder';

class FakeService {}
const FakeSymbol = Symbol.for('test.FakeSymbol');

describe('makeBindRecorder', () => {
   it('captures bind() chains in order', () => {
      const rec = makeBindRecorder();
      rec.bind(FakeService).toSelf().inSingletonScope();
      expect(rec.captured).toHaveLength(1);
      expect(rec.captured[0]).toMatchObject({
         kind: 'bind',
         token: FakeService,
         chain: ['toSelf()', 'inSingletonScope()']
      });
   });

   it('captures rebind() chains separately from bind()', () => {
      const rec = makeBindRecorder();
      rec.bind(FakeService).toSelf();
      rec.rebind(FakeService).toConstantValue({ replaced: true });
      expect(rec.captured).toHaveLength(2);
      expect(rec.find('bind', FakeService)?.chain).toEqual(['toSelf()']);
      expect(rec.find('rebind', FakeService)?.chain).toEqual(['toConstantValue([object Object])']);
   });

   it('stringifies function arguments using their name', () => {
      const rec = makeBindRecorder();
      rec.rebind('Other').toService(FakeService);
      expect(rec.find('rebind', 'Other')?.chain).toEqual([`toService(<${FakeService.name}>)`]);
   });

   it('stringifies symbol arguments via Symbol.toString', () => {
      const rec = makeBindRecorder();
      rec.bind(FakeSymbol).toConstantValue('v');
      expect(rec.find('bind', FakeSymbol)?.chain).toEqual(['toConstantValue(v)']);
   });

   it('find() returns undefined when the token was never bound', () => {
      const rec = makeBindRecorder();
      rec.bind(FakeService).toSelf();
      expect(rec.find('bind', FakeSymbol)).toBeUndefined();
      expect(rec.find('rebind', FakeService)).toBeUndefined();
   });

   it('chain methods return a proxy, so longer chains stay recorded', () => {
      const rec = makeBindRecorder();
      const dynamicFactory = (): unknown => ({});
      rec.bind(FakeSymbol).toDynamicValue(dynamicFactory).inSingletonScope();
      expect(rec.find('bind', FakeSymbol)?.chain).toEqual([`toDynamicValue(<${dynamicFactory.name || 'fn'}>)`, 'inSingletonScope()']);
   });
});
