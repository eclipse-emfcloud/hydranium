/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type LangiumDocument, type URI } from '@hydranium/langium';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';
import { type ServerSharedServicesMinimal } from '../langium/shared-services.js';
import { buildWorkspaceProgrammatically } from '../langium/workspace/initialize-workspace.js';

/** A validation diagnostic's severity, as a stable lowercase string for the JSON contract. */
export type ValidationSeverity = 'error' | 'warning' | 'info' | 'hint';

/**
 * One validation problem, flattened to a serialisable shape. This is the JSON
 * contract `hydranium-cli validate --json` emits, deliberately independent of the
 * `vscode-languageserver` {@link Diagnostic} type so CI tooling reads a stable
 * schema and the CLI never needs a runtime `@hydranium/core` dependency.
 */
export interface ValidationFinding {
   /** Workspace-relative path of the document the problem was reported on. */
   uri: string;
   severity: ValidationSeverity;
   message: string;
   /** 0-based line of the diagnostic range start (add 1 for editor display). */
   line: number;
   /** 0-based character of the diagnostic range start (add 1 for editor display). */
   character: number;
   /** The diagnostic `code`, when the rule set one. */
   code?: string | number;
   /** The diagnostic `source`, when the rule set one. */
   source?: string;
}

/** Per-severity tally across the whole workspace — drives the exit code and the summary line. */
export interface ValidationCounts {
   error: number;
   warning: number;
   info: number;
   hint: number;
}

/** The full result of a headless workspace validation. */
export interface WorkspaceValidationResult {
   /** Number of `LangiumDocument`s in the built workspace. */
   documents: number;
   /** Every problem found, grouped contiguously by document, in the order the documents were given. */
   findings: ValidationFinding[];
   /** Per-severity totals over {@link findings}. */
   counts: ValidationCounts;
}

/** Options for {@link validateWorkspace}. */
export interface ValidateWorkspaceOptions {
   /**
    * Create the language's shared services in-process. This is the only
    * language-specific input — a head passes its own `create<Lang>Services(fileSystem)`.
    */
   createServices: () => { shared: ServerSharedServicesMinimal };
   /** Workspace root (filesystem path or file URI) to build and validate. */
   workspace: string;
}

/** Map a `vscode-languageserver` severity to the stable string. Unset → `error` (fail-safe for a CI gate). */
function severityLabel(severity: DiagnosticSeverity | undefined): ValidationSeverity {
   switch (severity) {
      case DiagnosticSeverity.Warning:
         return 'warning';
      case DiagnosticSeverity.Information:
         return 'info';
      case DiagnosticSeverity.Hint:
         return 'hint';
      default:
         // DiagnosticSeverity.Error, or an omitted severity — treat as an error so
         // a rule that forgets to set one still blocks the gate rather than passing silently.
         return 'error';
   }
}

/**
 * Flatten each document's `diagnostics` into a {@link WorkspaceValidationResult}.
 * Pure over its inputs (documents + a URI-to-relative-path mapper) so it unit-tests
 * without booting a grammar; {@link validateWorkspace} is the thin boot-and-build wrapper.
 */
export function collectValidationResult(
   documents: readonly LangiumDocument[],
   wsRelativePath: (uri: URI) => string
): WorkspaceValidationResult {
   const findings: ValidationFinding[] = [];
   const counts: ValidationCounts = { error: 0, warning: 0, info: 0, hint: 0 };
   for (const document of documents) {
      const relativeUri = wsRelativePath(document.uri);
      for (const diagnostic of (document.diagnostics ?? []) as Diagnostic[]) {
         const severity = severityLabel(diagnostic.severity);
         counts[severity] += 1;
         findings.push({
            uri: relativeUri,
            severity,
            // LSP 3.18 allows a `MarkupContent` message; this report is a
            // line-oriented CI artifact, so take its plain-text rendering.
            message: Diagnostic.getMessageString(diagnostic),
            line: diagnostic.range.start.line,
            character: diagnostic.range.start.character,
            code: diagnostic.code,
            source: diagnostic.source
         });
      }
   }
   return { documents: documents.length, findings, counts };
}

/**
 * Headless workspace validation — the browser-/socket-free counterpart to the
 * diagnostics an editor session publishes. Boots a head's Langium services
 * in-process via {@link ValidateWorkspaceOptions.createServices}, builds every
 * document to `Validated` (which runs the language's validation checks), then
 * collects the diagnostics into a serialisable {@link WorkspaceValidationResult}.
 *
 * Backs `hydranium-cli validate`, whose non-zero exit on errors makes it a CI
 * gate. Like the other headless harnesses the only language-specific input is the
 * service factory, so the framework code stays head-neutral. The build is the
 * standard eager pipeline — identical to what those sibling harnesses run.
 */
export async function validateWorkspace(options: ValidateWorkspaceOptions): Promise<WorkspaceValidationResult> {
   const { shared } = options.createServices();
   await buildWorkspaceProgrammatically(shared, options.workspace);
   const documents = shared.workspace.LangiumDocuments.all.toArray();
   return collectValidationResult(documents, uri => shared.workspace.WorkspaceManager.wsRelativePath(uri));
}
