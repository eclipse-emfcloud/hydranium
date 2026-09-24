# Add a validation check

Use this when a rule belongs to the language and must report a diagnostic for
hand-edited text. It is not needed for parser errors, linking errors, or a
diagram-only interaction rule.

Heads: LSP

## The seam

Register a `ValidationCheckContribution` under the language module's
`validation.checks` group. The framework collects it into Langium's validation
registry, so the same check runs when the LSP validates the document. See
[adopter contributions](../concepts/contributions.md) for the composition rule
and [document layers](../concepts/document-layers.md) for the diagnostic path.

## Steps

1. Define a stable message and register a check for the AST node that owns the
   invariant. Resolve references first and return when linking has already
   reported a missing endpoint.

<!-- snippet-preamble
import type { ValidationCheckContribution, ValidationCheckRegistry } from '@hydranium/core';
import type { ValidationAcceptor } from '@hydranium/langium';
import type { AstNode } from '@hydranium/langium';
type Step = AstNode & { name: string };
type Transition = AstNode & { source?: { ref?: Step }; target?: { ref?: Step } };
type OrderFlowAstType = { Transition: Transition };
declare const isSelfTransition: (source: Step, target: Step) => boolean;
-->

```ts
import { acceptMessage } from '@hydranium/core/messages';
import { defineMessage } from '@hydranium/protocol';

export const SELF_TRANSITION = defineMessage('app/process/self-transition', "'{step}' cannot transition to itself.");

export class ProcessValidation implements ValidationCheckContribution {
   registerValidationChecks(registry: ValidationCheckRegistry): void {
      registry.register<OrderFlowAstType>({ Transition: this.checkTransition }, this);
   }

   protected checkTransition(transition: Transition, accept: ValidationAcceptor): void {
      const source = transition.source?.ref;
      const target = transition.target?.ref;
      if (!source || !target || !isSelfTransition(source, target)) return;
      acceptMessage(accept, 'error', SELF_TRANSITION, { node: transition, property: 'target' }, { step: source.name });
   }
}
```

   The message definition gives the diagnostic a stable code and parameters;
   `acceptMessage` preserves that identity for every client surface.

2. Compose the contribution in the language module. Add a named entry rather
   than replacing the validation group, so framework and adopter checks remain
   registered.

<!-- snippet-preamble
declare const ProcessValidation: new () => import('@hydranium/core').ValidationCheckContribution;
-->

```ts
export const languageModule = {
   validation: {
      checks: {
         process: () => new ProcessValidation()
      }
   }
};
```

## How you know it worked

Run the focused validation test:

```sh
npm exec -w @hydranium/example-order-flow-server -- vitest run test/process-transition-rules.test.ts
```

The valid case has no rule diagnostic; the invalid case has the expected message
text, and its diagnostic starts on the offending transition's line. The red
control removes the `transitions` entry from `validation.checks` in
`order-flow-module.ts`; the invalid case must then fail because the rule
diagnostics are absent, not merely because parsing failed.

## What this guide does not give

It does not define a project visibility policy, a custom scope provider, or a
transfer-model projection. It also does not make a diagram operation safe: a
diagram must enforce the same invariant at its operation boundary, while this
check remains the authority for hand-edited text.
