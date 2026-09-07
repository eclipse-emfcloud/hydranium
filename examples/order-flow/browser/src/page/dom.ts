/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The page's DOM primitives: typed lookups into `index.html`, and one element
 * builder.
 *
 * **This page is hand-written DOM on purpose and the builder is where that stays
 * affordable.** Its bundle is the strictest browser-neutrality check the repo
 * has — nothing in it is a framework's problem — so a UI library would remove the
 * property the package exists to demonstrate. What a library actually buys at
 * this size is declarative construction, and eight lines buy that: the
 * alternative is `createElement` / `className` / `appendChild` triples, which is
 * where a page like this turns into something nobody wants to change.
 *
 * The reference for the shape is GLSP's own `workflow-standalone` example, which
 * builds a considerably larger app shell — menubar, theme picker, resize
 * handles — the same way.
 */

/** What a child slot accepts: an element, text, or nothing at all. */
type Child = Node | string | undefined | false;

/** Attributes and event handlers, with `class` and `text` as the two shorthands. */
interface ElementProps {
   readonly class?: string;
   readonly text?: string;
   readonly title?: string;
   readonly id?: string;
   readonly onClick?: () => void;
   /** Anything else, written through `setAttribute` so `data-*` and ARIA work. */
   readonly attrs?: Readonly<Record<string, string>>;
}

/**
 * Build one element.
 *
 * `text` rather than a string child when the content is a single label, because
 * `textContent` is the only assignment here that cannot inject markup — every
 * string that reaches this function is a document path, a diagnostic message or
 * a server log line, all of which are content the page did not author.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
   tag: K,
   props: ElementProps = {},
   children: readonly Child[] = []
): HTMLElementTagNameMap[K] {
   const element = document.createElement(tag);
   if (props.class !== undefined) {
      element.className = props.class;
   }
   if (props.text !== undefined) {
      element.textContent = props.text;
   }
   if (props.title !== undefined) {
      element.title = props.title;
   }
   if (props.id !== undefined) {
      element.id = props.id;
   }
   for (const [name, value] of Object.entries(props.attrs ?? {})) {
      element.setAttribute(name, value);
   }
   if (props.onClick !== undefined) {
      element.addEventListener('click', props.onClick);
   }
   for (const child of children) {
      if (child === undefined || child === false) {
         continue;
      }
      element.append(child);
   }
   return element;
}

/** A `codicon` glyph, which the diagram's own stylesheet already brings in. */
export function icon(name: string): HTMLElement {
   // `aria-hidden`, because every icon here sits beside a text label or inside a
   // control with a `title` — announced twice it is noise rather than a name.
   return el('i', { class: `codicon codicon-${name}`, attrs: { 'aria-hidden': 'true' } });
}

/**
 * Replace `parent`'s children with `children`.
 *
 * `replaceChildren` rather than `innerHTML = ''` followed by appends: it is one
 * mutation, so a list re-rendered on every diagnostics publish does not make the
 * browser lay out an empty container in between.
 */
export function replaceContent(parent: HTMLElement, children: readonly Child[]): void {
   parent.replaceChildren(...children.filter((child): child is Node | string => child !== undefined && child !== false));
}

export function requireElement(id: string): HTMLElement {
   const element = document.getElementById(id);
   if (element === null) {
      throw new Error(`Missing element: #${id}`);
   }
   return element;
}

/**
 * The workspace controls start DISABLED in the document and are enabled once
 * they have something to act on.
 *
 * A click before the data head exists would otherwise be a no-op that looks like
 * a broken button, and a button that never enables is a visible symptom of a
 * page that did not finish coming up.
 */
export function requireButton(id: string): HTMLButtonElement {
   const element = requireElement(id);
   if (!(element instanceof HTMLButtonElement)) {
      throw new Error(`#${id} is not a button`);
   }
   return element;
}

export function requireCheckbox(id: string): HTMLInputElement {
   const element = requireElement(id);
   if (!(element instanceof HTMLInputElement)) {
      throw new Error(`#${id} is not a checkbox`);
   }
   return element;
}
