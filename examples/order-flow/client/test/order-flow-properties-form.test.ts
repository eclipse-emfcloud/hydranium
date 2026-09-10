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

/** The element surface the form actually touches on this path. */
interface StubElement {
   className: string;
   textContent: string | null;
   readonly dataset: Record<string, string>;
   readonly children: StubElement[];
   append(...nodes: StubElement[]): void;
   replaceChildren(...nodes: StubElement[]): void;
   remove(): void;
}

function stubElement(): StubElement {
   const element: StubElement = {
      className: '',
      textContent: null,
      dataset: {},
      children: [],
      append(...nodes) {
         element.children.push(...nodes);
      },
      replaceChildren(...nodes) {
         element.children.length = 0;
         element.children.push(...nodes);
      },
      remove() {
         /* nothing observes removal on this path */
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
