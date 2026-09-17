/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { requireElement } from './dom.js';

/**
 * Produce what a category shows when opened. Asynchronous because a category may
 * have to ASK for its detail — a published value is already here, a read one is
 * not.
 */
export type ReportDetailProvider = () => string | Promise<string>;

/** Identifies the category a label speaks for. */
const REPORT_ATTRIBUTE = 'data-report';

/** Set on a label whose category has not reported yet. */
const PENDING_ATTRIBUTE = 'data-pending';

/**
 * What each category last reported.
 *
 * Module-level rather than owned by {@link ReportDetail}, because the page
 * publishes into it from wherever a head answers — several of those are
 * module-level functions that exist before any instance does, and threading one
 * through them would put a parameter on every report site to serve construction
 * order alone.
 */
const values = new Map<string, string>();

/** Told whenever a category reports, so a region on screen can redraw. */
const subscribers = new Set<(key: string) => void>();

/**
 * Record what `key` reports.
 *
 * The strip shows LABELS, so this is the only copy: nothing renders it until a
 * reader opens that category. Values are long — a layout report names every
 * positioned node — and six of them across the foot of the window either wrap
 * to a second row or lose whichever category is last.
 *
 * A category open while this lands is REDRAWN. Every published value here
 * corrects itself as the page changes — the layout report on each diagram drag,
 * the diagnostics on each build — so a region that kept the reading it opened
 * with would sit a stale number beside a live page, which reads as the heads
 * disagreeing rather than as a panel not listening.
 */
export function publishReport(key: string, text: string): void {
   values.set(key, text);
   const label = document.querySelector<HTMLElement>(`[${REPORT_ATTRIBUTE}="${key}"]`);
   label?.removeAttribute(PENDING_ATTRIBUTE);
   // Also the label's tooltip, so the value is readable by hovering as well as
   // by opening. The two differ in what they cost a reader, not in what they
   // say: a hover is a glance at one category, the region is a reading that
   // stays put while they look at the page around it.
   if (label) {
      label.title = text;
   }
   for (const subscriber of subscribers) {
      subscriber(key);
   }
}

/**
 * The strip's overlay: what a status-bar category shows when its label is
 * clicked.
 *
 * Dismissal is tooltip-like rather than dialog-like — the open category, a click
 * anywhere else, or `Escape` — because it holds a reading of the page and never
 * an action, so nothing is lost by closing it and nothing needs confirming.
 *
 * One region rather than one per category: two open details would leave a reader
 * comparing panels instead of reading a value.
 */
export class ReportDetail {
   protected readonly host = requireElement('report-detail');
   protected readonly title = requireElement('report-detail-title');
   protected readonly body = requireElement('report-detail-body');
   /** Category currently shown, or `undefined` while closed. */
   protected shown?: string;
   /** Per-category overrides; a category with none shows what it published. */
   protected readonly providers = new Map<string, ReportDetailProvider>();

   constructor() {
      subscribers.add(key => this.redraw(key));
      // Capture phase, so a click reaches this before a handler that moves focus
      // or rebuilds the node it landed on — a dismissal that depends on the
      // target still being in the tree misses exactly those.
      document.addEventListener('click', event => this.handleDocumentClick(event), true);
      document.addEventListener('keydown', event => {
         if (event.key === 'Escape') {
            this.close();
         }
      });
      // `Array.from` rather than iterating the NodeList directly: this project
      // compiles against a lib where it is not declared iterable.
      for (const toggle of Array.from(document.querySelectorAll<HTMLElement>(`[${REPORT_ATTRIBUTE}]`))) {
         const key = toggle.getAttribute(REPORT_ATTRIBUTE);
         if (key !== null) {
            toggle.addEventListener('click', () => void this.toggle(key, toggle));
         }
      }
   }

   /**
    * Give `key` a detail other than what it published — the case being a reading
    * that has to be requested rather than one the page already holds.
    */
   provide(key: string, provider: ReportDetailProvider): void {
      this.providers.set(key, provider);
   }

   /** Open `key`, or close it when it is the one already open. */
   async toggle(key: string, toggle: HTMLElement): Promise<void> {
      if (this.shown === key) {
         this.close();
         return;
      }
      // Claimed BEFORE the provider is awaited, so the document-click dismissal
      // cannot resolve against a stale `shown` while a detail is being fetched.
      this.shown = key;
      this.title.textContent = toggle.textContent?.trim() ?? key;
      this.body.textContent = await this.detailFor(key);
      // Re-checked after the await: a second category clicked while this one was
      // in flight owns the region, and overwriting it here would show that
      // category's heading above this one's body.
      if (this.shown === key) {
         this.host.hidden = false;
      }
   }

   close(): void {
      this.shown = undefined;
      this.host.hidden = true;
   }

   /**
    * Show `key`'s new value if it is the category on screen. Driven by
    * {@link publishReport} rather than called directly.
    *
    * A category with a PROVIDER is skipped: its detail is a reading someone
    * asked for, and the provider publishes a summary as it resolves — redrawing
    * from that would replace the reading with its own summary, and for latency
    * would mean re-reading on every publish, which is the polling the click
    * exists to avoid.
    */
   redraw(key: string): void {
      if (this.shown === key && !this.providers.has(key)) {
         this.body.textContent = values.get(key) ?? '';
      }
   }

   /** The category's own detail, falling back to what it last published. */
   protected async detailFor(key: string): Promise<string> {
      const provider = this.providers.get(key);
      if (provider) {
         try {
            return await provider();
         } catch (error: unknown) {
            return `failed: ${error instanceof Error ? error.message : String(error)}`;
         }
      }
      // A category that has not reported says so, rather than opening empty: an
      // empty region reads as a broken control where "nothing yet" reads as a
      // page still coming up, which is what it is.
      return values.get(key) ?? 'Nothing reported yet.';
   }

   protected handleDocumentClick(event: MouseEvent): void {
      if (this.shown === undefined || !(event.target instanceof Element)) {
         return;
      }
      // A label closes itself through its own handler; dismissing here as well
      // would close and reopen on one click, which reads as the click not
      // working.
      if (event.target.closest(`[${REPORT_ATTRIBUTE}]`) || event.target.closest('#report-detail')) {
         return;
      }
      this.close();
   }
}
