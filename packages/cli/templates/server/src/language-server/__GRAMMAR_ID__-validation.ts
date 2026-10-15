// Validation for __GRAMMAR__: a check the parser and linker cannot make.
//
// A name is what a reference resolves by and what the diagram keys a node by,
// so a second node of the same name is unreachable by reference and dropped
// from the diagram. Each one after the first gets a warning rather than an
// error, since a half-typed rename passes through this state.

import type { ValidationCheckContribution, ValidationCheckRegistry } from '@hydranium/core';
import { acceptMessage } from '@hydranium/core/messages';
import type { ValidationAcceptor } from '@hydranium/langium';
import { defineMessage } from '@hydranium/protocol';
import type { __ENTRY_RULE__, __NAME__AstType } from './ast.js';

export const DUPLICATE_NAME = defineMessage('__PROJECT_ID__/__GRAMMAR_ID__/duplicate-name', "A node named '{name}' is already declared.");

export class __GRAMMAR__ValidationContribution implements ValidationCheckContribution {
   registerValidationChecks(registry: ValidationCheckRegistry): void {
      registry.register<__NAME__AstType>({ __ENTRY_RULE__: this.checkUniqueNames }, this);
   }

   protected checkUniqueNames(model: __ENTRY_RULE__, accept: ValidationAcceptor): void {
      const seen = new Set<string>();
      for (const node of model.nodes) {
         if (seen.has(node.name)) {
            acceptMessage(accept, 'warning', DUPLICATE_NAME, { node, property: 'name' }, { name: node.name });
         }
         seen.add(node.name);
      }
   }
}
