grammar Domain

import './common'

/**
 * `*.domain` — the structural, LSP-primary half of the order-flow example.
 *
 * Entities, value types and enumerations with typed fields. Dense,
 * refactor-heavy and diff-friendly, so text is genuinely the better editor
 * for it. The `*.process` grammar (`process.langium`) imports this one and
 * references its declarations; references point one way only.
 *
 * Two things here exist to drive framework machinery rather than to model
 * the domain:
 *
 * - **`ProjectManifest`** — the optional `project` header. Whichever
 *   `.domain` file in a folder carries one IS that folder's project
 *   descriptor: `OrderFlowProjectManager` turns it into a `Project`, and
 *   `requires` populates `Project.dependencies`, which the framework's
 *   project-scope filter walks for cross-project visibility. `requires`
 *   entries are plain strings, not Langium cross-references — they are read
 *   at workspace-load time, before any scope exists to resolve them
 *   against.
 * - **`Visibility`** — the optional `public` modifier. Unmarked
 *   declarations are project-visible only; `public` ones are additionally
 *   exported at the framework's `public` visibility tier, so a dependent
 *   project can resolve them. `OrderFlowScopeComputation` is what turns the
 *   modifier into a tier.
 *
 * **Primitives are declarations, not keywords.** `String` / `Number` /
 * `Boolean` are `valuetype`s in a stdlib virtual document
 * (`order-flow-stdlib.ts`), so `Field.type` is a single cross-reference rather
 * than a reference-or-keyword choice. That document carries no `project`
 * header, which is what puts its exports at the framework's `universal`
 * visibility tier — resolvable from any project without a `requires`. Modelling
 * them as grammar keywords instead would make them unresolvable by
 * construction, and the tier would have nothing to demonstrate.
 *
 * `ProjectName` allows hyphens (`commerce-core`) because project ids are
 * folder-shaped, and it is deliberately used ONLY in the manifest: cross-
 * references never carry a project prefix in this language, so the hyphen
 * never has to coexist with the `.` of a qualified name.
 */

entry DomainModel:
    ('project' project=ProjectManifest)?
    (declarations+=Declaration)*;

ProjectManifest:
    name=ProjectName ('requires' dependencies+=ProjectName (',' dependencies+=ProjectName)*)?;

Declaration:
    Entity | ValueType | Enumeration;

Entity:
    (visibility=Visibility)? 'entity' name=ID '{'
        (fields+=Field)*
    '}';

ValueType:
    (visibility=Visibility)? 'valuetype' name=ID '{'
        (fields+=Field)*
    '}';

Enumeration:
    (visibility=Visibility)? 'enum' name=ID '{'
        (literals+=EnumLiteral (',' literals+=EnumLiteral)*)?
    '}';

EnumLiteral:
    name=ID;

Field:
    name=ID ':' type=TypeReference (many?='[' ']')?;

TypeReference:
    declared=[Declaration:ID];

Visibility returns string:
    'public';

ProjectName returns string:
    ID ('-' ID)*;
