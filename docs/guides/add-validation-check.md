# Add a validation check

Use this when a rule belongs to the language and must report a diagnostic for
hand-edited text. It is not needed for parser errors, linking errors, or a
diagram-only interaction rule.

Heads: LSP

## The seam

Register a `ValidationCheckContribution` under the language module's
`validation.checks` group. The framework collects it into Langium's validation
registry, so the same check runs when the LSP validates the document. See
[contributions](../concepts/customizing-services.md#contributions-adding-to-the-registries) for the composition rule
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

Add two cases to your validation test, as the scaffold's `validating.test.ts`
does: parse a model with `parseHelper`, build it with
`{ validation: true }`, and read `document.diagnostics`. The valid model has no
diagnostic from your rule; the invalid one has your message, starting on the
offending element's line.

Check that the test can fail: remove your entry from `validation.checks`, and
the invalid case must turn red because your diagnostic is missing, not because
the model failed to parse. The order-flow example's version is
`server/test/process-transition-rules.test.ts`, and
[Test your language](test-your-language.md) covers the rest.

## What this guide does not give

It does not define a project visibility policy, a custom scope provider, or a
transfer-model projection. It also does not make a diagram operation safe: a
diagram must enforce the same invariant at its operation boundary, while this
check remains the authority for hand-edited text.
