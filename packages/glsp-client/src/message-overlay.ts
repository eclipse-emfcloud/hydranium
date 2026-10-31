/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type Action,
   EndProgressAction,
   GLSPAbstractUIExtension,
   type IActionHandler,
   type IDiagramStartup,
   MessageAction,
   StartProgressAction,
   UpdateProgressAction
} from '@eclipse-glsp/client';
import { injectable } from 'inversify';
import '../style/message-overlay.css';
import { DIAGRAM_MESSAGE_DETAILS } from './diagram-message-details';
import { DIAGRAM_MESSAGE_DISMISS } from './diagram-message-dismiss';
import { reattachUIExtension } from './reattach';

/**
 * Shows the server's messages and progress reports on the diagram, for a host
 * with no notifications of its own. GLSP's standalone modules only log them,
 * so a refused undo would otherwise change nothing the user can see.
 *
 * A message stays until it is dismissed, and only the newest
 * {@link HydraniumMessageOverlay.maxMessages} are kept. A repeated one moves
 * to the newest instead of stacking. A progress report shows from its start
 * to its end, with a spinner until it reports a percentage. Severity `NONE`
 * says nothing and is dropped.
 *
 * A message row shows its severity's icon and carries the severity as a
 * class, and the stylesheet edges it in GLSP's `--glsp-*-foreground` colour.
 * A progress row has the info edge. A host with notifications of its own
 * subclasses this class to forward them, and rebinds it to the subclass in a
 * module only that host loads.
 */
@injectable()
export class HydraniumMessageOverlay extends GLSPAbstractUIExtension implements IActionHandler, IDiagramStartup {
   static readonly ID = 'hydranium-message-overlay';

   /** How many distinct messages are kept, so they cannot cover the canvas. A repeat replaces its row. */
   protected maxMessages = 3;
   protected readonly messageRows: HTMLElement[] = [];
   protected readonly progressRows = new Map<string, HTMLElement>();

   id(): string {
      return HydraniumMessageOverlay.ID;
   }

   containerClass(): string {
      return 'hydranium-messages';
   }

   protected initializeContents(_container: HTMLElement): void {
      // Rows are added as messages arrive.
   }

   handle(action: Action): void {
      if (MessageAction.is(action)) {
         this.showMessage(action);
      } else if (StartProgressAction.is(action)) {
         this.startProgress(action);
      } else if (UpdateProgressAction.is(action)) {
         this.updateProgress(action);
      } else if (EndProgressAction.is(action)) {
         this.endProgress(action);
      } else {
         this.logger.log(this, 'Unhandled action received:', action);
      }
   }

   protected showMessage(action: MessageAction): void {
      if (action.severity === 'NONE') {
         return;
      }
      // An alert is announced when it is inserted, which a status in a region
      // created with it is not. A refused undo is a warning and must be heard.
      const kind = action.severity.toLowerCase();
      const row = this.createRow(kind, action.severity !== 'INFO' && action.severity !== 'OK');
      row.append(this.createIcon(action.severity), this.createText('hydranium-message-text', action.message));
      if (action.details) {
         const details = document.createElement('details');
         const summary = document.createElement('summary');
         summary.textContent = this.detailsLabel();
         const text = document.createElement('pre');
         text.textContent = action.details;
         details.append(summary, text);
         row.append(details);
      }
      const dismiss = document.createElement('button');
      dismiss.setAttribute('type', 'button');
      dismiss.classList.add('codicon', 'codicon-close');
      dismiss.setAttribute('aria-label', this.dismissLabel());
      dismiss.addEventListener('click', () => this.removeMessage(row));
      row.append(dismiss);
      if (!this.addRow(row, action.message)) {
         return;
      }
      // A held Ctrl+Z repeats its refusal, which the newest row then says once.
      // Its details replace those of the row it repeats.
      const repeated = this.messageRows.find(
         shown =>
            shown.classList.contains(`hydranium-message-${kind}`) &&
            shown.querySelector('.hydranium-message-text')?.textContent === action.message
      );
      if (repeated) {
         this.removeMessage(repeated);
      }
      this.messageRows.push(row);
      while (this.messageRows.length > this.maxMessages) {
         this.removeMessage(this.messageRows[0]);
      }
   }

   protected removeMessage(row: HTMLElement): void {
      const index = this.messageRows.indexOf(row);
      if (index >= 0) {
         this.messageRows.splice(index, 1);
      }
      // Back to the diagram, as a row leaving the page would drop the focus on the body.
      const hadFocus = row.contains(document.activeElement);
      row.remove();
      if (hadFocus) {
         this.focusDiagram();
      }
   }

   protected startProgress(action: StartProgressAction): void {
      // A start repeated under its id would otherwise leave the first row with no end.
      if (this.progressRows.has(action.progressId)) {
         this.endProgress(EndProgressAction.create(action.progressId));
      }
      const row = this.createRow('progress', false);
      const spinner = document.createElement('i');
      spinner.classList.add('hydranium-progress-spinner', 'codicon', 'codicon-loading', 'codicon-modifier-spin');
      spinner.setAttribute('aria-hidden', 'true');
      row.append(
         spinner,
         this.createText('hydranium-message-text', action.title),
         this.createText('hydranium-progress-message', ''),
         this.createText('hydranium-progress-percentage', '')
      );
      if (this.addRow(row, action.title)) {
         this.progressRows.set(action.progressId, row);
         this.updateProgress(action);
      }
   }

   protected updateProgress(action: Pick<UpdateProgressAction, 'progressId' | 'message' | 'percentage'>): void {
      const row = this.progressRows.get(action.progressId);
      if (row === undefined) {
         return;
      }
      const message = row.querySelector('.hydranium-progress-message');
      const percentage = row.querySelector('.hydranium-progress-percentage');
      const spinner = row.querySelector<HTMLElement>('.hydranium-progress-spinner');
      if (message && action.message !== undefined) {
         message.textContent = action.message;
      }
      // A negative percentage reports work of unknown size, as GLSP has it.
      // The spinner stands in for a percentage, so it shows only while there is none.
      if (action.percentage !== undefined) {
         const known = action.percentage >= 0;
         if (percentage) {
            percentage.textContent = known ? `${Math.round(action.percentage)}%` : '';
         }
         if (spinner) {
            spinner.hidden = known;
         }
      }
   }

   protected endProgress(action: EndProgressAction): void {
      this.progressRows.get(action.progressId)?.remove();
      this.progressRows.delete(action.progressId);
   }

   /** English, as this tier knows no locale. A host that knows one renders {@link DIAGRAM_MESSAGE_DISMISS} here. */
   protected dismissLabel(): string {
      return DIAGRAM_MESSAGE_DISMISS.format();
   }

   /** English, as this tier knows no locale. A host that knows one renders {@link DIAGRAM_MESSAGE_DETAILS} here. */
   protected detailsLabel(): string {
      return DIAGRAM_MESSAGE_DETAILS.format();
   }

   protected createRow(kind: string, alert: boolean): HTMLElement {
      const row = document.createElement('div');
      // Prefixed, as a bare `progress` or `warning` would take the page's own styles for it.
      row.classList.add('hydranium-message', `hydranium-message-${kind}`);
      row.setAttribute('role', alert ? 'alert' : 'status');
      return row;
   }

   /** The severity as a glyph too, as GLSP's default colours can be too faint on a light page. */
   protected createIcon(severity: MessageAction['severity']): HTMLElement {
      const glyph =
         severity === 'FATAL' || severity === 'ERROR' ? 'error' : severity === 'WARNING' ? 'warning' : severity === 'OK' ? 'pass' : 'info';
      const icon = document.createElement('i');
      icon.classList.add('hydranium-message-icon', 'codicon', `codicon-${glyph}`);
      icon.setAttribute('aria-hidden', 'true');
      return icon;
   }

   protected focusDiagram(): void {
      this.getParentContainer()?.querySelector<SVGElement>('svg.sprotty-graph')?.focus();
   }

   protected createText(className: string, text: string): HTMLElement {
      const span = document.createElement('span');
      span.classList.add(className);
      span.textContent = text;
      return span;
   }

   /** Adds a row to the overlay, or logs its text when the diagram has no element to show it in. */
   protected addRow(row: HTMLElement, text: string): boolean {
      // Checked before `initialize`, which logs the same problem without the text.
      const noElement = !this.containerElement && !this.getContainer() && !this.getParentContainer()?.isConnected;
      if (!noElement && this.initialize()) {
         this.reattach();
         // Still detached when the base div itself left the page.
         if (this.containerElement.isConnected) {
            this.containerElement.append(row);
            // The overlay scrolls once it fills the diagram, and the newest row is at its bottom.
            this.containerElement.scrollTop = this.containerElement.scrollHeight;
            return true;
         }
      }
      this.logger.warn(this, 'No diagram element to show a server message in:', text);
      return false;
   }

   /** A row a startup hook showed before the first render would otherwise wait for the next row. */
   postModelInitialization(): void {
      this.reattach();
   }

   /** Puts the element back into the base div, which sprotty's first render replaces. */
   protected reattach(): void {
      reattachUIExtension(
         this.containerElement as HTMLElement | undefined,
         () => this.getParentContainer(),
         (container, parent) => this.insertContainerIntoParent(container, parent)
      );
   }
}
