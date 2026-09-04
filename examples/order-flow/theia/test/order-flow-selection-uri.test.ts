/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   DomainLanguageMetaData,
   LayoutLanguageMetaData,
   ProcessLanguageMetaData
} from '@hydranium/example-order-flow-server/lib/language-server/generated/module.js';
import { describe, expect, it } from 'vitest';
import { ORDER_FLOW_FILE_EXTENSIONS, orderFlowUriOf } from '../src/common/order-flow-selection-uri';

/**
 * `orderFlowUriOf` is the whole of this shell's selection policy, and every
 * shape below is one Theia genuinely publishes — so these are contract tests
 * against Theia and GLSP, not against our own restatement of them.
 *
 * The shapes are built as plain objects rather than by importing Theia's
 * classes, which is the point of the resolver being structural: it keeps the
 * suite headless (no DOM, no inversify container) while still exercising the
 * exact discrimination the browser will perform.
 */
describe('orderFlowUriOf', () => {
   const uri = 'file:///workspace/orders.process';

   it('reads sourceUri from the diagram GlspSelection', () => {
      expect(orderFlowUriOf({ selectedElementsIDs: ['task-1'], widgetId: 'w', sourceUri: uri })).toBe(uri);
   });

   it('resolves a GlspSelection with nothing selected, because focus alone publishes one', () => {
      // TheiaGLSPSelectionForwarder.init re-publishes on every focus change with
      // whatever is selected — usually nothing. Declining here would make the
      // panel go blank the moment the user clicked empty diagram canvas.
      expect(orderFlowUriOf({ selectedElementsIDs: [], widgetId: 'w', sourceUri: uri })).toBe(uri);
   });

   it('declines a GlspSelection whose sourceUri has not resolved yet', () => {
      // `getSourceUri` is async and memoised; the first selection can carry
      // `undefined`. Opening `undefined` would throw inside the model.
      expect(orderFlowUriOf({ selectedElementsIDs: ['task-1'], widgetId: 'w' })).toBeUndefined();
   });

   it('reads the first entry of a navigator FileSelection array', () => {
      const selection = [
         { fileStat: { resource: { toString: () => uri } } },
         { fileStat: { resource: { toString: () => 'file:///other.process' } } }
      ];
      expect(orderFlowUriOf(selection)).toBe(uri);
   });

   it('reads a focused Navigatable via getResourceUri', () => {
      expect(orderFlowUriOf({ getResourceUri: () => ({ toString: () => uri }) })).toBe(uri);
   });

   it('reads the { uri } shape the tab bar publishes for a NavigatableWidget', () => {
      expect(orderFlowUriOf({ uri: { toString: () => uri } })).toBe(uri);
   });

   it('declines a Navigatable that has no resource', () => {
      expect(orderFlowUriOf({ getResourceUri: () => undefined })).toBeUndefined();
   });

   it.each([undefined, null, {}, [], 'a string', 42])('declines the unrelated selection %o', selection => {
      expect(orderFlowUriOf(selection)).toBeUndefined();
   });

   it('declines a file the order-flow server does not own', () => {
      // The provider must fall through to Theia's own `resources` provider for
      // anything else; claiming every file selection would shadow the built-in
      // property view with an empty panel.
      expect(orderFlowUriOf({ uri: { toString: () => 'file:///workspace/README.md' } })).toBeUndefined();
   });

   it.each(['.domain', '.layout', '.process'])('accepts a %s document', extension => {
      expect(orderFlowUriOf({ uri: { toString: () => `file:///workspace/model${extension}` } })).toBe(
         `file:///workspace/model${extension}`
      );
   });
});

describe('ORDER_FLOW_FILE_EXTENSIONS', () => {
   it('covers exactly the extensions the generated language metadata declares', () => {
      // The browser cannot import the server package, so the list is restated in
      // `common/`. This is what stops a newly added grammar from landing with a
      // properties panel that silently declines its files — the server side is
      // generated from the grammars, so it cannot drift on its own.
      const declared = [DomainLanguageMetaData, LayoutLanguageMetaData, ProcessLanguageMetaData]
         .flatMap(metaData => [...metaData.fileExtensions])
         .sort();
      expect([...ORDER_FLOW_FILE_EXTENSIONS].sort()).toEqual(declared);
   });
});
