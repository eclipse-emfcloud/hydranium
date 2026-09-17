/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { ResolvedMessage } from '@hydranium/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SetFieldOutcome } from '../src/data/order-flow-properties-model';
import { PropertiesForm } from '../src/properties/properties-form';
import { PROPERTIES_WRITE_FAILED } from '../src/properties/properties-messages';

/**
 * The form's failure path, driven without a DOM.
 *
 * Every vitest project here runs `environment: 'node'` by a standing decision —
 * a DOM shim would test a simulation of rendering the browser e2e already proves
 * for real. So this overrides `PropertiesForm.createElement` and returns a stub,
 * which is enough because the property under test is not what gets drawn: it is
 * that a failed write REACHES the error sink carrying the right identity. The
 * compiler already proves the call constructs a valid `ResolvedMessage`; what it
 * cannot prove is that the call happens at all.
 */

/** The element surface the form actually touches on these paths. */
interface StubElement {
   id: string;
   type: string;
   value: string;
   htmlFor: string;
   hidden: boolean;
   className: string;
   textContent: string | null;
   parentElement: StubElement | null;
   readonly dataset: Record<string, string>;
   readonly attributes: Record<string, string>;
   readonly listeners: Record<string, (() => void)[]>;
   readonly children: StubElement[];
   append(...nodes: StubElement[]): void;
   replaceChildren(...nodes: StubElement[]): void;
   remove(): void;
   setAttribute(name: string, value: string): void;
   removeAttribute(name: string): void;
   addEventListener(type: string, listener: () => void): void;
   querySelector(selector: string): StubElement | null;
   /** Fire the handlers registered for `type`, standing in for a user gesture. */
   emit(type: string): void;
}

function stubElement(): StubElement {
   const element: StubElement = {
      id: '',
      type: '',
      value: '',
      htmlFor: '',
      hidden: false,
      className: '',
      textContent: null,
      parentElement: null,
      dataset: {},
      attributes: {},
      listeners: {},
      children: [],
      append(...nodes) {
         for (const node of nodes) {
            node.parentElement = element;
         }
         element.children.push(...nodes);
      },
      replaceChildren(...nodes) {
         element.children.length = 0;
         for (const node of nodes) {
            node.parentElement = element;
         }
         element.children.push(...nodes);
      },
      remove() {
         /* nothing observes removal on these paths */
      },
      setAttribute(name, value) {
         element.attributes[name] = value;
      },
      removeAttribute(name) {
         delete element.attributes[name];
      },
      addEventListener(type, listener) {
         (element.listeners[type] ??= []).push(listener);
      },
      // Only the one selector the form uses, matched on `className` — a real
      // selector engine here would be a DOM shim by another name.
      querySelector(selector) {
         const wanted = selector.replace('.', '');
         return element.children.find(child => child.className === wanted) ?? null;
      },
      emit(type) {
         for (const listener of element.listeners[type] ?? []) {
            listener();
         }
      }
   };
   return element;
}

interface Reported {
   readonly error: unknown;
   readonly reported: ResolvedMessage;
}

/**
 * Exposes `write`, which is `protected` because nothing outside the class should
 * call it — a test subclass is the sanctioned way in, and it is also where the
 * DOM seam is stubbed.
 */
class TestableForm extends PropertiesForm {
   override write(name: string, value: string): Promise<void> {
      return super.write(name, value);
   }

   statusLine(): string | null {
      return this.status.textContent;
   }

   /** The wrapper drawn for `name`, so a test can read what was marked on it. */
   fieldOf(name: string): StubElement {
      const input = this.inputs.get(name) as unknown as StubElement | undefined;
      if (!input?.parentElement) {
         throw new Error(`No field drawn for '${name}'`);
      }
      return input.parentElement;
   }

   inputOf(name: string): StubElement {
      return this.fieldOf(name).children.find(child => child.id === `field-${name}`)!;
   }

   protected override createElement<K extends keyof HTMLElementTagNameMap>(): HTMLElementTagNameMap[K] {
      return stubElement() as unknown as HTMLElementTagNameMap[K];
   }
}

function makeForm(setField: (name: string, value: string) => Promise<SetFieldOutcome>): {
   form: TestableForm;
   reported: Reported[];
} {
   const reported: Reported[] = [];
   const form = new TestableForm(stubElement() as unknown as HTMLElement, {
      setField,
      reportError: (error, message) => reported.push({ error, reported: message })
   });
   return { form, reported };
}

describe('PropertiesForm write failures', () => {
   let failure: Error;

   beforeEach(() => {
      failure = new Error('the data server went away');
   });

   it('reports a failed write through the error sink with the write-failed identity', async () => {
      const { form, reported } = makeForm(() => Promise.reject(failure));

      await form.write('customerName', 'Ada');

      expect(reported).toHaveLength(1);
      expect(reported[0].error).toBe(failure);
      // On the code, not the sentence: the code is the contract and the English
      // default is a fallback that may be reworded.
      expect(reported[0].reported.code).toBe(PROPERTIES_WRITE_FAILED.code);
   });

   it('carries the field name and the cause as params, which is what a translating host renders from', () => {
      // A host with a catalogue renders from `params`, not from `text`, so a
      // message that arrived with `detail` dropped would read fine in English and
      // lose the cause in every other language.
      const { form, reported } = makeForm(() => Promise.reject(failure));

      return form.write('customerName', 'Ada').then(() => {
         expect(reported[0].reported.params).toEqual({
            field: 'customerName',
            detail: 'the data server went away'
         });
      });
   });

   it('also says something in the status line, so the failure is visible without a host toast', async () => {
      const { form } = makeForm(() => Promise.reject(failure));

      await form.write('customerName', 'Ada');

      expect(form.statusLine()).toBe('the data server went away');
   });

   it('reports nothing when the write succeeds', async () => {
      const { form, reported } = makeForm(() => Promise.resolve({ status: 'applied' } as SetFieldOutcome));

      await form.write('customerName', 'Ada');

      expect(reported).toEqual([]);
   });
});

/**
 * `setFields` reads `document.activeElement` to decide whether a field is being
 * typed in. One property, stubbed here rather than pulling in a DOM: the rule
 * under test is which VALUE the marker compares against, and that is decided by
 * whether the form wrote the input, not by how the element renders.
 */
const documentStub: { activeElement: unknown } = { activeElement: null };
(globalThis as unknown as { document: unknown }).document = documentStub;

describe('PropertiesForm pending marker', () => {
   const applied = (): Promise<SetFieldOutcome> => Promise.resolve({ status: 'applied' } as SetFieldOutcome);

   beforeEach(() => {
      documentStub.activeElement = null;
   });

   it('marks a field whose input no longer holds what was drawn into it', () => {
      const { form } = makeForm(applied);
      form.setFields([{ name: 'customerName', value: 'Ada' }]);
      expect(form.fieldOf('customerName').attributes['data-pending']).toBeUndefined();

      const input = form.inputOf('customerName');
      input.value = 'Grace';
      input.emit('input');

      expect(form.fieldOf('customerName').attributes['data-pending']).toBe('');
      // The note carries the instruction, so the marker itself needs no words.
      expect(form.fieldOf('customerName').querySelector('.field-hint')?.hidden).toBe(false);
   });

   it('clears the marker when the value is typed back to what was drawn', () => {
      const { form } = makeForm(applied);
      form.setFields([{ name: 'customerName', value: 'Ada' }]);
      const input = form.inputOf('customerName');

      input.value = 'Grace';
      input.emit('input');
      input.value = 'Ada';
      input.emit('input');

      expect(form.fieldOf('customerName').attributes['data-pending']).toBeUndefined();
      expect(form.fieldOf('customerName').querySelector('.field-hint')?.hidden).toBe(true);
   });

   it("leaves a field unmarked when someone ELSE's edit moves it, the reader having changed nothing", () => {
      const { form } = makeForm(applied);
      form.setFields([{ name: 'customerName', value: 'Ada' }]);

      // A foreign edit: the model moves and the field is not focused, so the
      // form redraws it. Marking here would accuse the reader of an edit they
      // did not make — which is what comparing against the MODEL rather than
      // against what was drawn would do.
      form.setFields([{ name: 'customerName', value: 'Grace' }]);

      expect(form.inputOf('customerName').value).toBe('Grace');
      expect(form.fieldOf('customerName').attributes['data-pending']).toBeUndefined();
   });

   it('leaves the FOCUSED field alone on a foreign edit, rather than marking the stale value', () => {
      const { form } = makeForm(applied);
      form.setFields([{ name: 'customerName', value: 'Ada' }]);
      const input = form.inputOf('customerName');
      documentStub.activeElement = input;

      // The form refuses to write into a focused input, so the displayed value
      // goes stale. It must not be marked for that: the reader still has not
      // typed anything.
      form.setFields([{ name: 'customerName', value: 'Grace' }]);

      expect(input.value).toBe('Ada');
      expect(form.fieldOf('customerName').attributes['data-pending']).toBeUndefined();
   });
});
