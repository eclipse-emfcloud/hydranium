import { AbstractHydraniumSemanticTokenProvider, type SemanticTokenKind } from '@hydranium/core/lsp';
import { SemanticTokenTypes } from 'vscode-languageserver';
import { __NODE_RULE__ } from './ast.js';

/** Declarations and references share the token kind of their target type. */
export class __GRAMMAR__SemanticTokenProvider extends AbstractHydraniumSemanticTokenProvider {
   protected override getTokenKind(type: string): SemanticTokenKind | undefined {
      return type === __NODE_RULE__.$type ? SemanticTokenTypes.class : undefined;
   }
}
