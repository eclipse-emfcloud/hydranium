/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type ConflictResolver, ForceConflictResolver, ReconcilingConflictResolver } from '@hydranium/protocol';
import 'reflect-metadata';
import { HydraniumGlspRecordingCommand, type HydraniumGlspRecordingState } from '../src/command/hydranium-glsp-recording-command.js';

interface TestSourceModel {
   nodes: Array<{ id: string; label: string }>;
}

interface LogCapture {
   timings: Array<{ label: string; durationMs: number }>;
}

function makeLog(): LogCapture {
   return { timings: [] };
}

function makeFakeLogger(log: LogCapture): unknown {
   const logger = {
      for(): unknown {
         return logger;
      },
      withUri(): unknown {
         return logger;
      },
      debug(): void {
         // no-op: observability log lines are not asserted by these tests
      },
      warn(): void {
         // no-op: skip-on-divergence warnings are not asserted by these tests
      },
      async time<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
         const start = Date.now();
         const result = await fn();
         log.timings.push({ label, durationMs: Date.now() - start });
         return result;
      }
   };
   return logger;
}

interface FakeRecordingState {
   sourceModel: TestSourceModel;
   updateCalls: Array<{ model: TestSourceModel; version: number | undefined }>;
   sourceUri: string;
   version: number;
   logger: unknown;
   tracer: unknown;
   conflictResolver: ConflictResolver;
   updateSourceModel(model: TestSourceModel, version?: number): Promise<void>;
}

function makeFakeState(
   log: LogCapture,
   initialVersion = 0,
   conflictResolver: ConflictResolver = new ReconcilingConflictResolver()
): FakeRecordingState {
   // One observability stub doubles as both logger (debug) and tracer (time).
   const observability = makeFakeLogger(log);
   const state: FakeRecordingState = {
      sourceModel: { nodes: [] },
      updateCalls: [],
      sourceUri: 'file:///test.a',
      version: initialVersion,
      logger: observability,
      tracer: observability,
      conflictResolver,
      async updateSourceModel(model: TestSourceModel, version?: number): Promise<void> {
         state.updateCalls.push({ model: JSON.parse(JSON.stringify(model)) as TestSourceModel, version });
         state.sourceModel = model;
      }
   };
   return state;
}

function makeCommand(
   state: FakeRecordingState,
   label: string,
   doExecute: () => void | Promise<void>,
   undoAction?: () => void,
   redoAction?: () => void
): HydraniumGlspRecordingCommand<TestSourceModel> {
   // Type-launder the fake into the recording-state intersection so the constructor accepts it.
   return new HydraniumGlspRecordingCommand<TestSourceModel>(
      state as unknown as HydraniumGlspRecordingState<TestSourceModel>,
      label,
      doExecute,
      undoAction,
      redoAction
   );
}

describe('HydraniumGlspRecordingCommand', () => {
   it('records a json-patch undo for an added node and reverses it on undo', async () => {
      const log = makeLog();
      const state = makeFakeState(log);
      const command = makeCommand(state, 'Add node', () => {
         state.sourceModel.nodes.push({ id: 'N1', label: 'first' });
      });

      await command.execute();

      expect(state.sourceModel.nodes).toEqual([{ id: 'N1', label: 'first' }]);
      expect(state.updateCalls).toHaveLength(1);

      await command.undo();

      expect(state.sourceModel.nodes).toEqual([]);
      expect(state.updateCalls).toHaveLength(2);
   });

   it('replays a json-patch redo after undo', async () => {
      const log = makeLog();
      const state = makeFakeState(log);
      const command = makeCommand(state, 'Add node', () => {
         state.sourceModel.nodes.push({ id: 'N1', label: 'first' });
      });

      await command.execute();
      await command.undo();
      await command.redo();

      expect(state.sourceModel.nodes).toEqual([{ id: 'N1', label: 'first' }]);
   });

   it('wraps execute in a time-labelled log entry tagged with the operation label', async () => {
      const log = makeLog();
      const state = makeFakeState(log);
      const command = makeCommand(state, 'Create element', () => {
         state.sourceModel.nodes.push({ id: 'E1', label: 'element' });
      });

      await command.execute();

      expect(log.timings).toHaveLength(1);
      expect(log.timings[0].label).toBe("Execute command 'Create element'");
   });

   it('invokes the optional undoAction bridge during undo', async () => {
      const log = makeLog();
      const state = makeFakeState(log);
      let undoBridgeCalls = 0;
      const command = makeCommand(
         state,
         'Add node',
         () => {
            state.sourceModel.nodes.push({ id: 'N1', label: 'first' });
         },
         () => {
            undoBridgeCalls += 1;
         }
      );

      await command.execute();
      expect(undoBridgeCalls).toBe(0); // not called during execute

      await command.undo();
      expect(undoBridgeCalls).toBe(1);
   });

   it('invokes the optional redoAction bridge during redo', async () => {
      const log = makeLog();
      const state = makeFakeState(log);
      let redoBridgeCalls = 0;
      const command = makeCommand(
         state,
         'Add node',
         () => {
            state.sourceModel.nodes.push({ id: 'N1', label: 'first' });
         },
         undefined,
         () => {
            redoBridgeCalls += 1;
         }
      );

      await command.execute();
      await command.undo();
      await command.redo();

      expect(redoBridgeCalls).toBe(1);
   });

   it('undo without a recorded patch is a no-op (no postChange fired)', async () => {
      const log = makeLog();
      const state = makeFakeState(log);
      const command = makeCommand(state, 'No-op', () => {
         // empty body — no recorded patch since execute() still snapshots and computes
         // an empty patch when before/after are identical
      });
      // Skip execute — manually clear undoPatch to simulate a never-executed command
      (command as unknown as { undoPatch?: unknown }).undoPatch = undefined;

      await command.undo();

      expect(state.updateCalls).toHaveLength(0);
   });

   it('threads the state.version captured at execute() start through updateSourceModel', async () => {
      const log = makeLog();
      const state = makeFakeState(log, 5);
      const command = makeCommand(state, 'Add node', () => {
         state.sourceModel.nodes.push({ id: 'N1', label: 'first' });
      });

      await command.execute();

      expect(state.updateCalls).toHaveLength(1);
      expect(state.updateCalls[0].version).toBe(5);
   });

   it('captures the version at command start; later state.version drift does not affect the threaded value', async () => {
      const log = makeLog();
      const state = makeFakeState(log, 5);
      const command = makeCommand(state, 'Add node', () => {
         state.sourceModel.nodes.push({ id: 'N1', label: 'first' });
         // Simulate the document version moving during the doExecute body —
         // the captured version threaded to updateSourceModel must still be
         // the start-of-execute snapshot, not the post-drift value.
         state.version = 9;
      });

      await command.execute();

      expect(state.updateCalls[0].version).toBe(5);
   });

   it('skips undo (no write) when a foreign edit changed the same field since execute', async () => {
      const log = makeLog();
      const state = makeFakeState(log);
      state.sourceModel = { nodes: [{ id: 'N1', label: 'first' }] };
      const command = makeCommand(state, 'Relabel node', () => {
         state.sourceModel.nodes[0].label = 'edited';
      });

      await command.execute();
      const writesAfterExecute = state.updateCalls.length;

      // Foreign writer changes the SAME field after the command executed.
      state.sourceModel = { nodes: [{ id: 'N1', label: 'foreign' }] };

      await command.undo();

      // Guard tripped: the undo must not clobber the foreign value or write.
      expect(state.sourceModel.nodes[0].label).toBe('foreign');
      expect(state.updateCalls).toHaveLength(writesAfterExecute);
   });

   it('skips redo (no write) when a foreign edit changed the same field since undo', async () => {
      const log = makeLog();
      const state = makeFakeState(log);
      state.sourceModel = { nodes: [{ id: 'N1', label: 'first' }] };
      const command = makeCommand(state, 'Relabel node', () => {
         state.sourceModel.nodes[0].label = 'edited';
      });

      await command.execute();
      await command.undo(); // reverts to 'first'
      const writesBeforeRedo = state.updateCalls.length;

      // Foreign writer changes the SAME field after the undo.
      state.sourceModel = { nodes: [{ id: 'N1', label: 'foreign' }] };

      await command.redo();

      expect(state.sourceModel.nodes[0].label).toBe('foreign');
      expect(state.updateCalls).toHaveLength(writesBeforeRedo);
   });

   it('routes undo through the state conflict resolver — a ForceConflictResolver clobbers a same-field foreign edit', async () => {
      const log = makeLog();
      const state = makeFakeState(log, 0, new ForceConflictResolver());
      state.sourceModel = { nodes: [{ id: 'N1', label: 'first' }] };
      const command = makeCommand(state, 'Relabel node', () => {
         state.sourceModel.nodes[0].label = 'edited';
      });

      await command.execute();

      // Foreign writer changes the SAME field after the command executed.
      state.sourceModel = { nodes: [{ id: 'N1', label: 'foreign' }] };

      await command.undo();

      // Force resolver = last-writer-wins: the recorded `before` value overwrites
      // the foreign edit (contrast with the reconciling default, which skips).
      expect(state.sourceModel.nodes[0].label).toBe('first');
   });

   it('omits version on undo/redo postChange — only fresh execute carries a based-on version', async () => {
      const log = makeLog();
      const state = makeFakeState(log, 5);
      const command = makeCommand(state, 'Add node', () => {
         state.sourceModel.nodes.push({ id: 'N1', label: 'first' });
      });

      await command.execute();
      await command.undo();
      await command.redo();

      // execute → carries v5; undo and redo run after execute completes
      // (activeVersion cleared) so they fall through with version undefined.
      expect(state.updateCalls).toHaveLength(3);
      expect(state.updateCalls[0].version).toBe(5);
      expect(state.updateCalls[1].version).toBeUndefined();
      expect(state.updateCalls[2].version).toBeUndefined();
   });
});
