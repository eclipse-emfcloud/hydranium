/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Perf baselines for the framework's CPU-bound hot paths, exercised through the
 * real `order-flow` services. Run with `npm run bench` — these are a regression
 * SIGNAL for review, NOT a CI gate, so they are not wired into `vitest run` or
 * turbo's `test` pipeline (the `.bench.ts` suffix keeps `vitest run` from
 * loading them; `vitest bench` discovers them on its own).
 *
 * # Why every path is benched over THREE grammars sharing one tier
 *
 * That changes what the numbers mean rather than merely making them bigger:
 *
 * - parse / serialize / scope computation are benched per grammar, so a
 *   regression in one language's serializer cannot hide inside another's figure.
 *   `.domain` and `.process` have genuinely different shapes — one structural
 *   and name-heavy, one behavioural and reference-heavy.
 * - the scaling benches build a corpus with cross-PROJECT `requires` and
 *   cross-GRAMMAR reference edges, so the curve covers the global index and the
 *   linker doing real work, not N independent single-file parses.
 * - the warm interaction bench edits a `.domain` document and waits for its
 *   republish on the LSP head. The rebuild it provokes also relinks the
 *   `.process` and `.layout` documents that reference the edited one, through
 *   the shared index and the dependency tracking — so the timing covers a
 *   cross-grammar cascade rather than a single-file reparse.
 *
 * # Fixture, and why it is generated rather than committed
 *
 * The scaling and multi-client sections use the example's own deterministic
 * generator (`src/testing/large-workspace.ts`, the same one behind
 * `npm run generate:large-workspace`) written into temp dirs at two sizes. That
 * keeps the corpus out of git — a few hundred files at the default size — while
 * staying byte-reproducible from its seed, so two runs on one machine are
 * comparable.
 * Building the same generator into the bench also means the fixture cannot drift
 * from the one the recorded baseline was measured against.
 *
 * # Iteration counts are pinned on the expensive benches
 *
 * A cold build over a few hundred files takes long enough that tinybench's
 * default time budget would either run once or run for minutes. The cold-build
 * and re-projection benches therefore pin `iterations` explicitly: fewer samples,
 * but a bounded and comparable run. The micro benches keep the default budget.
 */

import 'reflect-metadata';
import { RequestBoundsAction, RequestModelAction, SOURCE_URI_ARG, ServerModule } from '@eclipse-glsp/server';
import { buildWorkspaceProgrammatically } from '@hydranium/core';
import { NodeFileSystem } from '@hydranium/core/node';
import { type LspHarness, makeLspHarness, makeLspServerConnection } from '@hydranium/core/testing/node';
import { DataServer } from '@hydranium/data-server';
import { type DataServerHarness, makeDataServerHarness } from '@hydranium/data-server/testing';
import { HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/testing';
import { DocumentState, type LangiumDocument, URI } from '@hydranium/langium';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, bench, describe } from 'vitest';
import { type OrderFlowGlspState } from '../src/glsp/order-flow-glsp-state.js';
import { OrderFlowProcessDiagramModule } from '../src/glsp/order-flow-process-diagram-module.js';
import type { DomainModel, ProcessModel } from '../src/language-server/ast.js';
import type {
   DomainModel as TransferDomainModel,
   ProcessModel as TransferProcessModel
} from '../src/language-server/generated-hydranium/transfer-model.js';
import { createOrderFlowServices } from '../src/language-server/order-flow-module.js';
import { generateLargeWorkspace } from '../src/testing/large-workspace.js';
import { WORKSPACE_ROOT } from './order-flow-harness.js';

/**
 * A medium `.domain` file: entities with primitive and reference fields, a value
 * type and an enumeration — broad enough that parse / serialize / scope
 * computation each touch every node kind the structural grammar has.
 */
const SAMPLE_DOMAIN = `project bench

entity Customer {
   name : String
   email : String
   tier : CustomerTier
   billing : Address
}

entity Order {
   reference : String
   placedBy : Customer
   total : Money
   status : OrderStatus
}

entity Shipment {
   order : Order
   destination : Address
}

valuetype Address {
   street : String
   city : String
   postcode : String
}

valuetype Money {
   amount : Number
   currency : String
}

enum CustomerTier {
   Standard,
   Premium
}

enum OrderStatus {
   NEW,
   PAID,
   SHIPPED
}
`;

/**
 * A medium `.process` file over the same entities: tasks with effects, a gateway
 * with branches, and explicit transitions — the reference-heavy shape, whose
 * effect chains reach into the `.domain` document above.
 */
const SAMPLE_PROCESS = `process Fulfillment for Order {
   task Validate
      reads Order.reference
   task Charge
      reads Order.total
      writes Order.status = PAID
   gateway PaymentOk
      yes -> Pick
      no -> Cancel
   task Pick
      reads Order.placedBy
   task Ship
      writes Order.status = SHIPPED
   task Cancel

   transition Validate -> Charge
   transition Charge -> PaymentOk
   transition Pick -> Ship
}
`;

const services = createOrderFlowServices();
const documentFactory = services.shared.workspace.LangiumDocumentFactory;

/** Parsed once for the read-only benches; the workspace builds use their own fixtures. */
const domainDocument: LangiumDocument<DomainModel> = documentFactory.fromString<DomainModel>(
   SAMPLE_DOMAIN,
   URI.parse('memory:///perf-bench.domain')
);
const processDocument: LangiumDocument<ProcessModel> = documentFactory.fromString<ProcessModel>(
   SAMPLE_PROCESS,
   URI.parse('memory:///perf-bench.process')
);

// `fromString` never throws on a syntax error — it returns a partial AST and
// parks the errors on `parseResult` — so a fixture that stops matching the
// grammar would leave every bench above timing error recovery over a broken
// tree, at plausible-looking speeds, with nothing red anywhere. Fail loudly at
// load instead.
for (const document of [domainDocument, processDocument]) {
   const errors = document.parseResult.parserErrors;
   if (errors.length > 0) {
      throw new Error(`${document.uri.path} does not parse: ${errors.map(error => error.message).join('; ')}`);
   }
}

describe('parse', () => {
   bench('LangiumDocumentFactory.fromString on a medium .domain file', () => {
      documentFactory.fromString<DomainModel>(SAMPLE_DOMAIN, URI.parse('memory:///perf-bench.domain'));
   });

   bench('LangiumDocumentFactory.fromString on a medium .process file', () => {
      documentFactory.fromString<ProcessModel>(SAMPLE_PROCESS, URI.parse('memory:///perf-bench.process'));
   });
});

describe('serialize', () => {
   // Per grammar, because a serializer is grammar-shaped: `order-flow` binds one
   // per language, so a single figure would average two independent code paths.
   bench('Serializer.serializeAst on a parsed .domain model', async () => {
      await services.Domain.serializer.Serializer.serializeAst(domainDocument.parseResult.value);
   });

   bench('Serializer.serializeAst on a parsed .process model', async () => {
      await services.Process.serializer.Serializer.serializeAst(processDocument.parseResult.value);
   });
});

describe('scope computation', () => {
   bench('ScopeComputation.collectExportedSymbols on a .domain document', async () => {
      await services.Domain.references.ScopeComputation.collectExportedSymbols(domainDocument);
   });

   bench('ScopeComputation.collectLocalSymbols on a .domain document', async () => {
      await services.Domain.references.ScopeComputation.collectLocalSymbols(domainDocument);
   });
});

describe('workspace build', () => {
   // The COMMITTED two-project sample: small, but it is the fixture every
   // integration test uses, so a regression here is one a reader can reproduce
   // without generating anything.
   bench(
      'cold buildWorkspaceProgrammatically over the committed order-flow-workspace',
      async () => {
         const built = createOrderFlowServices({ ...NodeFileSystem });
         await buildWorkspaceProgrammatically(built.shared, WORKSPACE_ROOT);
      },
      { iterations: 5, warmupIterations: 1, time: 0 }
   );
});

// ---------------------------------------------------------------------------
// Scaling benches.
//
// The real-world pain is the INITIAL BUILD of a large workspace. Two sizes from
// the example's own generator, written to temp dirs so the real NodeFileSystem
// discovery + build pipeline runs. The SIGNAL is the CURVE across sizes: a
// linear→quadratic regression in index / scope / linking shows up as the
// large/small ratio blowing past the project-count ratio, which a single-size
// number can never reveal.
//
// Sizes are below the generator's default on purpose: a bench runs its body
// several times over, and the full default corpus makes each iteration a
// multi-second build. The RATIO rather than the absolute figure is what carries
// over to a full-size run.
// ---------------------------------------------------------------------------

const SMALL_PROJECTS = 3;
const LARGE_PROJECTS = 12;

/** Generate a corpus of `projects` projects into a fresh temp dir; returns the root. */
function writeCorpus(projects: number): string {
   const root = fs.mkdtempSync(path.join(os.tmpdir(), 'order-flow-bench-'));
   generateLargeWorkspace({ root, projects });
   return root;
}

const smallCorpus = writeCorpus(SMALL_PROJECTS);
const largeCorpus = writeCorpus(LARGE_PROJECTS);

// Removed unconditionally, unlike the fixture copies the tests keep on failure:
// a corpus is GENERATED input, reproducible from `writeCorpus` alone, so it
// witnesses nothing about a run. It is also the largest artefact here, and it is
// built at module scope, so nothing else bounds its lifetime.
afterAll(() => {
   for (const corpus of [smallCorpus, largeCorpus]) {
      fs.rmSync(corpus, { recursive: true, force: true });
   }
   if (wireByteObservations.length > 0) {
      process.stdout.write(`\n[perf] LSP hover wire-byte observations: ${JSON.stringify(wireByteObservations)}\n`);
   }
   for (const [name, observations] of Object.entries(probeObservations)) {
      if (observations.length > 0) {
         process.stdout.write(`[perf] ${name} ms observations: ${JSON.stringify(observations)}\n`);
      }
   }
});

describe('large workspace cold build (scaling)', () => {
   bench(
      `cold build of ${SMALL_PROJECTS} projects`,
      async () => {
         const built = createOrderFlowServices({ ...NodeFileSystem });
         await buildWorkspaceProgrammatically(built.shared, smallCorpus);
      },
      { iterations: 5, warmupIterations: 1, time: 0 }
   );

   bench(
      `cold build of ${LARGE_PROJECTS} projects`,
      async () => {
         const built = createOrderFlowServices({ ...NodeFileSystem });
         await buildWorkspaceProgrammatically(built.shared, largeCorpus);
      },
      { iterations: 5, warmupIterations: 1, time: 0 }
   );
});

// ---------------------------------------------------------------------------
// Multi-client benches — a large workspace with all three heads attached, both
// at initial load AND during live editing.
//
// This wires the topology of `main.ts` (and mirrors `coherence.integration.test.ts`):
// the LSP connection is born first, the ONE tree is built around it, then all
// three head harnesses attach to the same `services.shared`.
//
// Two shapes: COLD start is a one-shot event, so it is measured ONCE and logged
// rather than looped; WARM interaction sets the heads up once and benches
// iteration-stable cross-head operations.
// ---------------------------------------------------------------------------

const DIAGRAM_TYPE = 'order-flow-process';

type OrderFlowServiceTree = ReturnType<typeof createOrderFlowServices>;

/** One `DataServer` serves every grammar, exactly as `main.ts` declares it. */
class BenchDataServer extends DataServer<TransferDomainModel | TransferProcessModel> {}

interface Heads {
   readonly services: OrderFlowServiceTree;
   readonly lsp: LspHarness;
   readonly data: DataServerHarness<BenchDataServer, TransferDomainModel | TransferProcessModel>;
   readonly glsp: GlspHarness<OrderFlowGlspState>;
}

/** Boot LSP + data-server + GLSP heads on one shared tree over `workspaceDir`, built to ready. */
async function bootHeads(workspaceDir: string): Promise<Heads> {
   const lspWire = makeLspServerConnection();
   const tree = createOrderFlowServices({ connection: lspWire.serverConnection, ...NodeFileSystem });
   const lsp = makeLspHarness({ connection: lspWire, services: tree.shared });
   const data = makeDataServerHarness<BenchDataServer, TransferDomainModel | TransferProcessModel>({
      server: channel => new BenchDataServer(channel, tree.shared)
   });
   const glsp = makeGlspHarness<OrderFlowGlspState>({
      serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
      diagramType: DIAGRAM_TYPE,
      appModules: [new HydraniumGlspAppModule({ shared: tree.shared })]
   });
   await lsp.initialize({ workspaceFolders: [{ uri: URI.file(workspaceDir).toString(), name: 'bench' }] });
   await tree.shared.workspace.WorkspaceManager.ready;
   await glsp.start();
   return { services: tree, lsp, data, glsp };
}

// Measured ONCE: booting three servers repeatedly in one process is neither a
// meaningful steady-state metric nor stable. This boot doubles as the warm tree
// the interaction benches reuse. The number is logged, not asserted.
const coldStartBegin = performance.now();
const warm = await bootHeads(largeCorpus);
// Straight to stdout: vitest intercepts `console.*` emitted during module
// evaluation, before any task runs, so the number would vanish.
process.stdout.write(
   `\n[perf] multi-client cold start to ready (LSP + data-server + GLSP, ` +
      `${LARGE_PROJECTS} projects): ${(performance.now() - coldStartBegin).toFixed(0)} ms\n\n`
);

/**
 * Pick the first file matching `suffix` under the corpus, in sorted order.
 *
 * Discovered rather than hardcoded: the generator owns its naming (`gen-core` /
 * `gen-appN` holding `entity-NN.domain` and `flow-NN.process`), and a bench that
 * spells those out breaks silently the day the generator renames anything. A
 * missing file throws here instead, naming the corpus root.
 */
function firstFile(root: string, suffix: string): string {
   const matches = fs
      .readdirSync(root, { recursive: true, encoding: 'utf-8' })
      .filter(entry => entry.endsWith(suffix))
      .sort();
   const match = matches[0];
   if (match === undefined) {
      throw new Error(`No '${suffix}' file under the generated corpus at ${root}.`);
   }
   return path.join(root, match);
}

// The entity file sorts to `gen-app1`'s first member — a project member rather
// than a descriptor, so its declarations are what that project's `.process` and
// `.layout` documents reference. The edit below therefore fans out across
// grammars through the global index rather than staying inside one file, which
// is the crossing worth timing.
const editedDocPath = firstFile(largeCorpus, '.domain');
const editedDocUri = URI.file(editedDocPath).toString();
const diagramDocPath = firstFile(largeCorpus, '.process');
const diagramDocUri = URI.file(diagramDocPath).toString();

const repairCleanText = `entity Solo {
   a : string
}
`;
const repairDuplicateText = `entity Twin {
   a : string
}

entity Twin {
   b : string
}
`;
const repairServices = createOrderFlowServices({ ...NodeFileSystem });
const repairUri = URI.parse('memory:///perf-integrity-repair.domain');
const repairDocuments = repairServices.shared.workspace.TextDocuments;
const repairBuilder = repairServices.shared.workspace.DocumentBuilder;
repairDocuments.notifyDidOpenTextDocument({
   textDocument: { uri: repairUri.toString(), languageId: 'domain', version: 1, text: repairCleanText }
});
await repairBuilder.update([repairUri], []);
await repairBuilder.waitUntil(DocumentState.Validated, repairUri);
let repairVersion = 1;
let repairToggle = false;
const wireByteObservations: number[] = [];
const probeObservations: Record<string, number[]> = {
   'local edit': [],
   'integrity repair': [],
   reconnect: [],
   'concurrent three-head operations': []
};

/**
 * The phase tinybench is running the current bench in, set through its `setup`
 * hook. The probes record only `'run'` calls: the warmup is excluded from the
 * Vitest statistics beside them, and it is also the call most likely to overlap
 * setup, so a warmup sample would make the raw series disagree with the table.
 */
let benchPhase: 'warmup' | 'run' = 'warmup';
const trackPhase = {
   setup: (_task: unknown, mode: 'warmup' | 'run'): void => {
      benchPhase = mode;
   }
};

function recordSample(samples: number[], value: number): void {
   if (benchPhase === 'run' && samples.length < 10) {
      samples.push(value);
   }
}

// Two valid variants of the same document, toggled per iteration so every edit
// is a real change (guaranteeing a rebuild + republish) without the model
// growing across iterations.
const editVariantA = fs.readFileSync(editedDocPath, 'utf-8');
const editVariantB = `${editVariantA}\n// bench edit\n`;
// Awaited before the suite: the open's own build would otherwise still be
// running while the first warm bench is being measured.
const diagramOpened = warm.lsp.nextDiagnostics(diagramDocUri);
warm.lsp.openDocument(diagramDocUri, fs.readFileSync(diagramDocPath, 'utf-8'), 'process', 1);
await diagramOpened;
let editToggle = 0;
let concurrentToggle = false;

describe('warm cross-head interaction (large workspace, 3 heads attached)', () => {
   bench(
      'text edit on a .domain document rebuilds and republishes to the LSP head',
      async () => {
         const started = performance.now();
         const republished = warm.lsp.nextDiagnostics(editedDocUri);
         const model = editToggle++ % 2 === 0 ? editVariantA : editVariantB;
         await warm.data.proxy.updateModelDocument({ uri: editedDocUri, clientId: 'bench-text', model, basedOn: 'anything' });
         await republished;
         recordSample(probeObservations['local edit'], performance.now() - started);
      },
      trackPhase
   );

   bench(
      'graph head re-projects a .process diagram (RequestModel)',
      async () => {
         warm.glsp.dispatch(RequestModelAction.create({ options: { [SOURCE_URI_ARG]: diagramDocPath } }));
         await warm.glsp.nextAction(RequestBoundsAction.KIND);
      },
      { iterations: 10, warmupIterations: 1, time: 0 }
   );

   bench(
      'open-document edit alternating between a clean and a repairing text',
      async () => {
         const started = performance.now();
         repairToggle = !repairToggle;
         repairVersion++;
         repairDocuments.notifyDidChangeTextDocument({
            textDocument: { uri: repairUri.toString(), version: repairVersion },
            contentChanges: [{ text: repairToggle ? repairDuplicateText : repairCleanText }]
         });
         await repairBuilder.update([repairUri], []);
         await repairBuilder.waitUntil(DocumentState.Validated, repairUri);
         // Only the duplicate half repairs; the clean half is a plain rebuild,
         // and a sample of it would dilute the repair figure.
         if (repairToggle) {
            recordSample(probeObservations['integrity repair'], performance.now() - started);
         }
      },
      { iterations: 10, warmupIterations: 1, time: 0, ...trackPhase }
   );

   bench(
      'LSP hover round-trip wire bytes',
      async () => {
         // The counter sees everything on the wire, so an earlier bench's
         // cascade publishes still in flight would land in this delta. Settle
         // the builder first so the delta is the hover's alone.
         await warm.services.shared.model.ModelService.waitForBuilderState(DocumentState.Validated);
         const before = warm.lsp.wireBytes().total;
         await warm.lsp.hover(diagramDocUri, { line: 0, character: 0 });
         recordSample(wireByteObservations, warm.lsp.wireBytes().total - before);
      },
      { iterations: 10, warmupIterations: 1, time: 0, ...trackPhase }
   );

   bench(
      'data-head reconnect open and watch',
      async () => {
         const started = performance.now();
         const reconnect = makeDataServerHarness<BenchDataServer, TransferDomainModel | TransferProcessModel>({
            server: channel => new BenchDataServer(channel, warm.services.shared)
         });
         await reconnect.proxy.openModelDocument({ uri: diagramDocUri, clientId: 'bench-reconnect' });
         await reconnect.proxy.watchModelDocument({ uri: diagramDocUri, clientId: 'bench-reconnect' });
         reconnect.dispose();
         recordSample(probeObservations.reconnect, performance.now() - started);
      },
      { iterations: 10, warmupIterations: 1, time: 0, ...trackPhase }
   );

   bench(
      'data write, LSP republish and GLSP model request issued together',
      async () => {
         const started = performance.now();
         const diagnosticsAt = warm.lsp.diagnostics.length;
         const editedDiagnostics = warm.lsp.nextDiagnostics(editedDocUri, { fromIndex: diagnosticsAt });
         const boundsAction = warm.glsp.nextAction(RequestBoundsAction.KIND);
         const model = concurrentToggle ? editVariantA : editVariantB;
         concurrentToggle = !concurrentToggle;
         const dataUpdate = warm.data.proxy.updateModelDocument({
            uri: editedDocUri,
            clientId: 'bench-concurrent',
            model,
            basedOn: 'anything'
         });
         // The GLSP model is requested here, not pushed by the edit: the
         // diagram document need not depend on the edited one, so this times
         // three heads working at once rather than one edit fanning out.
         warm.glsp.dispatch(RequestModelAction.create({ options: { [SOURCE_URI_ARG]: diagramDocPath } }));
         await Promise.all([editedDiagnostics, dataUpdate, boundsAction]);
         recordSample(probeObservations['concurrent three-head operations'], performance.now() - started);
      },
      { iterations: 10, warmupIterations: 1, time: 0, ...trackPhase }
   );
});
