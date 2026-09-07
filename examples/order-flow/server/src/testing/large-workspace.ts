/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Deterministic generator for the example's **large** workspace fixture — the
 * volume corpus profiling, `watch` and any incremental-rebuild claim need, and
 * the reproducible baseline the example's own perf bench measures against.
 *
 * **Only the CONTENT is here.** The scaffolding — the seeded PRNG, the marker
 * file that doubles as the overwrite permit, the LF normalisation, the
 * per-extension tally — is the framework's `makeGeneratedWorkspace`
 * (`@hydranium/core/testing/node`), because none of it is grammar-specific and
 * all of it is easy to get subtly wrong in ways that only surface as an
 * unreproducible measurement. What an adopter writes is the `emit` callback
 * below. The rationale for each of those pieces lives on
 * `makeGeneratedWorkspace`; read it there rather than restating it here.
 *
 * **Parameterised by size on purpose, not fixed at one N.** The signal a perf
 * run carries is the CURVE across two sizes: an O(n²) regression in
 * discovery / indexing / scope / linking shows up as the large/small ratio
 * outrunning the file-count ratio, which a single-size number can never
 * reveal. This is a module rather than only a script so a bench can call it
 * in-process at two sizes instead of shelling out.
 *
 * **All three grammars, and the edges between them.** A corpus of `.domain`
 * files alone would measure a third of this example, so every generated project
 * carries `.domain` + `.process` + `.layout` content and the references that
 * cross those boundaries: `ProcessModel.subject` into a `.domain` `Entity`, the
 * three-deep `writes <Entity>.<field> = <literal>` effect chain, and
 * `LayoutModel.process` / `DiagramNode.flowNode` into a `.process`. Across
 * projects it emits `requires` edges — a hub on the generated `gen-core`
 * library project plus a chain between consecutive consumers — so the
 * project-scope filter has real dependency graphs to walk rather than one edge.
 *
 * **Every emitted file must be valid**, since the whole point is a workspace the
 * server can build: the acceptance run is
 * `hydranium-cli validate --services examples/order-flow/server/lib/services.js <root>`
 * reporting zero errors. Declaration, flow-node and process names are globally
 * unique, which also keeps the name-uniqueness integrity rules from firing —
 * their default silent sync mode would rewrite the corpus through the
 * serializer and the fixture would stop being byte-reproducible.
 *
 * **Freshness comes from a test, not from the build.** Nothing imports the
 * corpus, so a stale directory on someone's disk cannot break anything. What
 * can rot is this generator's agreement with the grammars — so a contract test
 * runs it at a small size on every `npm test` and builds the result, which
 * fails the moment a grammar change makes an emitted construct invalid.
 */

import { GENERATED_WORKSPACE_MARKER, makeGeneratedWorkspace } from '@hydranium/core/testing/node';

/**
 * Default corpus size: 15 projects × (1 descriptor + 21 member `.domain` +
 * 4 `.process` + 3 `.layout`) = 435 files, 436 documents once the stdlib
 * virtual document is counted.
 *
 * Changing these numbers is not free — a performance figure is only comparable
 * against another figure taken at the same size, so a run recorded before the
 * change can no longer be read beside one recorded after it. Pass explicit
 * sizes for a one-off corpus instead.
 */
export const LARGE_WORKSPACE_DEFAULTS = {
   projects: 15,
   entities: 21,
   processes: 4,
   seed: 20260827
} as const;

/**
 * Where a generated corpus records what produced it; also the overwrite permit.
 * The framework's default name, re-exported under the example's own so a reader
 * of the fixture test does not have to know which layer owns it.
 */
export const GENERATED_MARKER_FILE = GENERATED_WORKSPACE_MARKER;

/** Inputs to {@link generateLargeWorkspace}. Only `root` is required. */
export interface LargeWorkspaceOptions {
   /** Directory to write the corpus into. Created if absent, wiped if this generator wrote it. */
   root: string;
   /** Number of generated projects (folders), each with its own descriptor. Minimum 1. */
   projects?: number;
   /** Member `.domain` files per project, one entity + enum + value type each. Minimum 1. */
   entities?: number;
   /** `.process` files per project. Minimum 1; each but the last also gets a `.layout`. */
   processes?: number;
   /** Seed for the bounded content variation. The same seed reproduces the corpus byte for byte. */
   seed?: number;
}

/** Per-extension file tally of a generated corpus. */
export interface LargeWorkspaceFileCounts {
   domain: number;
   process: number;
   layout: number;
   /** Model files only — the marker and README are not model files. */
   total: number;
}

/** What {@link generateLargeWorkspace} wrote, and at which parameters. */
export interface LargeWorkspaceSummary {
   root: string;
   projects: number;
   entities: number;
   processes: number;
   seed: number;
   files: LargeWorkspaceFileCounts;
   /**
    * Documents the server ends up with: every model file plus the stdlib
    * virtual document, which is a `LangiumDocument` too and is what makes
    * `validate`'s file tally one higher than the file count.
    */
   documents: number;
}

/** Resolved sizes, after defaults and validation. */
interface ResolvedSizes {
   projects: number;
   entities: number;
   processes: number;
   seed: number;
}

/**
 * One generated project: its id as the `project` header spells it, the
 * identifier prefix its declarations carry, and the projects it `requires`.
 */
interface ProjectPlan {
   readonly id: string;
   readonly prefix: string;
   readonly dependencies: readonly ProjectPlan[];
}

/** A positive size, or a throw naming the flag that was wrong. */
function requirePositive(name: string, value: number): number {
   if (!Number.isInteger(value) || value < 1) {
      throw new Error(`--${name} must be a positive integer, got ${String(value)}`);
   }
   return value;
}

function resolveSizes(options: LargeWorkspaceOptions): ResolvedSizes {
   const seed = options.seed ?? LARGE_WORKSPACE_DEFAULTS.seed;
   if (!Number.isInteger(seed)) {
      throw new Error(`--seed must be an integer, got ${String(seed)}`);
   }
   return {
      projects: requirePositive('projects', options.projects ?? LARGE_WORKSPACE_DEFAULTS.projects),
      entities: requirePositive('entities', options.entities ?? LARGE_WORKSPACE_DEFAULTS.entities),
      processes: requirePositive('processes', options.processes ?? LARGE_WORKSPACE_DEFAULTS.processes),
      seed
   };
}

/**
 * Plan the project graph. Project 0 is the shared library every consumer
 * requires; project *n* additionally requires project *n-1*, so the dependency
 * graph is a hub plus a chain rather than a star — a project-scope filter walk
 * that reaches one hop deep on every edge is not evidence it reaches two.
 */
function planProjects(count: number): ProjectPlan[] {
   const plans: ProjectPlan[] = [];
   for (let index = 0; index < count; index++) {
      const dependencies: ProjectPlan[] = [];
      if (index > 0) {
         dependencies.push(plans[0]);
      }
      if (index > 1) {
         dependencies.push(plans[index - 1]);
      }
      plans.push({
         id: index === 0 ? 'gen-core' : `gen-app${index}`,
         prefix: index === 0 ? 'Core' : `App${index}`,
         dependencies
      });
   }
   return plans;
}

/** The seeded integer draw the framework generator supplies. */
type RandomInt = (minimum: number, maximum: number) => number;

/** Two-digit-minimum index, so a directory listing sorts the way the corpus reads. */
function pad(index: number): string {
   return String(index).padStart(2, '0');
}

const DO_NOT_EDIT = '// Generated fixture — regenerate with `npm run generate:large-workspace`; do not edit.';

/**
 * The project descriptor. Its `project` header is what makes the folder a
 * project, and its two `public` declarations are the only things a dependent
 * project can name — so they are what the `requires` edges below resolve to.
 */
function descriptorText(plan: ProjectPlan): string {
   const requires = plan.dependencies.length > 0 ? ` requires ${plan.dependencies.map(dependency => dependency.id).join(', ')}` : '';
   return `${DO_NOT_EDIT}

project ${plan.id}${requires}

public valuetype ${plan.prefix}Shared {
   value: String
}

public entity ${plan.prefix}Anchor {
   id: ${plan.prefix}Shared
   label: String
}
`;
}

/**
 * A member `.domain` file: one entity plus the enumeration and value type it is
 * typed with, so a `.process` effect chain has an enum to reach and the
 * declaration count per file is realistic.
 *
 * The `shared` field is the cross-project reference. It names the `public`
 * value type of the first dependency — the generated `gen-core` library — or,
 * in `gen-core` itself, its own, which resolves at the project tier instead.
 * `neighbour` adds the second edge where the plan has one.
 */
function memberText(plan: ProjectPlan, index: number, randomInt: RandomInt): string {
   const hub: ProjectPlan | undefined = plan.dependencies[0];
   const neighbour: ProjectPlan | undefined = plan.dependencies[1];
   const entity = `${plan.prefix}Entity${index}`;
   const status = `${plan.prefix}Status${index}`;
   const value = `${plan.prefix}Value${index}`;
   const fields = [
      `   id: String`,
      `   name: String`,
      `   active: Boolean`,
      `   status: ${status}`,
      `   amount: ${value}`,
      `   anchor: ${plan.prefix}Anchor`,
      `   shared: ${(hub ?? plan).prefix}Shared`
   ];
   if (neighbour) {
      fields.push(`   neighbour: ${neighbour.prefix}Shared`);
   }
   fields.push(`   tags: ${value}[]`);
   for (let extra = 0; extra < randomInt(0, 3); extra++) {
      fields.push(`   detail${extra}: String`);
   }
   return `${DO_NOT_EDIT}

entity ${entity} {
${fields.join('\n')}
}

enum ${status} { NEW, ACTIVE, DONE }

valuetype ${value} {
   amount: Number
   note: String
}
`;
}

/** The flow-node names a generated process declares, in emission order. */
function flowNodeNames(processName: string, extraSteps: number): string[] {
   const names = [`${processName}Start`, `${processName}Check`, `${processName}Ok`, `${processName}Fail`, `${processName}Done`];
   for (let step = 0; step < extraSteps; step++) {
      names.push(`${processName}Step${step}`);
   }
   return names;
}

/**
 * A `.process` file over one of its project's entities.
 *
 * Every reference here crosses a grammar boundary: `for <entity>` into the
 * `.domain` file, and each `writes` effect resolving the three-deep
 * `entity → field → literal` chain the process scope provider exists for.
 * With fewer entities than processes several processes share one entity, which
 * is the committed sample workspace's shape too — a `.domain` declaration is
 * shared rather than owned.
 */
function processText(plan: ProjectPlan, index: number, entityIndex: number, extraSteps: number): string {
   const processName = `${plan.prefix}Flow${index}`;
   const entity = `${plan.prefix}Entity${entityIndex}`;
   const names = flowNodeNames(processName, extraSteps);
   const lines = [
      `   task ${names[0]} writes ${entity}.status = NEW`,
      `   gateway ${names[1]}`,
      `      yes -> ${names[2]}`,
      `      no -> ${names[3]}`,
      `   task ${names[2]} writes ${entity}.status = ACTIVE`,
      `   task ${names[3]} reads ${entity}.id`,
      `   task ${names[4]} writes ${entity}.status = DONE`
   ];
   for (let step = 0; step < extraSteps; step++) {
      lines.push(`   task ${names[5 + step]} reads ${entity}.amount`);
   }
   lines.push(`   transition ${names[0]} -> ${names[1]}`, `   transition ${names[2]} -> ${names[4]}`);
   for (let step = 0; step < extraSteps; step++) {
      lines.push(`   transition ${names[4 + step]} -> ${names[5 + step]}`);
   }
   return `${DO_NOT_EDIT}

process ${processName} for ${entity} {
${lines.join('\n')}
}
`;
}

/**
 * Layout for a generated process, in the third grammar.
 *
 * The last flow node is deliberately left without an entry — the state of
 * anything added in text before a diagram has ever positioned it, and the same
 * asymmetry the committed sample workspace carries. `size` is omitted on every
 * third node, which is the partial-bounds overlay the grammar declares
 * optional, and the first entry's `y` is fractional because GLSP sends
 * client-measured bounds as floats.
 */
function layoutText(plan: ProjectPlan, index: number, nodeNames: readonly string[], randomInt: RandomInt): string {
   const processName = `${plan.prefix}Flow${index}`;
   const positioned = nodeNames.slice(0, -1);
   const entries = positioned.map((nodeName, order) => {
      const x = 40 + (order % 4) * 220 + randomInt(0, 8);
      const y = 40 + Math.floor(order / 4) * 140 + randomInt(0, 8);
      const at = order === 0 ? `${x}, ${y}.5` : `${x}, ${y}`;
      const size = order % 3 === 2 ? '' : ' size 160, 60';
      return `   node ${nodeName} at ${at}${size}`;
   });
   return `${DO_NOT_EDIT}

layout ${processName}Layout for ${processName} {
${entries.join('\n')}
}
`;
}

/** The corpus README — human-facing, and regenerated with the rest so it cannot drift. */
function readmeText(sizes: ResolvedSizes, files: LargeWorkspaceFileCounts): string {
   return `# order-flow generated large workspace

**Generated, not committed.** Every file here is written by
\`examples/order-flow/server/src/testing/large-workspace.ts\`; edits are lost on
the next run and the directory is gitignored.

- ${sizes.projects} projects, ${sizes.entities} entities and ${sizes.processes} processes each, seed ${sizes.seed}
- ${files.domain} \`.domain\`, ${files.process} \`.process\`, ${files.layout} \`.layout\` — ${files.total} model files

Regenerate:

\`\`\`bash
npm --prefix examples/order-flow/server run generate:large-workspace
\`\`\`

Check it builds clean (zero errors is the fixture's acceptance contract):

\`\`\`bash
node packages/cli/lib/cli.js validate \\
   --services examples/order-flow/server/lib/services.js \\
   examples/order-flow/workspace-large
\`\`\`
`;
}

/**
 * Write the corpus and return what was written.
 *
 * The draw order is fixed by the nested project → member → process → layout
 * walk, which is what makes the framework's single seeded stream reproduce the
 * same bytes at the same parameters. Reordering the emission, or drawing inside
 * one of the branches, breaks that.
 *
 * The README is emitted last and counted like any other file, so the framework
 * tally carries a `.md` entry the model-file subtotal below deliberately omits.
 */
export function generateLargeWorkspace(options: LargeWorkspaceOptions): LargeWorkspaceSummary {
   const sizes = resolveSizes(options);
   // Incremented per write rather than computed from the loop bounds, so a
   // skipped emission shows up as a wrong tally instead of as a right one over
   // a smaller corpus. The README needs the numbers before the generator
   // returns, which is why they are counted here and cross-checked against the
   // framework's own tally afterwards.
   const files: LargeWorkspaceFileCounts = { domain: 0, process: 0, layout: 0, total: 0 };

   const generated = makeGeneratedWorkspace({
      root: options.root,
      generator: 'order-flow/large-workspace',
      parameters: { projects: sizes.projects, entities: sizes.entities, processes: sizes.processes },
      seed: sizes.seed,
      emit(writer) {
         for (const plan of planProjects(sizes.projects)) {
            writer.directory(plan.id);
            writer.write(`${plan.id}/${plan.id}.domain`, descriptorText(plan));
            files.domain++;
            for (let index = 0; index < sizes.entities; index++) {
               writer.write(`${plan.id}/entity-${pad(index)}.domain`, memberText(plan, index, writer.randomInt));
               files.domain++;
            }
            for (let index = 0; index < sizes.processes; index++) {
               const extraSteps = writer.randomInt(0, 2);
               writer.write(`${plan.id}/flow-${pad(index)}.process`, processText(plan, index, index % sizes.entities, extraSteps));
               files.process++;
               // The last process of every project stays unpositioned, so the corpus
               // carries the "no layout file yet" case as well as the laid-out one.
               if (index < sizes.processes - 1) {
                  const names = flowNodeNames(`${plan.prefix}Flow${index}`, extraSteps);
                  writer.write(`${plan.id}/flow-${pad(index)}.layout`, layoutText(plan, index, names, writer.randomInt));
                  files.layout++;
               }
            }
         }
         files.total = files.domain + files.process + files.layout;
         writer.write('README.md', readmeText(sizes, files));
      }
   });

   // Two independent counts of the same writes must agree. They can only differ
   // if a model file was emitted under an extension this tally does not name,
   // which is the shape a new grammar arrives in.
   const modelFiles = (generated.files['.domain'] ?? 0) + (generated.files['.process'] ?? 0) + (generated.files['.layout'] ?? 0);
   if (modelFiles !== files.total) {
      throw new Error(`Generated ${modelFiles} model files but tallied ${files.total}; a file was emitted under an unexpected extension.`);
   }

   return { root: generated.root, ...sizes, files, documents: files.total + 1 };
}
