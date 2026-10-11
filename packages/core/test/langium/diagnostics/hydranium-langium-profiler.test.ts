/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DefaultTracer, Logger, type LogLevel, NoopLogger, SystemClock } from '@hydranium/protocol';
import { HydraniumLangiumProfiler } from '../../../src/langium/diagnostics/hydranium-langium-profiler.js';
import { makeNoopSharedServices, makeStubDocumentBuilder } from '../../../src/testing/index.js';

type CapturedLine = { level: LogLevel; component?: string; message: string };

/**
 * Logger double capturing every emitted line with its level + component. Overrides
 * `derive` so `for`/`sub` keep capturing into the same sink (the profiler tags its
 * output via `tracer.for('LangiumProfiler').sub(category)`, so the component — not
 * the message — carries the prefix).
 */
class CapturingLogger extends NoopLogger {
   readonly lines: CapturedLine[];

   constructor(component?: string, sink?: CapturedLine[]) {
      super(component);
      this.lines = sink ?? [];
   }

   protected override emit(level: LogLevel, _label: string, message: string): void {
      this.lines.push({ level, component: this.component, message });
   }

   protected override derive(component: string): this {
      return new CapturingLogger(component, this.lines) as this;
   }
}

/**
 * Build a profiler over a capturing tracer and a stub builder, so a test can end
 * a build and trigger the flush via {@link endBuild}.
 */
function makeProfiler(): { profiler: HydraniumLangiumProfiler; lines: CapturedLine[]; endBuild: (completed?: boolean) => void } {
   const lines: CapturedLine[] = [];
   const logger = new CapturingLogger(undefined, lines);
   const builder = makeStubDocumentBuilder();
   const services = makeNoopSharedServices({
      Tracer: new DefaultTracer(logger, new SystemClock()),
      workspace: { DocumentBuilder: builder }
   });
   const profiler = new HydraniumLangiumProfiler(services);
   return { profiler, lines, endBuild: (completed = true) => builder.fireBuildEnded({ completed }) };
}

/** Run a complete profiling task with the given sub-tasks (each measured once). */
function runTask(profiler: HydraniumLangiumProfiler, identifier: string, subTasks: string[]): void {
   const task = profiler.createTask('parsing', identifier);
   task.start();
   for (const subTask of subTasks) {
      task.startSubTask(subTask);
      task.stopSubTask(subTask);
   }
   task.stop();
}

describe('HydraniumLangiumProfiler', () => {
   afterEach(() => Logger.setLevel('info'));

   it('is inactive below the trace level (zero cost at info/debug)', () => {
      const { profiler } = makeProfiler();
      Logger.setLevel('debug');
      expect(profiler.isActive('parsing')).toBe(false);
      Logger.setLevel('info');
      expect(profiler.isActive('parsing')).toBe(false);
   });

   it('activates only while the trace threshold is admitted (runtime toggle)', () => {
      const { profiler } = makeProfiler();
      Logger.setLevel('trace');
      expect(profiler.isActive('parsing')).toBe(true);
      Logger.setLevel('debug');
      expect(profiler.isActive('parsing')).toBe(false);
   });

   it('honours Langium category selection on top of the trace gate', () => {
      const { profiler } = makeProfiler();
      Logger.setLevel('trace');
      profiler.stop('parsing');
      expect(profiler.isActive('parsing')).toBe(false);
      expect(profiler.isActive('linking')).toBe(true);
   });

   it('refuses to create a task for an inactive category', () => {
      const { profiler } = makeProfiler();
      // Trace off → every category inactive → createTask throws (callers guard with isActive).
      expect(() => profiler.createTask('parsing', 'g')).toThrow(/not active/);
   });

   it('aggregates records across documents into one breakdown per category on flush', () => {
      const { profiler, lines, endBuild } = makeProfiler();
      Logger.setLevel('trace');

      // Two "documents" of the same grammar, each measuring ruleA once.
      runTask(profiler, 'my-grammar', ['ruleA']);
      runTask(profiler, 'my-grammar', ['ruleA']);
      // Both records accumulate; nothing is dumped per-document.
      expect(profiler.getRecords('parsing').toArray()).toHaveLength(2);
      expect(lines.filter(line => line.component === 'LangiumProfiler :: parsing')).toHaveLength(0);

      endBuild();

      const parsing = lines.filter(line => line.component === 'LangiumProfiler :: parsing');
      expect(parsing.length).toBeGreaterThan(0);
      // High-volume per-$type detail sits at trace, never escalates.
      expect(parsing.every(line => line.level === 'trace')).toBe(true);
      // ruleA aggregated across BOTH documents into a single ×2 row.
      const ruleA = parsing.find(line => line.message.includes('my-grammar.ruleA'));
      expect(ruleA?.message).toContain('×2');
      // The window is cleared after the flush.
      expect(profiler.getRecords('parsing').toArray()).toHaveLength(0);
   });

   it('flushes once the lock drains after builds that threw', () => {
      const { profiler, lines, endBuild } = makeProfiler();
      Logger.setLevel('trace');

      runTask(profiler, 'my-grammar', ['ruleA']);
      endBuild(false);

      expect(lines.some(line => line.component === 'LangiumProfiler :: parsing' && line.message.includes('my-grammar.ruleA'))).toBe(true);
      expect(profiler.getRecords('parsing').toArray()).toHaveLength(0);
   });

   it('never writes to the raw console (stdio-safe) — no console.table/info/log', () => {
      const { profiler, endBuild } = makeProfiler();
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const consoleTable = vi.spyOn(console, 'table').mockImplementation(() => undefined);
      Logger.setLevel('trace');

      runTask(profiler, 'my-grammar', ['ruleA']);
      endBuild();

      expect(consoleLog).not.toHaveBeenCalled();
      expect(consoleInfo).not.toHaveBeenCalled();
      expect(consoleTable).not.toHaveBeenCalled();
      consoleLog.mockRestore();
      consoleInfo.mockRestore();
      consoleTable.mockRestore();
   });

   it('flushing an empty window is a no-op', () => {
      const { lines, endBuild } = makeProfiler();
      Logger.setLevel('trace');
      endBuild();
      expect(lines.filter(line => line.component?.startsWith('LangiumProfiler ::'))).toHaveLength(0);
   });
});
