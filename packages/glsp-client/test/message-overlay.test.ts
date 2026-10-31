/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import { EndProgressAction, MessageAction, StartProgressAction, UpdateProgressAction } from '@eclipse-glsp/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DIAGRAM_MESSAGE_DETAILS } from '../src/diagram-message-details';
import { DIAGRAM_MESSAGE_DISMISS } from '../src/diagram-message-dismiss';
import { HydraniumMessageOverlay } from '../src/message-overlay';

/** The slice of a DOM element the overlay uses, so no DOM is needed. */
class ElementDouble {
   /** The element a test focused last, read back as `document.activeElement`. */
   static focused: ElementDouble | undefined;

   readonly children: ElementDouble[] = [];
   readonly classes = new Set<string>();
   readonly attributes = new Map<string, string>();
   readonly listeners = new Map<string, () => void>();
   parent: ElementDouble | undefined;
   isConnected = true;
   ownText = '';

   constructor(readonly tagName: string) {}

   get classList(): { add(...names: string[]): void; contains(name: string): boolean } {
      return { add: (...names) => names.forEach(name => this.classes.add(name)), contains: name => this.classes.has(name) };
   }

   get textContent(): string {
      return this.ownText + this.children.map(child => child.textContent).join('');
   }

   set textContent(text: string) {
      this.children.length = 0;
      this.ownText = text;
   }

   setAttribute(name: string, value: string): void {
      this.attributes.set(name, value);
   }

   append(...nodes: ElementDouble[]): void {
      for (const node of nodes) {
         node.parent = this;
         this.children.push(node);
      }
   }

   remove(): void {
      this.parent?.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = undefined;
   }

   addEventListener(type: string, listener: () => void): void {
      this.listeners.set(type, listener);
   }

   /** A `tag.class` selector, either part optional, the forms the overlay uses. */
   querySelector(selector: string): ElementDouble | null {
      const [tagName, className] = selector.split('.');
      const matches = (element: ElementDouble): boolean =>
         (!tagName || element.tagName === tagName) && (className === undefined || element.classes.has(className));
      return this.find(matches) ?? null;
   }

   contains(node: unknown): boolean {
      return node === this || this.find(element => element === node) !== undefined;
   }

   focus(): void {
      ElementDouble.focused = this;
   }

   find(predicate: (element: ElementDouble) => boolean): ElementDouble | undefined {
      return this.children.find(predicate) ?? this.children.map(child => child.find(predicate)).find(Boolean);
   }
}

/** An overlay over a stand-in container, as if GLSP had created it. */
class TestOverlay extends HydraniumMessageOverlay {
   readonly container = new ElementDouble('div');

   constructor() {
      super();
      Object.assign(this, { containerElement: this.container, logger: { error: vi.fn(), log: vi.fn(), warn: vi.fn() } });
   }

   get rows(): ElementDouble[] {
      return this.container.children;
   }
}

describe('HydraniumMessageOverlay', () => {
   let overlay: TestOverlay;

   beforeEach(() => {
      ElementDouble.focused = undefined;
      vi.stubGlobal('document', {
         createElement: (tagName: string) => new ElementDouble(tagName),
         get activeElement() {
            return ElementDouble.focused;
         }
      });
      overlay = new TestOverlay();
   });

   afterEach(() => {
      vi.unstubAllGlobals();
   });

   it('shows a server message with its severity, where the standalone modules only logged it', () => {
      overlay.handle(MessageAction.create('Nothing was undone.', { severity: 'WARNING' }));
      expect(overlay.rows).toHaveLength(1);
      expect(overlay.rows[0].textContent).toContain('Nothing was undone.');
      expect(overlay.rows[0].classes).toContain('hydranium-message-warning');
   });

   it('prefixes the kind of every row, since a bare `progress` or `warning` would take page styles meant for other elements', () => {
      overlay.handle(MessageAction.create('Undo failed.', { severity: 'ERROR' }));
      overlay.handle(StartProgressAction.create({ progressId: 'p1', title: 'Validating model' }));
      expect([...overlay.rows[0].classes]).toEqual(['hydranium-message', 'hydranium-message-error']);
      expect([...overlay.rows[1].classes]).toEqual(['hydranium-message', 'hydranium-message-progress']);
   });

   it('announces an error or a warning as an alert, and an info as a status', () => {
      overlay.handle(MessageAction.create('Undo failed.', { severity: 'ERROR' }));
      overlay.handle(MessageAction.create('Nothing was undone.', { severity: 'WARNING' }));
      overlay.handle(MessageAction.create('Saved.', { severity: 'INFO' }));
      expect(overlay.rows.map(row => row.attributes.get('role'))).toEqual(['alert', 'alert', 'status']);
   });

   it("keeps a message's details behind a disclosure, as Theia does behind its button", () => {
      overlay.handle(MessageAction.create('Undo failed.', { severity: 'ERROR', details: 'conflict in file:///a.x' }));
      const details = overlay.rows[0].find(element => element.tagName === 'details');
      expect(details?.find(element => element.tagName === 'pre')?.textContent).toBe('conflict in file:///a.x');
   });

   it('labels the details disclosure itself, so a host that knows the locale can translate it as the dismiss button', () => {
      const translated = new (class extends TestOverlay {
         protected override detailsLabel(): string {
            return 'Einzelheiten';
         }
      })();
      overlay.handle(MessageAction.create('Undo failed.', { severity: 'ERROR', details: 'conflict' }));
      translated.handle(MessageAction.create('Undo failed.', { severity: 'ERROR', details: 'conflict' }));
      const summary = (row: ElementDouble): string | undefined => row.find(element => element.tagName === 'summary')?.textContent;
      expect(summary(overlay.rows[0])).toBe(DIAGRAM_MESSAGE_DETAILS.format());
      expect(DIAGRAM_MESSAGE_DETAILS.code).toBe('hydranium/glsp-client/diagram-message-details');
      expect(DIAGRAM_MESSAGE_DETAILS.text).toBe('Details');
      expect(summary(translated.rows[0])).toBe('Einzelheiten');
   });

   it('shows no disclosure for a message without details', () => {
      overlay.handle(MessageAction.create('Undo failed.', { severity: 'ERROR' }));
      expect(overlay.rows[0].find(element => element.tagName === 'details')).toBeUndefined();
   });

   it('drops a message of severity NONE, which clears rather than says anything', () => {
      overlay.handle(MessageAction.create('', { severity: 'NONE' }));
      expect(overlay.rows).toHaveLength(0);
   });

   it('keeps a message until it is dismissed', () => {
      overlay.handle(MessageAction.create('Undo failed.', { severity: 'ERROR' }));
      const dismiss = overlay.rows[0].find(element => element.tagName === 'button');
      expect(dismiss?.attributes.get('aria-label')).toBe(DIAGRAM_MESSAGE_DISMISS.format());
      expect(DIAGRAM_MESSAGE_DISMISS.code).toBe('hydranium/glsp-client/diagram-message-dismiss');
      expect(DIAGRAM_MESSAGE_DISMISS.text).toBe('Dismiss');
      dismiss?.listeners.get('click')?.();
      expect(overlay.rows).toHaveLength(0);
   });

   it('drops the oldest message once the limit is reached, so repeated undos cannot cover the canvas', () => {
      overlay.handle(MessageAction.create('first', { severity: 'WARNING' }));
      overlay.handle(MessageAction.create('second', { severity: 'WARNING' }));
      overlay.handle(MessageAction.create('third', { severity: 'WARNING' }));
      overlay.handle(MessageAction.create('fourth', { severity: 'WARNING' }));
      expect(overlay.rows.map(row => row.textContent)).toEqual(['second', 'third', 'fourth']);
   });

   it('moves a repeated message to the newest rather than stacking it, so a held undo shows its refusal once', () => {
      overlay.handle(MessageAction.create('Nothing was undone.', { severity: 'WARNING' }));
      overlay.handle(MessageAction.create('Saved.', { severity: 'INFO' }));
      overlay.handle(MessageAction.create('Nothing was undone.', { severity: 'WARNING' }));
      expect(overlay.rows.map(row => row.textContent)).toEqual(['Saved.', 'Nothing was undone.']);
      overlay.handle(MessageAction.create('Nothing was undone.', { severity: 'ERROR' }));
      expect(overlay.rows).toHaveLength(3);
   });

   it('scrolls to the newest row, which a full overlay would otherwise keep out of view', () => {
      Object.assign(overlay.container, { scrollHeight: 900, scrollTop: 0 });
      overlay.handle(MessageAction.create('Undo failed.', { severity: 'ERROR' }));
      expect(Reflect.get(overlay.container, 'scrollTop')).toBe(900);
   });

   it('marks each severity with an icon too, since an edge colour alone can be too faint to read', () => {
      Object.assign(overlay, { maxMessages: 5 });
      for (const severity of ['FATAL', 'ERROR', 'WARNING', 'INFO', 'OK'] as const) {
         overlay.handle(MessageAction.create(severity, { severity }));
      }
      const icons = overlay.rows.map(row => row.find(element => element.classes.has('hydranium-message-icon')));
      expect(icons.map(icon => [...(icon?.classes ?? [])].find(name => name.startsWith('codicon-')))).toEqual([
         'codicon-error',
         'codicon-error',
         'codicon-warning',
         'codicon-info',
         'codicon-pass'
      ]);
      expect(icons.every(icon => icon?.attributes.get('aria-hidden') === 'true')).toBe(true);
   });

   /** A diagram whose graph comes after a host extension's own svg, as GLSP inserts extensions first. */
   function attachDiagram(): ElementDouble {
      const icon = new ElementDouble('svg');
      const graph = new ElementDouble('svg');
      graph.classList.add('sprotty-graph');
      const baseDiv = new ElementDouble('div');
      baseDiv.append(icon, graph);
      Object.assign(overlay, { getParentContainer: () => baseDiv });
      return graph;
   }

   it('gives the focus back to the diagram when its dismiss had it, so the next Ctrl+Z still reaches the diagram', () => {
      const graph = attachDiagram();
      overlay.handle(MessageAction.create('Undo failed.', { severity: 'ERROR' }));
      const dismiss = overlay.rows[0].find(element => element.tagName === 'button');
      dismiss?.focus();
      dismiss?.listeners.get('click')?.();
      expect(ElementDouble.focused).toBe(graph);
   });

   it('gives the focus back to the diagram when a repeat replaces the row that had it', () => {
      const graph = attachDiagram();
      overlay.handle(MessageAction.create('Nothing was undone.', { severity: 'WARNING' }));
      overlay.rows[0].find(element => element.tagName === 'button')?.focus();
      overlay.handle(MessageAction.create('Nothing was undone.', { severity: 'WARNING' }));
      expect(ElementDouble.focused).toBe(graph);
   });

   it('gives the focus back to the diagram when the limit drops the row that had it', () => {
      const graph = attachDiagram();
      overlay.handle(MessageAction.create('first', { severity: 'WARNING' }));
      overlay.rows[0].find(element => element.tagName === 'button')?.focus();
      for (const text of ['second', 'third', 'fourth']) {
         overlay.handle(MessageAction.create(text, { severity: 'WARNING' }));
      }
      expect(ElementDouble.focused).toBe(graph);
   });

   it('leaves the focus where it is when a dismiss clicked by pointer never had it', () => {
      attachDiagram();
      const elsewhere = new ElementDouble('input');
      overlay.handle(MessageAction.create('Undo failed.', { severity: 'ERROR' }));
      elsewhere.focus();
      overlay.rows[0].find(element => element.tagName === 'button')?.listeners.get('click')?.();
      expect(ElementDouble.focused).toBe(elsewhere);
   });

   it('rounds a fractional percentage, as a report may send one', () => {
      overlay.handle(StartProgressAction.create({ progressId: 'p1', title: 'Validating model' }));
      overlay.handle(UpdateProgressAction.create('p1', { percentage: 100 / 3 }));
      expect(overlay.rows[0].find(element => element.classes.has('hydranium-progress-percentage'))?.textContent).toBe('33%');
   });

   it('logs an action of another kind routed to it, as the fallback it replaces did', () => {
      const action = { kind: 'somethingElse' };
      overlay.handle(action);
      expect(overlay.rows).toHaveLength(0);
      expect(Reflect.get(overlay, 'logger').log).toHaveBeenCalledWith(overlay, 'Unhandled action received:', action);
   });

   it('ignores a dismiss of a message already dropped, so the limit still counts the ones shown', () => {
      const texts = (): string[] => overlay.rows.map(row => row.textContent);
      overlay.handle(MessageAction.create('first', { severity: 'WARNING' }));
      const dropped = overlay.rows[0].find(element => element.tagName === 'button');
      for (const text of ['second', 'third', 'fourth']) {
         overlay.handle(MessageAction.create(text, { severity: 'WARNING' }));
      }
      dropped?.listeners.get('click')?.();
      overlay.handle(MessageAction.create('fifth', { severity: 'WARNING' }));
      expect(texts()).toEqual(['third', 'fourth', 'fifth']);
   });

   it('shows a progress report from its start, with each update, until its end', () => {
      overlay.handle(StartProgressAction.create({ progressId: 'p1', title: 'Validating model' }));
      expect(overlay.rows[0].textContent).toContain('Validating model');
      overlay.handle(UpdateProgressAction.create('p1', { message: 'halfway', percentage: 50 }));
      expect(overlay.rows[0].textContent).toContain('halfway');
      expect(overlay.rows[0].textContent).toContain('50%');
      overlay.handle(EndProgressAction.create('p1'));
      expect(overlay.rows).toHaveLength(0);
   });

   it('spins while a progress report has no percentage, and stops once one is reported', () => {
      const spinner = (): ElementDouble | undefined => overlay.rows[0].find(element => element.classes.has('codicon-modifier-spin'));
      overlay.handle(StartProgressAction.create({ progressId: 'p1', title: 'Model loading in progress' }));
      expect(spinner()?.classes).toContain('codicon-loading');
      expect(Reflect.get(spinner() ?? {}, 'hidden')).toBeFalsy();
      overlay.handle(UpdateProgressAction.create('p1', { percentage: 50 }));
      expect(Reflect.get(spinner() ?? {}, 'hidden')).toBe(true);
      overlay.handle(UpdateProgressAction.create('p1', { percentage: -1 }));
      expect(Reflect.get(spinner() ?? {}, 'hidden')).toBe(false);
   });

   it('clears the percentage once a report turns back to work of unknown size', () => {
      const percentage = (): string | undefined =>
         overlay.rows[0].find(element => element.classes.has('hydranium-progress-percentage'))?.textContent;
      overlay.handle(StartProgressAction.create({ progressId: 'p1', title: 'Validating model' }));
      overlay.handle(UpdateProgressAction.create('p1', { percentage: 50 }));
      expect(percentage()).toBe('50%');
      overlay.handle(UpdateProgressAction.create('p1', { percentage: -1 }));
      expect(percentage()).toBe('');
   });

   it('replaces the row of a progress report started again under its id, which its end would otherwise leave behind', () => {
      overlay.handle(StartProgressAction.create({ progressId: 'p1', title: 'Validating model' }));
      overlay.handle(StartProgressAction.create({ progressId: 'p1', title: 'Validating model again' }));
      expect(overlay.rows.map(row => row.textContent)).toEqual(['Validating model again']);
      overlay.handle(EndProgressAction.create('p1'));
      expect(overlay.rows).toHaveLength(0);
   });

   it('makes the dismiss a plain button, so a form around the diagram is not submitted', () => {
      overlay.handle(MessageAction.create('Undo failed.', { severity: 'ERROR' }));
      expect(overlay.rows[0].find(element => element.tagName === 'button')?.attributes.get('type')).toBe('button');
   });

   it('logs a message it has no diagram element to show in once, rather than losing it', () => {
      const detached = new HydraniumMessageOverlay();
      const logger = { error: vi.fn(), warn: vi.fn() };
      Object.assign(detached, { logger, options: { baseDiv: 'gone' } });
      vi.stubGlobal('document', { createElement: (tagName: string) => new ElementDouble(tagName), querySelector: () => null });
      detached.handle(MessageAction.create('Undo failed.', { severity: 'ERROR' }));
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(detached, expect.any(String), 'Undo failed.');
      expect(logger.error).not.toHaveBeenCalled();
   });

   it('updates a progress report whose row a subclass gave more elements', () => {
      const withIcon = new (class extends TestOverlay {
         protected override createRow(kind: string, alert: boolean): HTMLElement {
            const row = super.createRow(kind, alert);
            row.append(document.createElement('i'));
            return row;
         }
      })();
      withIcon.handle(StartProgressAction.create({ progressId: 'p1', title: 'Validating model' }));
      withIcon.handle(UpdateProgressAction.create('p1', { message: 'halfway', percentage: 50 }));
      expect(withIcon.rows[0].find(element => element.classes.has('hydranium-progress-message'))?.textContent).toBe('halfway');
   });

   it('puts its element back into the base div the first render replaced, before showing a message', () => {
      const parent = new ElementDouble('div');
      overlay.container.isConnected = false;
      Object.assign(overlay, {
         getParentContainer: () => parent,
         insertContainerIntoParent: (container: ElementDouble, into: ElementDouble) => into.append(container)
      });
      overlay.handle(MessageAction.create('Undo failed.', { severity: 'ERROR' }));
      expect(parent.children).toEqual([overlay.container]);
   });

   it('puts a row shown before the first render back once the model is initialized, without waiting for the next row', () => {
      const parent = new ElementDouble('div');
      overlay.handle(MessageAction.create('Undo failed.', { severity: 'ERROR' }));
      overlay.container.isConnected = false;
      Object.assign(overlay, {
         getParentContainer: () => parent,
         insertContainerIntoParent: (container: ElementDouble, into: ElementDouble) => into.append(container)
      });
      overlay.postModelInitialization();
      expect(parent.children).toEqual([overlay.container]);
   });

   it('logs a message whose element left the page with no base div to go back to, rather than hiding it', () => {
      overlay.container.isConnected = false;
      Object.assign(overlay, { getParentContainer: () => null });
      overlay.handle(MessageAction.create('Undo failed.', { severity: 'ERROR' }));
      expect(overlay.rows).toHaveLength(0);
      expect(Reflect.get(overlay, 'logger').warn).toHaveBeenCalledExactlyOnceWith(overlay, expect.any(String), 'Undo failed.');
   });

   it('shows the model-loading progress, which the Theia message service drops for its own loading overlay', () => {
      overlay.handle(StartProgressAction.create({ progressId: 'p1', title: 'Model loading in progress' }));
      expect(overlay.rows[0].textContent).toContain('Model loading in progress');
      overlay.handle(EndProgressAction.create('p1'));
      expect(overlay.rows).toHaveLength(0);
   });

   it('leaves the progress messages out of the message limit', () => {
      overlay.handle(StartProgressAction.create({ progressId: 'p1', title: 'Validating model' }));
      for (const text of ['first', 'second', 'third', 'fourth']) {
         overlay.handle(MessageAction.create(text, { severity: 'INFO' }));
      }
      expect(overlay.rows[0].textContent).toContain('Validating model');
   });
});
