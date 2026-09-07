grammar Process

import './common'
import './domain'

/**
 * `*.process` — the behavioural, GLSP-primary half of the order-flow
 * example. Tasks, gateways and transitions over an entity declared in a
 * `*.domain` file: a flow is genuinely better edited as a graph, and
 * topology errors that are invisible in text are obvious in a diagram.
 *
 * The seam this grammar exists for is `writes Order.status = PAID`. That
 * single effect resolves three references, each one scoped by the
 * previous:
 *
 * 1. `entity` — an `Entity` from the global index, subject to the
 *    framework's project-visibility filter.
 * 2. `field` — a `Field` of THAT entity, so the candidate set depends on
 *    reference 1 having resolved.
 * 3. `literal` — an `EnumLiteral` of the enumeration the field's type
 *    resolves to, so it depends on reference 2 AND on a further hop
 *    through `Field.type.declared`.
 *
 * Langium's default scope provider cannot answer 2 or 3 (the candidates
 * live in another document, outside the reference's container chain), so
 * `OrderFlowProcessScopeProvider` supplies them. Renaming
 * `OrderStatus.PAID` in `.domain` therefore updates `.process`, and
 * deleting the field reports at a precise range.
 *
 * `import './domain'` is what makes those cross-grammar reference types
 * legal AND what keeps all three grammars in one `langium-cli` run: the shared
 * `AstReflection` slot holds exactly one reflection, so independently
 * generated language packages would leave one grammar's types unknown.
 */

entry ProcessModel:
    'process' name=ID 'for' subject=[Entity:ID] '{'
        (nodes+=FlowNode | transitions+=Transition)*
    '}';

FlowNode:
    Task | Gateway;

Task:
    'task' name=ID (effects+=Effect)*;

Gateway:
    'gateway' name=ID (branches+=Branch)*;

Effect:
    Write | Read;

Write:
    'writes' entity=[Entity:ID] '.' field=[Field:ID] '=' literal=[EnumLiteral:ID];

Read:
    'reads' entity=[Entity:ID] '.' field=[Field:ID];

Branch:
    label=ID '->' target=[FlowNode:ID];

Transition:
    'transition' source=[FlowNode:ID] '->' target=[FlowNode:ID];

// Layout lives in `layout.langium` (`*.layout` files), not here: a `.process`
// file stays complete and valid with no layout beside it, and the framework's
// GLSP state writes both documents in one operation. See that grammar's header
// for what the separate file buys and what it costs.
