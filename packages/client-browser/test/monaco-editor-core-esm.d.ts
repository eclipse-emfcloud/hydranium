/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Monaco's `typings` covers the editor API alone; these two leaf modules carry
// no DOM reference, so the test double takes its enums and `Uri` from them.

declare module 'monaco-editor-core/esm/vs/editor/common/standalone/standaloneEnums.js' {
   import type * as monaco from 'monaco-editor-core';
   export const CompletionItemKind: typeof monaco.languages.CompletionItemKind;
   export const CompletionItemInsertTextRule: typeof monaco.languages.CompletionItemInsertTextRule;
   export const DocumentHighlightKind: typeof monaco.languages.DocumentHighlightKind;
   export const EditorOption: typeof monaco.editor.EditorOption;
   export const MarkerSeverity: typeof monaco.MarkerSeverity;
   export const MarkerTag: typeof monaco.MarkerTag;
   export const CompletionItemTag: typeof monaco.languages.CompletionItemTag;
   export const CompletionTriggerKind: typeof monaco.languages.CompletionTriggerKind;
}

declare module 'monaco-editor-core/esm/vs/base/common/uri.js' {
   import type * as monaco from 'monaco-editor-core';
   export const URI: typeof monaco.Uri;
}
