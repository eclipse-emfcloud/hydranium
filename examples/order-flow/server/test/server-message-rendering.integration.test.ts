/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Server-side message rendering, over the real wire and through two heads.
 *
 * # What only an integration suite can assert
 *
 * `@hydranium/core`'s unit tests cover the renderer's own behaviour. What they
 * cannot reach is the pair of claims that make the invariant true rather than
 * approximately true, and both are properties of the RUN rather than of a class:
 *
 * - **The render happens before the publish.** Langium publishes from
 *   `addDiagnosticsHandler`, a free function it registers on
 *   `onDocumentPhase(Validated)`; being a function and not a service it can only
 *   be outrun, not overridden. Every assertion here therefore reads the
 *   PUBLISHED NOTIFICATION, never `document.diagnostics` — reading the document
 *   cannot distinguish "rendered in time" from "rendered late".
 *   **And reading the notification is necessary but not sufficient:**
 *   `sendDiagnostics` hands the array over by reference and serialises later, so
 *   a pass that mutated `diagnostic.message` IN PLACE would reach the wire even
 *   when it ran after the publisher. The framework pass replaces entries, which
 *   is what lets the control below redden at all.
 * - **One pass, and every head inherits it.** The LSP publish and the data
 *   head's `TransferDiagnostic` are read over the same document with one
 *   renderer installed, so a per-head render would surface as one head carrying
 *   English.
 *
 * # Why order-flow, and which codes the fixtures use
 *
 * The diagnostics here come from three producers, and one binding has to serve
 * all three: an adopter check carrying its own `defineMessage` code, Langium's
 * parser carrying none, and Langium's linker — whose sentence the framework
 * claims as `UNRESOLVED_REFERENCE`, over a CROSS-GRAMMAR reference that exists
 * in no single grammar.
 *
 * `hydranium/core/separator-in-name` appears in none of them: it is the
 * framework's other identity-bearing validation diagnostic and is unreachable
 * from any grammar, firing on a name containing the qualified-name separator
 * that no `ID` terminal admits. Its arm is unit-tested in `core` against a
 * synthetic diagnostic instead.
 *
 * # The locale is a TEST locale
 *
 * `xx-AA` and its catalogue live in this file and nowhere else. The framework
 * ships English only and selects no locale, and this example ships no server
 * catalogue either — a real tag would suggest the framework has an opinion about
 * which languages exist.
 */

import { DataServer } from '@hydranium/data-server';
import { type DataServerHarness, makeDataServerHarness } from '@hydranium/data-server/testing';
import { NodeFileSystem } from '@hydranium/core/node';
import { initializeWorkspaceProgrammatically } from '@hydranium/core';
import { MODEL_UPDATE_EDIT, resolvedFromDiagnostic, DefaultMessageRenderer, UNRESOLVED_REFERENCE } from '@hydranium/core/messages';
import { makeNoopSharedServices } from '@hydranium/core/testing';
import {
   type LspHarness,
   makeLspHarness,
   makeLspServerConnection,
   makeScratchWorkspace,
   type ScratchWorkspace
} from '@hydranium/core/testing/node';
import { URI } from '@hydranium/langium';
import type { Diagnostic } from 'vscode-languageserver-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessLanguageMetaData } from '../src/language-server/generated/module.js';
import { createOrderFlowServices, type OrderFlowSharedServices } from '../src/language-server/order-flow-module.js';
import { OrderFlowMessageRenderer } from '../src/language-server/order-flow-message-renderer.js';
import { SELF_TRANSITION } from '../src/messages/index.js';
import type { DomainModel, ProcessModel } from '../src/language-server/generated-hydranium/transfer-model.js';
import { WORKSPACE_FILES, WORKSPACE_ROOT } from './order-flow-harness.js';

/** The two transfer roots this suite may open. */
type OrderFlowTransfer = DomainModel | ProcessModel;

/** A locale that exists only here — see the file comment. */
const TEST_LOCALE = 'xx-AA';

/**
 * Catalogue for {@link TEST_LOCALE}, keyed by message code. Deliberately NOT a
 * plausible translation: a marker makes an assertion say which side produced the
 * sentence, which a plausible German would not.
 */
const TEST_CATALOGUE: Record<string, string> = {
   [SELF_TRANSITION.code]: "RENDERED loop on '{step}'",
   [UNRESOLVED_REFERENCE.code]: "RENDERED unresolved '{refText}'",
   [MODEL_UPDATE_EDIT.code]: 'RENDERED edit'
};

/** Prefix the test renderer puts on Langium's own sentences, so the seam is observable. */
const FOREIGN_MARK = 'FOREIGN> ';

/** The rendered form of {@link SELF_TRANSITION} for the one step this suite uses. */
const RENDERED_SELF_TRANSITION = "RENDERED loop on 'Pay'";
/** Its untranslated form — what a pass-through must produce, byte for byte. */
const ENGLISH_SELF_TRANSITION = SELF_TRANSITION.format({ step: 'Pay' });

/**
 * Serves {@link TEST_CATALOGUE} for {@link TEST_LOCALE} and marks every message
 * with NO identity — the only way to observe that Langium's lexer, parser and
 * linker sentences reach the seam at all. Rendering those is the capability
 * client-side rendering cannot have: none of them carries a code a client could
 * look up.
 *
 * It discriminates on the structured field, never on the sentence: an
 * identity-bearing message with no catalogue entry also comes back from `super`
 * unchanged, so inferring "no identity" from an unchanged text would mark the
 * no-catalogue cases as foreign.
 */
class TestRenderer extends DefaultMessageRenderer {
   protected override translationsFor(locale: string | undefined): Record<string, string> | undefined {
      return locale === TEST_LOCALE ? TEST_CATALOGUE : undefined;
   }

   override renderDiagnostic(diagnostic: Diagnostic): string {
      const rendered = super.renderDiagnostic(diagnostic);
      return resolvedFromDiagnostic(diagnostic) ? rendered : FOREIGN_MARK + rendered;
   }
}

/** An adopter catalogue with a bad key — the failure the no-throw contract exists for. */
class ThrowingRenderer extends DefaultMessageRenderer {
   protected override translationsFor(): Record<string, string> | undefined {
      throw new Error('catalogue lookup exploded');
   }
}

/** Which renderer a boot installs. `'framework'` leaves the framework default bound. */
type RendererChoice = 'framework' | 'test' | 'throwing';

/** Shared-tier override installing one of the renderers above. */
function rendererModule(choice: RendererChoice) {
   return {
      MessageRenderer: (services: OrderFlowSharedServices) =>
         choice === 'throwing'
            ? new ThrowingRenderer(services)
            : choice === 'test'
              ? new TestRenderer(services)
              : new DefaultMessageRenderer(services)
   };
}

interface Booted {
   readonly shared: OrderFlowSharedServices;
   readonly lsp: LspHarness;
   readonly data: DataServerHarness<DataServer<OrderFlowTransfer>, OrderFlowTransfer>;
   readonly uri: (relativePath: string) => string;
}

let booted: Booted | undefined;
let scratch: ScratchWorkspace | undefined;
/** Held apart from {@link booted}: the race suite owns the harness but no data head. */
let raceHarness: LspHarness | undefined;

/** Boot the LSP and data heads on ONE tree over a throwaway workspace copy. */
async function boot(choice: RendererChoice, locale: string | undefined = TEST_LOCALE): Promise<Booted> {
   scratch = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-render-' });
   const workspace = scratch;
   const wire = makeLspServerConnection();
   const services = createOrderFlowServices(
      { connection: wire.serverConnection, ...NodeFileSystem },
      { extraSharedModules: [rendererModule(choice)] }
   );
   const lsp = makeLspHarness({ connection: wire, services: services.shared });
   const data = makeDataServerHarness<DataServer<OrderFlowTransfer>, OrderFlowTransfer>({
      server: channel => new DataServer<OrderFlowTransfer>(channel, services.shared)
   });
   // The locale rides the real `initialize`, so these assertions exercise the
   // capture path rather than a hand-set field.
   await lsp.initialize({ locale, workspaceFolders: [{ uri: URI.file(workspace.root).toString(), name: 'order-flow' }] });
   booted = { shared: services.shared, lsp, data, uri: relativePath => URI.file(workspace.resolve(relativePath)).toString() };
   return booted;
}

/**
 * The sentence of a diagnostic. `Diagnostic.message` is `string | MarkupContent`
 * in LSP 3.17+, and every message asserted here is the string form.
 */
function sentence(diagnostic: Diagnostic): string {
   return typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value;
}

/** Open `text` at a fresh `.process` URI and return the PUBLISHED diagnostic messages. */
async function publishedMessages(active: Booted, name: string, text: string): Promise<string[]> {
   const target = active.uri(`orders/${name}.process`);
   const published = active.lsp.nextDiagnostics(target);
   active.lsp.openDocument(target, text, ProcessLanguageMetaData.languageId);
   return (await published).map(sentence);
}

/** An adopter diagnostic with a parameterised sentence: a task transitioning to itself. */
const SELF_TRANSITION_SOURCE = 'process Probe for Order {\n   task Pay\n   transition Pay -> Pay\n}\n';
/** A parser error: the process body is never closed. Reaches no validation acceptor. */
const PARSE_ERROR_SOURCE = 'process Probe for Order {\n   task\n';
/** A cross-grammar linking error: no `Missing` entity exists in any `.domain`. */
const LINKING_ERROR_SOURCE = 'process Probe for Missing {\n   task Pay\n}\n';

describe('order-flow server-side message rendering', () => {
   afterEach(() => {
      booted?.data.dispose();
      booted?.lsp.dispose();
      booted = undefined;
      scratch?.dispose();
      scratch = undefined;
   });

   it('publishes an identity-bearing diagnostic RENDERED, parameters included', async () => {
      const active = await boot('test');

      const messages = await publishedMessages(active, 'self-transition', SELF_TRANSITION_SOURCE);

      // The parameterised form on the SQUIGGLE's own carrier. This is what
      // client-side rendering could never deliver: Monaco's `IMarkerData` has no
      // slot for the params, so a client could only ever show the English.
      expect(messages).toEqual([RENDERED_SELF_TRANSITION]);
   });

   it('publishes the English with no renderer installed — the control on the row above', async () => {
      // The control the design's table asks for, kept as a sibling assertion so
      // it cannot rot: a diagnostic COUNT is invariant under a missing render, so
      // the discriminating read is the rendered string.
      const active = await boot('framework');

      const messages = await publishedMessages(active, 'self-transition', SELF_TRANSITION_SOURCE);

      expect(messages).toEqual([ENGLISH_SELF_TRANSITION]);
   });

   it('publishes the English when the locale has no catalogue', async () => {
      // The framework selects no locale and ships no catalogue, so this is a
      // shipped path rather than a degenerate one — and it separates "a renderer
      // is installed" from "the locale resolved to something".
      const active = await boot('test', 'zz-ZZ');

      const messages = await publishedMessages(active, 'self-transition', SELF_TRANSITION_SOURCE);

      expect(messages).toEqual([ENGLISH_SELF_TRANSITION]);
   });

   it('routes a PARSER error through the seam, which no validation hook can see', async () => {
      const active = await boot('test');

      const messages = await publishedMessages(active, 'parse-error', PARSE_ERROR_SOURCE);

      // Langium pushes lexer and parser errors straight onto the document
      // without routing them through `toDiagnostic`, so anything hooked to the
      // validation acceptor misses them entirely. The mark is what proves a pass
      // over the FINISHED list sees them.
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.every(message => message.startsWith(FOREIGN_MARK))).toBe(true);
   });

   it('renders a cross-grammar LINKING error from the framework identity', async () => {
      const active = await boot('test');

      const messages = await publishedMessages(active, 'linking-error', LINKING_ERROR_SOURCE);

      // Langium words this one, and the framework claims it: the identity makes
      // the most-seen validation error in any language renderable without an
      // adopter special-casing Langium's `data.code` shape.
      expect(messages).toEqual(["RENDERED unresolved 'Missing'"]);
   });

   it('publishes the English linking sentence with no catalogue — the control above', async () => {
      const active = await boot('framework');

      const messages = await publishedMessages(active, 'linking-error', LINKING_ERROR_SOURCE);

      // Byte-identical to Langium's own wording, which is the constraint the
      // declaration carries: claiming the message must not change the text an
      // adopter without a catalogue sees.
      expect(messages).toEqual(["Could not resolve reference to Entity named 'Missing'."]);
   });

   it('keeps Langium data.code on the identified linking error', async () => {
      const active = await boot('test');
      const target = active.uri('orders/linking-data.process');

      const published = active.lsp.nextDiagnostics(target);
      active.lsp.openDocument(target, LINKING_ERROR_SOURCE, ProcessLanguageMetaData.languageId);
      const [diagnostic] = await published;

      // `stopAfterLinkingErrors` and Langium's code-action dispatch both switch
      // on `data.code`, so the framework identity is merged OVER it rather than
      // replacing it.
      expect(diagnostic.code).toBe(UNRESOLVED_REFERENCE.code);
      expect(diagnostic.data).toMatchObject({ code: 'linking-error', hydranium: { code: UNRESOLVED_REFERENCE.code } });
   });

   it('does not lose a diagnostic to a renderer that throws', async () => {
      const active = await boot('throwing');

      const messages = await publishedMessages(active, 'throwing', SELF_TRANSITION_SOURCE);

      // An empty diagnostic list and a swallowed error look alike, so this
      // asserts the ORIGINAL TEXT rather than a count: the message has to
      // arrive, untranslated. A throw propagating out of the pass would take
      // `notifyDocumentPhase` with it and the client would receive nothing for
      // this file at all.
      expect(messages).toEqual([ENGLISH_SELF_TRANSITION]);
   });

   it('renders once for BOTH heads, so the data head carries the same sentence', async () => {
      const active = await boot('test');
      const target = active.uri('orders/two-heads.process');

      // The LSP head first, which also settles the document at `Validated`.
      const published = active.lsp.nextDiagnostics(target);
      active.lsp.openDocument(target, SELF_TRANSITION_SOURCE, ProcessLanguageMetaData.languageId);
      const lspMessages = (await published).map(sentence);

      const document = await active.data.proxy.getModelDocument({ uri: target, includeDiagnostics: true });

      // ONE pass over `document.diagnostics`, which both heads read. A per-head
      // render would surface here as one head holding the English.
      expect(lspMessages).toEqual([RENDERED_SELF_TRANSITION]);
      expect(document.diagnostics.map(diagnostic => diagnostic.message)).toEqual(lspMessages);
   });

   it('keeps the identity on the wire, now for identification rather than rendering', async () => {
      const active = await boot('test');
      const target = active.uri('orders/identity.process');

      const published = active.lsp.nextDiagnostics(target);
      active.lsp.openDocument(target, SELF_TRANSITION_SOURCE, ProcessLanguageMetaData.languageId);
      const [diagnostic] = await published;

      // Rendering server-side does not retire the identity: a client still needs
      // it to FILTER, group or assert on a message, and a test asserting on a
      // rendered sentence would otherwise be asserting on a translation.
      expect(diagnostic.code).toBe(SELF_TRANSITION.code);
      expect(diagnostic.data).toMatchObject({ hydranium: { code: SELF_TRANSITION.code } });
   });
});

describe('the headless locale seam', () => {
   afterEach(() => {
      scratch?.dispose();
      scratch = undefined;
   });

   /**
    * Build one authored document headlessly and return its rendered messages.
    *
    * No LSP connection at all, which is the point: this is the path
    * `data-server-main.ts` and the CLI subcommands take, and their only way to
    * declare a locale is the init options parameter this exercises.
    *
    * Only the renderer is substituted; the locale reaches `ServerLocale`
    * through the synthesized init params, exactly as over a real connection.
    */
   async function headlessMessages(locale: string | undefined): Promise<string[]> {
      scratch = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-headless-' });
      const workspace = scratch;
      const services = createOrderFlowServices({ ...NodeFileSystem }, { extraSharedModules: [rendererModule('test')] });
      workspace.write('orders/headless.process', SELF_TRANSITION_SOURCE);
      await initializeWorkspaceProgrammatically(services.shared, workspace.root, { locale });

      const uri = URI.file(workspace.resolve('orders/headless.process'));
      const document = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(uri);
      await services.shared.workspace.DocumentBuilder.build([document], { validation: true });
      return (document.diagnostics ?? []).map(sentence);
   }

   it('renders in the locale the options parameter carried', async () => {
      expect(await headlessMessages(TEST_LOCALE)).toEqual([RENDERED_SELF_TRANSITION]);
   });

   it('renders English when the option is omitted — the control on the row above', async () => {
      // A default-English assertion passes in BOTH states unless a catalogue is
      // installed, so the renderer is the SAME one: only the option differs.
      expect(await headlessMessages(undefined)).toEqual([ENGLISH_SELF_TRANSITION]);
   });
});

/**
 * Every payload of a real rebuild fan-out is rendered — the whole fan-out, not
 * one sampled publish.
 *
 * # What this does and does not establish
 *
 * The pass runs BEFORE the phase listeners, not atomically with them: the loop
 * awaits, and Langium's `validate` pushes onto the live diagnostics array rather
 * than replacing it, so a second build settling inside that window appends
 * entries the pass never saw and the first build's publisher sends them
 * unrendered. `ModelServiceOptions.serializeBuilds` closes that window and
 * defaults to `true`.
 *
 * **It does NOT witness that window, and that was measured rather than
 * assumed:** with `serializeBuilds: false` this suite still passed on three
 * consecutive runs. So the absolute assertion below pins the DEFAULT
 * configuration and nothing more — a leak on the opt-out path would not redden
 * it. That is the same limit the dedupe suite reached and stated, and closing it
 * needs a test that drives the append window deterministically rather than
 * waiting for load to open it.
 *
 * What it does add over the single-payload suites above: those read one publish,
 * and a write fans out several. A render that stopped covering a rebuild-driven
 * publish while still covering the first-open one would pass every one of them.
 *
 * Needs a real connection for the same reason the dedupe suite does: headless
 * there is exactly ONE build of the URI and no second pass to race.
 */
describe('rendering across a racing rebuild', () => {
   afterEach(() => {
      raceHarness?.dispose();
      raceHarness = undefined;
      scratch?.dispose();
      scratch = undefined;
   });

   /** The rendered and English forms of the workspace's one intended error. */
   const RENDERED_UNRESOLVED = "RENDERED unresolved 'AuditStamp'";
   const ENGLISH_UNRESOLVED_PREFIX = 'Could not resolve reference to';

   /**
    * Drive a write that provokes two builds and return EVERY message published
    * for the URI as a result.
    *
    * Every payload, not the next one. A write fans out several publishes and the
    * one carrying an appended diagnostic is not necessarily the one a
    * `nextDiagnostics` wait samples — `LspServerConnection.diagnostics`
    * documents the tool for a fan-out, which is to record the length before
    * acting and read the tail.
    */
   async function messagesAcrossRace(): Promise<{ messages: string[]; payloadCount: number }> {
      scratch = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-race-' });
      const workspace = scratch;
      let shared: OrderFlowSharedServices | undefined;
      const booted = makeLspHarness({
         createServices: connection => {
            shared = createOrderFlowServices({ connection, ...NodeFileSystem }, { extraSharedModules: [rendererModule('test')] }).shared;
            return shared;
         }
      });
      raceHarness = booted;
      await booted.initialize({ locale: TEST_LOCALE, workspaceFolders: [{ uri: workspace.uri(), name: 'order-flow' }] });
      if (!shared) {
         throw new Error('createServices did not run');
      }

      const uri = workspace.uri(WORKSPACE_FILES.auditLeak);
      const document = await shared.workspace.LangiumDocuments.getOrCreateDocument(URI.parse(uri));
      await shared.workspace.DocumentBuilder.build([document], { validation: true });
      const text = document.textDocument.getText();

      // Opened as a client would, so Langium's text-change bridge has a synced
      // document to react to. Without it the facade is the only builder and
      // there is no second build to race.
      booted.openDocument(uri, text, 'order-flow-domain');

      const before = booted.diagnostics.length;
      await shared.model.ModelService.update({ uri, model: `${text}\n// touched\n`, clientId: 'render-race' });
      await booted.nextDiagnostics(uri);
      // Let any FOLLOWING publish from the second build land too, or the tail
      // holds only the first payload and an unrendered append escapes.
      await new Promise(resolve => setTimeout(resolve, 300));

      const payloads = booted.diagnostics.slice(before).filter(published => published.uri === uri);
      return {
         messages: payloads.flatMap(published => published.diagnostics.map(sentence)),
         payloadCount: payloads.length
      };
   }

   it('publishes no unrendered diagnostic, in any payload of the fan-out', async () => {
      const { messages, payloadCount } = await messagesAcrossRace();

      // The premise, asserted rather than assumed: a write really does fan out
      // more than one publish here. At one payload this suite would be a slower
      // copy of the single-publish ones above and its extra reach imaginary.
      expect(payloadCount).toBeGreaterThan(1);
      // Non-vacuous next: the intended error has to be in there at all, or an
      // empty fan-out satisfies the absence assertion while proving nothing.
      expect(messages).toContain(RENDERED_UNRESOLVED);
      // The discriminating read. An entry appended after the pass carries
      // Langium's English, so the English is what a leak looks like — a count
      // of diagnostics would be identical in both states.
      expect(messages.filter(message => message.startsWith(ENGLISH_UNRESOLVED_PREFIX))).toEqual([]);
   });
});

/**
 * The undo-stack label a server-authored write carries.
 *
 * **Easy to miss because it is not a message-shaped field.** It rides as
 * `ApplyWorkspaceEditParams.label`, which LSP specifies as "presented in the
 * user interface for example on an undo stack to undo the workspace edit" — so
 * it is the one place the framework sends a user-facing LABEL rather than a
 * message, and a user editing through a form or a diagram reads it in their
 * editor's undo menu.
 *
 * Asserted over the real wire rather than on the declaration, because the push
 * is what carries it: the framework coalesces per URI and drives the sync from a
 * build-phase settle, so a `ModelService.update` resolves long before the push
 * is sent — which is why the capture length is recorded before the write and
 * the wait armed after it.
 */
describe('the applyEdit undo label', () => {
   afterEach(() => {
      raceHarness?.dispose();
      raceHarness = undefined;
      scratch?.dispose();
      scratch = undefined;
   });

   /** Drive a server-authored write and return the label its egress push carried. */
   async function pushedEditLabel(locale: string | undefined): Promise<string | undefined> {
      scratch = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-editlabel-' });
      const workspace = scratch;
      let shared: OrderFlowSharedServices | undefined;
      const booted = makeLspHarness({
         createServices: connection => {
            shared = createOrderFlowServices({ connection, ...NodeFileSystem }, { extraSharedModules: [rendererModule('test')] }).shared;
            return shared;
         }
      });
      raceHarness = booted;
      await booted.initialize({ locale, workspaceFolders: [{ uri: workspace.uri(), name: 'order-flow' }] });
      if (!shared) {
         throw new Error('createServices did not run');
      }

      const uri = workspace.uri('orders/fulfillment.process');
      const document = await shared.workspace.LangiumDocuments.getOrCreateDocument(URI.parse(uri));
      await shared.workspace.DocumentBuilder.build([document], { validation: true });
      const text = document.textDocument.getText();
      // Opened as a client would, so there is a language client for the egress
      // push to be addressed at — without it nothing is pushed at all.
      booted.openDocument(uri, text, ProcessLanguageMetaData.languageId);

      const pending = booted.nextAppliedEdit(uri);
      await shared.model.ModelService.update({ uri, model: `${text}\n// touched\n`, clientId: 'edit-label' });
      return (await pending).params.label;
   }

   it('renders the label in the locale, on the wire', async () => {
      expect(await pushedEditLabel(TEST_LOCALE)).toBe('RENDERED edit');
   });

   it('sends the English when the locale has no catalogue — the control above', async () => {
      // Same renderer, no matching locale. Without this the row above would pass
      // against a label that was translated regardless of the locale.
      expect(await pushedEditLabel(undefined)).toBe(MODEL_UPDATE_EDIT.text);
   });
});

/**
 * The binding this example actually SHIPS, with no renderer substituted.
 *
 * Every suite above installs a test renderer, which is right for asserting the
 * framework seam and wrong for asserting the adopter half: it leaves the JSON
 * import, the note-key strip and the primary-subtag match unexercised, and all
 * three are decisions an adopter copies. Module load alone would catch a broken
 * import; none of the rest.
 */
describe('the shipped OrderFlowMessageRenderer', () => {
   afterEach(() => {
      scratch?.dispose();
      scratch = undefined;
   });

   /** Surfaces the one protected override, which has no other observation point. */
   class CatalogueProbe extends OrderFlowMessageRenderer {
      catalogueFor(locale: string | undefined): Record<string, string> | undefined {
         return this.translationsFor(locale);
      }
   }

   /** The German the checked-in catalogue carries for the one step this suite uses. */
   const GERMAN_SELF_TRANSITION = "'Pay' kann nicht zu sich selbst übergehen.";

   async function shippedMessages(locale: string | undefined): Promise<string[]> {
      scratch = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-shipped-' });
      const workspace = scratch;
      const services = createOrderFlowServices({ ...NodeFileSystem });
      workspace.write('orders/shipped.process', SELF_TRANSITION_SOURCE);
      await initializeWorkspaceProgrammatically(services.shared, workspace.root, { locale });

      const uri = URI.file(workspace.resolve('orders/shipped.process'));
      const document = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(uri);
      await services.shared.workspace.DocumentBuilder.build([document], { validation: true });
      return (document.diagnostics ?? []).map(sentence);
   }

   it('renders from the checked-in JSON catalogue', async () => {
      expect(await shippedMessages('de')).toEqual([GERMAN_SELF_TRANSITION]);
   });

   it('matches on the primary subtag, so a regional variant still gets German', async () => {
      // An adopter decision, not a framework default — asserted because the
      // alternative (key on the full tag) is equally defensible and silent.
      expect(await shippedMessages('de-AT')).toEqual([GERMAN_SELF_TRANSITION]);
   });

   it('renders English for a locale the catalogue has no map for', async () => {
      // The control: without it the two rows above would pass against a renderer
      // that ignored the locale and always answered German.
      expect(await shippedMessages('fr')).toEqual([ENGLISH_SELF_TRANSITION]);
      expect(await shippedMessages(undefined)).toEqual([ENGLISH_SELF_TRANSITION]);
   });

   it('does not serve the catalogue note as a translation', () => {
      // `_comment` documents the JSON for a reader. It is stripped by PREFIX, so
      // a second note cannot defeat the strip — and a code is three
      // `/`-separated segments, so no real entry can start with `_`.
      const catalogue = new CatalogueProbe(makeNoopSharedServices()).catalogueFor('de');

      // Non-empty first: an undefined catalogue satisfies the no-`_`-keys
      // assertion while proving the JSON never loaded.
      expect(catalogue).toHaveProperty(SELF_TRANSITION.code);
      expect(Object.keys(catalogue ?? {}).filter(key => key.startsWith('_'))).toEqual([]);
   });
});
