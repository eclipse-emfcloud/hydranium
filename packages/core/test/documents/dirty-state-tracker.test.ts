/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type CanonicalUri, textHash } from '@hydranium/protocol';
import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DefaultDirtyStateTracker, type DocumentDirtyChangedEvent } from '../../src/documents/dirty-state-tracker.js';
import { DefaultTextLedger } from '../../src/documents/text-ledger.js';

const KEY = 'file:///a.x' as CanonicalUri;
const documentAt = (version: number, text: string): TextDocument => TextDocument.create(KEY, 'plaintext', version, text);

function makeTracker(): { tracker: DefaultDirtyStateTracker; events: DocumentDirtyChangedEvent[] } {
   const tracker = new DefaultDirtyStateTracker(new DefaultTextLedger());
   const events: DocumentDirtyChangedEvent[] = [];
   tracker.onDidChangeDirty(event => events.push(event));
   return { tracker, events };
}

describe('DefaultDirtyStateTracker', () => {
   it('ignores a document it does not track', () => {
      const { tracker, events } = makeTracker();
      tracker.refreshDirty(KEY, documentAt(1, 'b'));
      tracker.setDiskBaseline(KEY, documentAt(1, 'b'), 'a');
      expect(tracker.isDirty(KEY)).toBe(false);
      expect(events).toEqual([]);
   });

   it('announces each change of the answer, naming the text it was decided on', () => {
      const { tracker, events } = makeTracker();
      tracker.track(KEY, documentAt(1, 'a'), 'a');
      tracker.refreshDirty(KEY, documentAt(2, 'b'));
      tracker.refreshDirty(KEY, documentAt(3, 'c'));
      tracker.setDiskBaseline(KEY, documentAt(3, 'c'), 'c');
      expect(events).toEqual([
         { uri: KEY, text: { version: 2, hash: textHash('b'), dirty: true } },
         { uri: KEY, text: { version: 3, hash: textHash('c'), dirty: false } }
      ]);
   });

   it('owes a document released dirty one clean announcement, and one released clean none', () => {
      const { tracker, events } = makeTracker();
      tracker.track(KEY, documentAt(1, 'b'), 'a');
      events.length = 0;
      const owed = tracker.release(KEY);
      expect(tracker.isDirty(KEY)).toBe(false);
      expect(owed?.isOwed()).toBe(true);
      owed?.announce();
      owed?.announce();
      expect(events).toEqual([{ uri: KEY }]);
      expect(owed?.isOwed()).toBe(false);

      tracker.track(KEY, documentAt(1, 'a'), 'a');
      expect(tracker.release(KEY)).toBeUndefined();
   });

   it('hands a first open the announcement a release still owes', () => {
      const { tracker, events } = makeTracker();
      tracker.track(KEY, documentAt(1, 'b'), 'a');
      const owed = tracker.release(KEY);
      events.length = 0;
      // The reopened text is the file's: the open announces the flip itself.
      tracker.track(KEY, documentAt(2, 'a'), 'a');
      expect(events).toEqual([{ uri: KEY, text: { version: 2, hash: textHash('a'), dirty: false } }]);
      expect(owed?.isOwed()).toBe(false);
      owed?.announce();
      expect(events).toHaveLength(1);
   });

   it('lets an earlier release announce nothing for a later one', () => {
      const { tracker, events } = makeTracker();
      tracker.track(KEY, documentAt(1, 'b'), 'a');
      const first = tracker.release(KEY);
      tracker.track(KEY, documentAt(2, 'c'), 'a');
      const second = tracker.release(KEY);
      events.length = 0;
      first?.announce();
      expect(events).toEqual([]);
      expect(second?.isOwed()).toBe(true);
   });
});
