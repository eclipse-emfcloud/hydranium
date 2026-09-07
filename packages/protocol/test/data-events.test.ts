/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `DataEvents` over an adopter's OWN diagnostic and project types.
 *
 * `DataClientProtocol` is generic in three parameters, and this class has to stay
 * generic in all three: an adopter with a richer `Project` (a version, extra
 * descriptor fields) or a richer diagnostic otherwise cannot use the
 * host-neutral client at all, which is the one a webview needs. The second and
 * third parameters carry defaults, so `DataEvents<Root>` stays valid.
 *
 * Both halves are here on purpose. The type-level instantiations are what pin the
 * generic signature — removing the parameters makes this FILE fail to typecheck,
 * which is the control — and the runtime assertions are what show the custom
 * fields actually survive the fan-out rather than merely satisfying a type.
 */

import { DataEvents } from '../src/client/data-events';
import type { DataClientProtocol } from '../src/data';
import type { Project } from '../src/project';
import type { TransferDiagnostic } from '../src/transfer-diagnostic';
import type { TransferElement } from '../src/transfer-element';
import { describe, expect, it } from 'vitest';

/** A minimal adopter root. */
interface WidgetRoot extends TransferElement {
   readonly $type: 'Widget';
   readonly name: string;
}

/** An adopter diagnostic carrying a field the framework's does not. */
interface AuditedDiagnostic extends TransferDiagnostic {
   readonly auditedBy: string;
}

/** An adopter project carrying a field the framework's does not. */
interface TieredProject extends Project {
   readonly tier: 'core' | 'leaf';
}

type AuditedEvents = DataEvents<WidgetRoot, AuditedDiagnostic, TieredProject>;

/**
 * Compile-time proof that the three-parameter instantiation still satisfies the
 * protocol it implements — an unused type-level identity function.
 *
 * **Assert on the parameter list, not on the `implements` clause.** Narrowing
 * the class's `implements` back to `DataClientProtocol<TTransfer>` while leaving
 * the type parameters in place fails nothing: `implements` is a one-way check on
 * the class and method parameters are bivariant, so the narrower clause is still
 * satisfied. Removing the type parameters is the real widening, and that fails
 * here with "Expected 1 type arguments, but got 3".
 */
const _conformsToProtocol: (events: AuditedEvents) => DataClientProtocol<WidgetRoot, AuditedDiagnostic, TieredProject> = events => events;
void _conformsToProtocol;

const WIDGET: WidgetRoot = { $type: 'Widget', name: 'gauge' };

function auditedDiagnostic(): AuditedDiagnostic {
   return {
      type: 'validation-error',
      element: 'Widget',
      message: 'gauge has no unit',
      severity: 'warning',
      auditedBy: 'unit-checker'
   };
}

describe('DataEvents over adopter-specific diagnostic and project types', () => {
   it('fans an update out with the adopter diagnostic intact', () => {
      const events: AuditedEvents = new DataEvents<WidgetRoot, AuditedDiagnostic, TieredProject>();
      const seen: AuditedDiagnostic[][] = [];
      events.onDidUpdateDocument(event => seen.push([...event.document.diagnostics]));

      events.onDocumentUpdated({
         document: { uri: 'file:///widgets/gauge.widget', version: 3, root: WIDGET, diagnostics: [auditedDiagnostic()] },
         sourceClientId: 'widget-form',
         reason: 'changed'
      });

      // `auditedBy` is the point: a listener typed to the framework diagnostic
      // would compile against this event too, so the assertion has to read the
      // field only the adopter's type carries.
      expect(seen).toHaveLength(1);
      expect(seen[0][0].auditedBy).toBe('unit-checker');
   });

   it('fans a project change out with the adopter project intact', () => {
      const events: AuditedEvents = new DataEvents<WidgetRoot, AuditedDiagnostic, TieredProject>();
      const tiers: string[] = [];
      events.onDidChangeProjects(event => tiers.push(event.project.tier));

      events.onProjectsChanged({ project: { id: 'widgets@1', referenceName: 'widgets', tier: 'leaf' }, reason: 'added' });

      expect(tiers).toEqual(['leaf']);
   });

   it('still defaults both extra parameters, so the one-argument form is unchanged', () => {
      // The extra parameters have to stay optional; this is the assertion that
      // says so, since every one-argument call site depends on it.
      const events = new DataEvents<WidgetRoot>();
      const saved: string[] = [];
      events.onDidSaveDocument(event => saved.push(event.document.uri));

      events.onDocumentSaved({
         document: { uri: 'file:///widgets/gauge.widget', version: 4, root: WIDGET, diagnostics: [] },
         sourceClientId: 'widget-form'
      });

      expect(saved).toEqual(['file:///widgets/gauge.widget']);
   });

   it('releases its emitters on dispose', () => {
      const events = new DataEvents<WidgetRoot>();
      let updates = 0;
      events.onDidUpdateDocument(() => updates++);
      events.dispose();

      events.onDocumentUpdated({
         document: { uri: 'file:///widgets/gauge.widget', version: 5, root: WIDGET, diagnostics: [] },
         sourceClientId: 'widget-form',
         reason: 'changed'
      });

      expect(updates).toBe(0);
   });
});
