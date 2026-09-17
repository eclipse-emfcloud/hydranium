/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The panel's DOM: one text input per editable field, a status line, and the
 * document's diagnostics.
 *
 * **Host-agnostic, which is why it lives here rather than in a shell.** It
 * touches nothing but the DOM — no `vscode`, no `acquireVsCodeApi`, no Theia
 * container — so the VS Code webview and the Theia property-view widget mount
 * the same class into their own node and differ only in how they reach the
 * data head. It is the only file in this package that touches the DOM at all.
 */

import type { PropertyField, SetFieldOutcome } from '../data/order-flow-properties-model';
import { describeError, resolve, type ResolvedMessage, type TransferDiagnostic } from '@hydranium/protocol';
import { PROPERTIES_WRITE_FAILED } from './properties-messages';

/** What the form needs from whoever owns the model. */
export interface PropertiesFormHandlers {
   /** Write one field, returning what the model made of it. */
   readonly setField: (name: string, value: string) => Promise<SetFieldOutcome>;
   /**
    * Surface a failure — the same sink the port reports through, so a failure
    * the form raises and one the transport raises reach the user by one path.
    *
    * `reported` is a complete sentence plus the identity needed to render it in
    * another language. The form resolves its own messages here rather than
    * handing over a fragment, because this tier knows neither the host's locale
    * nor whether a process hop lies between it and the surface that renders.
    */
   readonly reportError: (error: unknown, reported: ResolvedMessage) => void;
}

/** How each write outcome reads to a user. `applied` is silent on purpose. */
const OUTCOME_MESSAGES: Record<SetFieldOutcome['status'], string> = {
   applied: '',
   unchanged: '',
   merged: 'Saved. Someone else had edited another field; both changes were kept.',
   conflict: 'Not saved — someone else changed this field first. The value shown is theirs.',
   unavailable: 'Not saved — the document could not be re-read to resolve a conflict.'
};

/**
 * Outcomes after which the server holds the value that was written.
 *
 * `conflict` and `unavailable` are absent deliberately: the write was dropped,
 * so the box still shows something the server does not have and the field stays
 * marked. `merged` belongs here — a merge keeps both intents, so this field's
 * value did land.
 */
const SETTLED_ON_THE_WRITTEN_VALUE = new Set<SetFieldOutcome['status']>(['applied', 'unchanged', 'merged']);

/** Which outcomes colour the status line, and how. */
const OUTCOME_KINDS: Partial<Record<SetFieldOutcome['status'], string>> = {
   merged: 'merged',
   conflict: 'conflict',
   unavailable: 'error'
};

export class PropertiesForm {
   protected readonly heading: HTMLHeadingElement;
   protected readonly fieldsHost: HTMLDivElement;
   protected readonly status: HTMLDivElement;
   protected readonly diagnosticsHost: HTMLUListElement;
   /** The inputs currently on screen, by field name. */
   protected inputs = new Map<string, HTMLInputElement>();
   /**
    * Per field, the value this form last WROTE into its input.
    *
    * Not the model's current value, and the difference is what makes the
    * pending marker mean one thing. {@link setFields} deliberately never writes
    * into the input the user is typing in, so a foreign edit to that field
    * moves the model and leaves this alone — and the field is correctly NOT
    * marked, because the reader has changed nothing. Comparing against the model
    * instead would mark a field the reader never touched.
    */
   protected rendered = new Map<string, string>();
   /** Whether {@link rebuild} has ever run — see {@link sameNames}. */
   protected built = false;
   /** Whether a document load is in flight — see {@link setLoading}. */
   protected loading = false;

   constructor(
      root: HTMLElement,
      protected readonly handlers: PropertiesFormHandlers
   ) {
      this.heading = this.createElement('h1');
      this.fieldsHost = this.createElement('div');
      this.status = this.createElement('div');
      this.status.className = 'status';
      this.diagnosticsHost = this.createElement('ul');
      this.diagnosticsHost.className = 'diagnostics';
      root.append(this.heading, this.fieldsHost, this.status, this.diagnosticsHost);
      this.heading.textContent = 'No Order Flow document selected';
   }

   /**
    * Element creation, behind a seam so this class's decision logic can be
    * driven without a DOM.
    *
    * Every vitest project in this repository runs `environment: 'node'`, and
    * that is deliberate: a DOM shim would test a simulation of the rendering
    * that the browser e2e already proves for real, while costing a dependency
    * and a second environment. So the way to unit-test anything here is to
    * override this and return a stub — the same shape the framework's own
    * widget tests use for their overlay.
    *
    * Overriding is safe from the constructor: prototype methods resolve to the
    * subclass before its own field initializers run, so a stub must not depend
    * on subclass state.
    */
   protected createElement<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
      return document.createElement(tag);
   }

   /** The document this form is showing, for the heading. */
   setTitle(label: string | undefined): void {
      this.heading.textContent = label ?? 'No Order Flow document selected';
   }

   /**
    * Mark a document load as in flight, so the gap between two documents is not
    * drawn as a result.
    *
    * **Switching documents legitimately passes through an empty field set.**
    * `OrderFlowPropertiesModel.open` closes the previous document before opening
    * the next, and the close fires a change with no snapshot — so a form that
    * renders every change verbatim flashes "this document root has no editable
    * text properties" on every switch. That message is *true* of the instant it
    * describes and *wrong* about the document the user just selected, which is
    * the worst combination: it reads as a finding rather than as a transition.
    *
    * Suppressing only the EMPTY set, and only while loading, is what keeps the
    * genuinely-empty case visible: a root that really has no string properties
    * still reports itself once the load resolves.
    */
   setLoading(loading: boolean): void {
      this.loading = loading;
   }

   /**
    * Draw `fields`.
    *
    * **Rebuilt only when the field NAMES change; otherwise values are written in
    * place, and never into the input the user is typing in.** A properties view
    * that recreates its inputs on every model change loses the caret — and it
    * gets a model change on every foreign edit to the document, which is exactly
    * when the user is most likely to be mid-word. This is the same bug the
    * model's own echo filter exists to prevent on the write path; the filter
    * cannot help with a third party's write, so the fix has to be here too.
    *
    * The consequence, stated rather than hidden: a foreign edit to the field the
    * user is IN leaves that one input stale, because blurring fires no model
    * change to redraw it from. The user's own next write then trips
    * `baseVersion`, and the conflict branch adopts the server's value and fires a
    * change — by which point the input is no longer focused, so it updates. The
    * edit is never silently lost; it is only the display that lags, and only for
    * the field being typed in.
    */
   setFields(fields: readonly PropertyField[]): void {
      if (this.loading && fields.length === 0) {
         // The close half of a document switch. See setLoading.
         return;
      }
      const names = fields.map(field => field.name);
      if (!this.sameNames(names)) {
         this.rebuild(fields);
         return;
      }
      for (const field of fields) {
         const input = this.inputs.get(field.name);
         if (input && document.activeElement !== input) {
            input.value = field.value;
            this.rendered.set(field.name, field.value);
            this.markPending(field.name);
         }
      }
   }

   /**
    * Mark `name` when its input no longer holds what was written into it.
    *
    * The marker locates the field; the note beside it says what to do about it,
    * which is why the marker itself needs no words and so no catalogue entry in
    * any host. The note is what an input points `aria-describedby` at, generated
    * marker content being announced inconsistently and a bare asterisk saying
    * nothing useful when it is.
    */
   protected markPending(name: string): void {
      const input = this.inputs.get(name);
      const wrapper = input?.parentElement;
      if (!input || !wrapper) {
         return;
      }
      const pending = input.value !== this.rendered.get(name);
      if (pending) {
         wrapper.setAttribute('data-pending', '');
      } else {
         wrapper.removeAttribute('data-pending');
      }
      const hint = wrapper.querySelector<HTMLElement>('.field-hint');
      if (hint) {
         hint.hidden = !pending;
      }
   }

   /**
    * Draw `diagnostics`.
    *
    * Worth showing rather than dropping, because editing a cross-reference field
    * to an unresolvable name is a legitimate outcome of this form — the transfer
    * form of a reference is its text, so the server accepts the write and reports
    * a diagnostic. Without this the write would look like it silently did
    * nothing wrong.
    *
    * `message` is shown as it arrived: the server renders it, in the locale its
    * client declared at init, so this tier neither needs a catalogue nor has
    * anything to add. Re-rendering here would be a second authority over one
    * sentence.
    */
   setDiagnostics(diagnostics: readonly TransferDiagnostic[]): void {
      this.diagnosticsHost.replaceChildren(
         ...diagnostics.map(diagnostic => {
            const item = this.createElement('li');
            item.textContent = `${diagnostic.severity}: ${diagnostic.message}`;
            return item;
         })
      );
   }

   /** Say something in the status line. `kind` colours it. */
   report(message: string, kind?: string): void {
      this.status.textContent = message;
      if (kind) {
         this.status.dataset.kind = kind;
      } else {
         delete this.status.dataset.kind;
      }
   }

   /** Announce that the connection is gone and stop accepting edits. */
   setDisconnected(): void {
      for (const input of this.inputs.values()) {
         input.disabled = true;
      }
      this.report('The data server connection closed. Reopen the panel to reconnect.', 'error');
   }

   /**
    * Whether the currently drawn inputs already cover exactly `names`.
    *
    * `built` is not redundant with the map size. Before the first draw the map
    * is empty, so without it a first document whose root has NO string
    * properties compares 0 against 0, takes the "nothing changed" path, and
    * leaves the panel blank instead of saying why. An empty field set is a
    * legitimate state, so it has to be drawn rather than skipped.
    */
   protected sameNames(names: readonly string[]): boolean {
      if (!this.built || names.length !== this.inputs.size) {
         return false;
      }
      return names.every(name => this.inputs.has(name));
   }

   protected rebuild(fields: readonly PropertyField[]): void {
      this.built = true;
      this.inputs = new Map();
      this.rendered = new Map();
      this.fieldsHost.replaceChildren(
         ...fields.map(field => {
            const wrapper = this.createElement('div');
            wrapper.className = 'field';
            const label = this.createElement('label');
            label.textContent = field.name;
            label.htmlFor = `field-${field.name}`;
            const input = this.createElement('input');
            input.id = `field-${field.name}`;
            input.type = 'text';
            input.value = field.value;
            const hint = this.createElement('div');
            hint.id = `field-${field.name}-hint`;
            hint.className = 'field-hint';
            hint.textContent = 'Press Enter to apply';
            // Hidden by the ATTRIBUTE rather than by a stylesheet rule, so a
            // host that adds no CSS for this gets the behaviour rather than a
            // note that never goes away.
            hint.hidden = true;
            input.setAttribute('aria-describedby', hint.id);
            // `change`, not `input`: a field edit is a read-modify-write of the
            // WHOLE transfer root (`TransferUpdateArgs.model` IS the root — there
            // is no path-scoped variant), so writing per keystroke would send one
            // full-document update per character and reparse the file each time.
            // `change` fires on blur and on Enter, which is the granularity the
            // wire shape actually wants.
            input.addEventListener('change', () => void this.write(field.name, input.value));
            // `input` DOES fire per keystroke, and may: it moves no data, only
            // the marker that says this field is holding something the server
            // has not been told about.
            input.addEventListener('input', () => this.markPending(field.name));
            wrapper.append(label, input, hint);
            this.inputs.set(field.name, input);
            this.rendered.set(field.name, field.value);
            return wrapper;
         })
      );
      if (fields.length === 0) {
         const empty = this.createElement('div');
         empty.textContent = 'This document root has no editable text properties.';
         this.fieldsHost.replaceChildren(empty);
      }
   }

   protected async write(name: string, value: string): Promise<void> {
      try {
         const outcome = await this.handlers.setField(name, value);
         this.report(OUTCOME_MESSAGES[outcome.status], OUTCOME_KINDS[outcome.status]);
         if (SETTLED_ON_THE_WRITTEN_VALUE.has(outcome.status)) {
            // The server now holds what was typed, so it is no longer pending —
            // and this is the only place that can say so when the write came
            // from Enter: `setFields` refuses to touch a focused input, and
            // Enter does not blur, so the redraw that normally moves the
            // baseline never reaches this field.
            this.rendered.set(name, value);
            this.markPending(name);
         }
      } catch (error: unknown) {
         this.handlers.reportError(error, resolve(PROPERTIES_WRITE_FAILED, { field: name, detail: describeError(error) }));
         this.report(describeError(error), 'error');
      }
   }
}
