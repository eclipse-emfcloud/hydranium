/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Logger } from '@hydranium/protocol';
import { type LangiumSharedCoreServices } from '@hydranium/langium';
import { type LangiumServices, type LangiumSharedServices } from '@hydranium/langium/lsp';
import type { ServerSharedServicesMinimal } from './shared-services.js';
import { collectProducibleTypes } from './language-types.js';
import { DefaultAstDocumentManager } from '../documents/ast-document-manager.js';
import { HydraniumTextDocuments } from '../documents/hydranium-text-documents.js';
import { DefaultBuildPipelineIntegration } from './document-builder/build-pipeline-integration.js';
import { HydraniumDocumentBuilder } from './document-builder/document-builder.js';
import { DefaultModelService } from './model-service/model-service.js';
import { HydraniumScopeComputation } from './scope/hydranium-scope-computation.js';
import { HydraniumScopeProvider } from './scope/hydranium-scope-provider.js';
import { processEnv } from '../util/environment.js';
import { DefaultTransferEncoder } from './transfer/transfer-encoder.js';
import { HydraniumWorkspaceManager } from './workspace/hydranium-workspace-manager.js';

/**
 * Side: which side of the DI tree a missing slot lives on. Drives the
 * teaching error message — `shared` slots are bound by
 * `createServerSharedModule`, `services` slots by
 * `createServerLanguageModule`.
 */
type Side = 'shared' | 'services';

/**
 * A slot the framework expects to be bound after composition. The `get`
 * callback walks an opaque services object (typed loosely on purpose,
 * since the assertion exists precisely to detect missing properties)
 * and returns `undefined` when the slot was never bound.
 */
interface ExpectedSlot {
   side: Side;
   path: string;
   get: (services: Record<string, unknown>) => unknown;
}

function nested(services: Record<string, unknown>, ...keys: readonly string[]): unknown {
   let current: unknown = services;
   for (const key of keys) {
      if (current === null || typeof current !== 'object') {
         return undefined;
      }
      current = (current as Record<string, unknown>)[key];
   }
   return current;
}

/**
 * Shared-side slots bound by `createServerSharedModule`. If any of
 * these is missing after composition, the most likely cause is that the
 * factory was omitted from the consumer's `inject(...)` of the shared
 * tree (or merged in the wrong order — modules layered after the
 * `@hydranium/core` factory can override these slots back to `undefined`).
 */
const EXPECTED_SHARED_SLOTS: readonly ExpectedSlot[] = [
   { side: 'shared', path: 'Logger', get: services => nested(services, 'Logger') },
   { side: 'shared', path: 'lsp.configurationRoot', get: services => nested(services, 'lsp', 'configurationRoot') },
   { side: 'shared', path: 'workspace.WorkspaceManager', get: services => nested(services, 'workspace', 'WorkspaceManager') },
   { side: 'shared', path: 'workspace.ProjectManager', get: services => nested(services, 'workspace', 'ProjectManager') },
   { side: 'shared', path: 'workspace.SelfSaveRegistry', get: services => nested(services, 'workspace', 'SelfSaveRegistry') },
   { side: 'shared', path: 'workspace.TextDocuments', get: services => nested(services, 'workspace', 'TextDocuments') },
   { side: 'shared', path: 'workspace.AstDocumentManager', get: services => nested(services, 'workspace', 'AstDocumentManager') },
   {
      side: 'shared',
      path: 'workspace.BuildPipelineIntegration',
      get: services => nested(services, 'workspace', 'BuildPipelineIntegration')
   },
   // Unbound, this fails where the cause is least visible: the render pass runs
   // inside the `Validated` phase, so a `TypeError` there propagates out of
   // `notifyDocumentPhase` and the document reaches `Validated` with Langium's
   // publisher never invoked — the client receives no diagnostics for the file
   // and the stack names the document builder.
   { side: 'shared', path: 'MessageRenderer', get: services => nested(services, 'MessageRenderer') },
   { side: 'shared', path: 'ServerLocale', get: services => nested(services, 'ServerLocale') }
];

/**
 * Language-side slots bound by `createServerLanguageModule`. If any
 * is missing the consumer most likely forgot to compose the
 * `@hydranium/core` language factory into their `inject(...)` of the
 * language tree.
 */
const EXPECTED_LANGUAGE_SLOTS: readonly ExpectedSlot[] = [
   { side: 'services', path: 'references.ScopeComputation', get: services => nested(services, 'references', 'ScopeComputation') },
   { side: 'services', path: 'references.ScopeProvider', get: services => nested(services, 'references', 'ScopeProvider') },
   { side: 'services', path: 'references.ElementKeyProvider', get: services => nested(services, 'references', 'ElementKeyProvider') },
   { side: 'services', path: 'references.NameProvider', get: services => nested(services, 'references', 'NameProvider') },
   { side: 'services', path: 'serializer.Serializer', get: services => nested(services, 'serializer', 'Serializer') }
];

const COMPOSITION_HINT = `Expected composition order:

   const shared = inject(
      createDefaultSharedModule(ctx),
      YourGeneratedSharedModule,
      createServerSharedModule(ctx),     // <-- required, head-neutral base
      createLspServerSharedModule(ctx),      // optional protocol head
      YourSharedOverridesModule
   );

   const language = inject(
      createDefaultModule({ shared }),
      YourGeneratedModule,
      createServerLanguageModule(ctx),   // <-- required, head-neutral base
      createLspServerLanguageModule(ctx),    // optional protocol head
      YourLanguageOverridesModule
   );

Each protocol head (lsp-server, data-server, glsp-server) builds on the
\`@hydranium/core\` modules above; they must be composed BEFORE
any head module so head bindings override (later-wins).`;

function buildMessage(slot: ExpectedSlot): string {
   const factory = slot.side === 'shared' ? 'createServerSharedModule(ctx)' : 'createServerLanguageModule(ctx)';
   return `[hydranium] Expected \`${slot.side}.${slot.path}\` to be bound, but it returned undefined.

Most likely cause: \`${factory}\` was not included in your \`inject(...)\` composition, or another module merged after it cleared the slot.

${COMPOSITION_HINT}`;
}

/**
 * Verify that the slots `@hydranium/core` is responsible for
 * binding are populated after composition. Throws an error with a
 * teaching message naming the missing slot and the most likely cause.
 *
 * Invoked from {@link bootstrapLangium}; consumers don't normally call
 * this directly. Exported so framework integration tests can pin the
 * error-message contract.
 *
 * Why a runtime check on top of TypeScript: in practice the consumer
 * pattern `inject(...) as MyServices` widens away the composition shape
 * — a missing module compiles but produces a half-bound services tree.
 * The first failure surfaces deep inside Langium with a stack pointing
 * at an unrelated slot. This assertion fails fast at bootstrap with a
 * message that points at the actual cause and the fix.
 */
export function assertCoreSlotsBound(shared: LangiumSharedServices, language: LangiumServices): void {
   const sharedTree = shared as unknown as Record<string, unknown>;
   const languageTree = language as unknown as Record<string, unknown>;
   for (const slot of EXPECTED_SHARED_SLOTS) {
      if (slot.get(sharedTree) === undefined) {
         throw new Error(buildMessage(slot));
      }
   }
   for (const slot of EXPECTED_LANGUAGE_SLOTS) {
      if (slot.get(languageTree) === undefined) {
         throw new Error(buildMessage(slot));
      }
   }
}

/**
 * Environment variable that opts into the strict-binding diagnostic. Set
 * to `1` / `true` / `yes` / `on` to enable; unset (the default) skips the
 * check entirely. Off by default because it is a development aid, not a
 * production gate.
 */
export const STRICT_BINDINGS_ENV = 'HYDRANIUM_STRICT_BINDINGS';

/** Constructor usable as the right-hand side of `instanceof`. */
type Constructor = new (...args: never[]) => object;

/**
 * A framework slot whose bound value is expected to be an instance of a
 * specific framework base class (the framework's behaviour for that slot
 * lives in the base). Distinct from {@link ExpectedSlot}, which only
 * checks the slot is bound at all: this checks the bound value actually
 * extends the framework base. Only slots with a single behaviour-bearing
 * base class are listed — interface slots with legitimate independent
 * implementations (`Logger`, `references.ElementKeyProvider`,
 * `serializer.Serializer`, `lsp.configurationRoot`) are deliberately
 * omitted, since an `instanceof` check there would false-positive on a
 * valid binding.
 */
interface StrictSlot {
   side: Side;
   path: string;
   base: Constructor;
   get: (services: Record<string, unknown>) => unknown;
}

const STRICT_SHARED_SLOTS: readonly StrictSlot[] = [
   { side: 'shared', path: 'workspace.TextDocuments', base: HydraniumTextDocuments, get: s => nested(s, 'workspace', 'TextDocuments') },
   {
      side: 'shared',
      path: 'workspace.WorkspaceManager',
      base: HydraniumWorkspaceManager,
      get: s => nested(s, 'workspace', 'WorkspaceManager')
   },
   {
      side: 'shared',
      path: 'workspace.DocumentBuilder',
      base: HydraniumDocumentBuilder,
      get: s => nested(s, 'workspace', 'DocumentBuilder')
   },
   {
      side: 'shared',
      path: 'workspace.AstDocumentManager',
      base: DefaultAstDocumentManager,
      get: s => nested(s, 'workspace', 'AstDocumentManager')
   },
   {
      side: 'shared',
      path: 'workspace.BuildPipelineIntegration',
      base: DefaultBuildPipelineIntegration,
      get: s => nested(s, 'workspace', 'BuildPipelineIntegration')
   },
   { side: 'shared', path: 'model.TransferEncoder', base: DefaultTransferEncoder, get: s => nested(s, 'model', 'TransferEncoder') },
   { side: 'shared', path: 'model.ModelService', base: DefaultModelService, get: s => nested(s, 'model', 'ModelService') }
];

const STRICT_LANGUAGE_SLOTS: readonly StrictSlot[] = [
   {
      side: 'services',
      path: 'references.ScopeComputation',
      base: HydraniumScopeComputation,
      get: s => nested(s, 'references', 'ScopeComputation')
   },
   { side: 'services', path: 'references.ScopeProvider', base: HydraniumScopeProvider, get: s => nested(s, 'references', 'ScopeProvider') }
];

function strictBindingsEnabled(): boolean {
   const value = processEnv()?.[STRICT_BINDINGS_ENV]?.toLowerCase();
   return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function warnLooseSlot(logger: Logger | undefined, slot: StrictSlot, actual: object): void {
   const actualName = actual.constructor?.name ?? '<anonymous>';
   const message =
      `[hydranium] Strict bindings: \`${slot.side}.${slot.path}\` is bound to \`${actualName}\`, ` +
      `which does not extend the framework base \`${slot.base.name}\` — framework behaviour on ` +
      `this slot is silently lost. Bind a subclass of \`${slot.base.name}\`, or unset ` +
      `\`${STRICT_BINDINGS_ENV}\` to silence.`;
   if (logger) {
      logger.warn(message);
   } else {
      console.warn(message);
   }
}

/**
 * Opt-in diagnostic (gated by {@link STRICT_BINDINGS_ENV}): warn when a
 * framework slot is bound to a value that does NOT extend the framework
 * base class for that slot. Langium DI is structural, so such a binding
 * compiles and runs but silently drops the framework behaviour the base
 * carries (e.g. a `ScopeComputation` not extending
 * {@link HydraniumScopeComputation} loses tier-aware export). Warns, never
 * throws — safe to leave enabled in a dev/test run; a no-op unless the env
 * var is set.
 *
 * Invoked from {@link bootstrapLangium} after {@link assertCoreSlotsBound}.
 * Exported so framework integration tests can pin the warning contract.
 */
export function warnOnUnexpectedBindings(shared: LangiumSharedServices, language: LangiumServices): void {
   if (!strictBindingsEnabled()) {
      return;
   }
   const sharedTree = shared as unknown as Record<string, unknown>;
   const languageTree = language as unknown as Record<string, unknown>;
   const logger = nested(sharedTree, 'Logger') as Logger | undefined;
   const check = (tree: Record<string, unknown>, slots: readonly StrictSlot[]): void => {
      for (const slot of slots) {
         const value = slot.get(tree);
         if (typeof value === 'object' && value !== null && !(value instanceof slot.base)) {
            warnLooseSlot(logger, slot, value);
         }
      }
   };
   check(sharedTree, STRICT_SHARED_SLOTS);
   check(languageTree, STRICT_LANGUAGE_SLOTS);
}

/**
 * Default eager-construction list for {@link bootstrapLangium}. Contains
 * the framework services whose constructors attach to the build pipeline —
 * either as a direct `documentBuilder` listener or as a
 * `BuildPhasePassService` pass — and which therefore must be instantiated
 * before the first build cycle:
 *
 * - **`workspace.ProjectManager`** — subscribes to
 *   `documentBuilder.onUpdate` to track descriptor file changes.
 * - **`workspace.BuildPipelineIntegration`** — registers the
 *   `documentBuilder.onBuildPhase` / `onDocumentPhase` listeners that
 *   dispatch every build-phase pass and drive AST enrichment, and
 *   registers the framework integrity passes itself. The per-language
 *   feature services it routes to (`ast.AstExtensionService` +
 *   `integrity.IntegrityService`, plus `references.ScopeExtensionService`
 *   read by the scope provider) hold the registries and the logic but own
 *   no listeners, so they need not be eager: each language's services
 *   construct lazily when the orchestrator (or scope provider) first
 *   reaches them, and their constructors register that language's rules /
 *   extensions just-in-time.
 * - **`profilers.LangiumProfiler`** — self-registers a `Validated`
 *   BuildPhasePass that flushes the aggregated parse/link/validate profile
 *   once per build. No production cost (the profiler is trace-gated), but
 *   the pass must be registered up front.
 * - **`workspace.CstResidencyService`** — self-registers a `Validated`
 *   BuildPhasePass that sheds the CST of closed documents. The framework
 *   default strategy is `always-keep`, so the pass runs but sheds nothing
 *   until an adopter configures a shedding strategy.
 *
 * Consumers with no additional eager targets can omit the third argument
 * to {@link bootstrapLangium} — the parameter default is this exact set.
 * Adopters needing extra eager targets spread this constant into their own
 * array and append their accessors.
 */
export const DEFAULT_EAGER_SERVICES: ReadonlyArray<(services: ServerSharedServicesMinimal) => unknown> = [
   services => services.workspace.ProjectManager,
   services => services.workspace.BuildPipelineIntegration,
   services => services.profilers.LangiumProfiler,
   services => services.workspace.CstResidencyService
];

/**
 * After `inject(...)` returns, services are constructed lazily on first
 * access. Some framework services attach to the build pipeline in their
 * constructors — a `documentBuilder.onUpdate` / `onDocumentPhase` /
 * `onBuildPhase` listener, or a build-phase pass — and that attachment
 * has to happen **before** the first build runs, so those services must
 * be constructed eagerly during bootstrap.
 *
 * Defaults to {@link DEFAULT_EAGER_SERVICES} when no list is supplied,
 * which covers every framework service that needs it. Consumers with
 * additional eager targets spread the default into their own list.
 * Accessors are invoked in array order and their return values are
 * discarded.
 *
 * Bootstrap responsibilities, in order:
 *  1. Hand the shared services to `shared.ServiceRegistry` if it accepts
 *     them after construction, so Langium's declared-languageId lookup
 *     rung works however the adopter's registry binding was built.
 *  2. {@link assertDistinctFileRouting} — before registration, because
 *     `register` resolves a routing collision by last-wins and afterwards
 *     the evidence is gone.
 *  3. Register `language` against `shared.ServiceRegistry`, the
 *     required final step of any Langium DI bootstrap. Done before slot
 *     validation so subclassed registries (typed-accessor extensions)
 *     populate any side state before validation walks construct services
 *     that read from the registry.
 *  4. {@link assertCoreSlotsBound} — fail fast if the consumer's
 *     `inject(...)` composition is missing a `@hydranium/core` module. May
 *     trigger lazy service construction as side effect of walking the
 *     slots; that construction expects a populated `ServiceRegistry`,
 *     hence the order.
 *  5. {@link warnOnUnexpectedBindings} — opt-in (gated by
 *     {@link STRICT_BINDINGS_ENV}); warns when a framework slot is bound
 *     to a non-subclass of its framework base. No-op unless the env is set.
 *  6. {@link assertReflectionCoversLanguages} — catch a clobbered shared
 *     `AstReflection` before it starts silently answering `isSubtype`
 *     false for a registered language's types. Skipped here, since a lone
 *     language has no sibling that could clobber it.
 *  7. Invoke eager-construction accessors in array order.
 *
 * Multi-grammar adopters use {@link bootstrapLangiumLanguages}, which
 * registers every language before validating slots or constructing the
 * eager set.
 */
export function bootstrapLangium<TShared extends LangiumSharedServices & ServerSharedServicesMinimal, TLang extends LangiumServices>(
   shared: TShared,
   language: TLang,
   eagerlyConstructedServices: ReadonlyArray<(services: TShared) => unknown> = DEFAULT_EAGER_SERVICES
): { shared: TShared; language: TLang } {
   bootstrapLangiumLanguages(shared, [language], eagerlyConstructedServices);
   return { shared, language };
}

/**
 * Multi-language form of {@link bootstrapLangium}: bootstraps several
 * languages that share ONE shared-services tier, as a multi-grammar adopter
 * needs when its grammars cross-reference each other through the shared
 * index.
 *
 * Same responsibilities as the single-language form, but the phase
 * ORDER across languages is what makes this a distinct function rather
 * than a loop the caller could write:
 *
 *  1. **Every** language is registered against `shared.ServiceRegistry`
 *     first. Slot validation and eager construction both build services
 *     that read the registry — a per-language
 *     register-then-validate-then-eager loop would run them while later
 *     languages were still missing, so a shared service that walks
 *     `ServiceRegistry.all` (or resolves by extension) would see a
 *     half-populated registry and cache the wrong answer.
 *  2. `assertCoreSlotsBound` / `warnOnUnexpectedBindings` per language —
 *     each language composes its own module chain, so each is checked.
 *  3. Eager accessors run **once**, after all registrations. They take
 *     the shared tier, and the framework's eager set is shared-tier only
 *     (`ProjectManager`, `BuildPipelineIntegration`, `LangiumProfiler`,
 *     `CstResidencyService`) — `BuildPipelineIntegration` in particular
 *     routes per document URI to each language's `IntegrityService` /
 *     `AstExtensionService`, so it must be constructed knowing all of
 *     them. Running the set per language would attach its
 *     `documentBuilder` listeners N times and enforce each phase N times.
 *
 * Throws when `languages` is empty: a shared tier with no registered
 * language never validates its slots, which silently defers a
 * composition error to the first build.
 */
export function bootstrapLangiumLanguages<
   TShared extends LangiumSharedServices & ServerSharedServicesMinimal,
   TLang extends LangiumServices
>(
   shared: TShared,
   languages: ReadonlyArray<TLang>,
   eagerlyConstructedServices: ReadonlyArray<(services: TShared) => unknown> = DEFAULT_EAGER_SERVICES
): { shared: TShared; languages: ReadonlyArray<TLang> } {
   if (languages.length === 0) {
      throw new Error(
         '[hydranium] bootstrapLangiumLanguages requires at least one language — a shared tier with no ' +
            'registered language cannot validate its slots. Pass the language(s) produced by your ' +
            '`inject(...)` composition.'
      );
   }
   // Back-fill the shared services onto a registry that was constructed
   // without them, so Langium's declared-languageId lookup rung works no
   // matter how the adopter's `ServiceRegistry` binding built it. An adopter
   // rebinding the slot with a zero-argument `new MyRegistry()` would
   // otherwise lose that rung with nothing to indicate it — the same
   // silent-inertness shape as a `DocumentUpdateHandler` bound on the
   // per-language tier. Only fills an empty reference.
   if (acceptsSharedServices(shared.ServiceRegistry)) {
      shared.ServiceRegistry.acceptSharedServices(shared);
   }
   // Before registering, not after: `register` resolves a collision by
   // last-wins, so afterwards the losing language is already unreachable.
   assertDistinctFileRouting(languages);
   for (const language of languages) {
      shared.ServiceRegistry.register(language);
   }
   for (const language of languages) {
      assertCoreSlotsBound(shared, language);
      warnOnUnexpectedBindings(shared, language);
   }
   assertReflectionCoversLanguages(shared, languages);
   for (const accessor of eagerlyConstructedServices) {
      accessor(shared);
   }
   return { shared, languages };
}

/**
 * A registry that can take its shared services after construction. Structural
 * rather than an `instanceof HydraniumServiceRegistry` check so an adopter
 * registry that implements the method without extending the framework base
 * still gets the languageId rung.
 */
function acceptsSharedServices(registry: unknown): registry is { acceptSharedServices(services: LangiumSharedCoreServices): void } {
   return typeof (registry as { acceptSharedServices?: unknown } | null)?.acceptSharedServices === 'function';
}

/**
 * Fail fast when two registered languages claim the same routing key — a file
 * extension, a whole file name, or a language id.
 *
 * **Why this is an error and not a warning.** Langium's `ServiceRegistry.register`
 * resolves a collision by last-wins and reports it with a raw `console.warn`.
 * That warning goes to the process console, outside the framework `Logger`, so
 * it never reaches the LSP output channel an adopter reads — and the result is
 * that every file of the losing language is parsed, scoped and validated by the
 * WRONG grammar. There is no configuration under which that is intended, and
 * the symptom (mass validation errors in files that look fine) points nowhere
 * near the cause.
 *
 * A duplicate `languageId` is worse still: the id keys `languageIdMap`, so the
 * losing language becomes unreachable by every lookup path at once, including
 * the declared-id rung and `getServicesById`.
 *
 * Runs before registration, since afterwards the collision has already been
 * resolved and the evidence is gone.
 */
export function assertDistinctFileRouting(languages: ReadonlyArray<LangiumServices>): void {
   const owners = new Map<string, string>();
   const claim = (kind: string, key: string, languageId: string): void => {
      const mapKey = `${kind}:${key}`;
      const previous = owners.get(mapKey);
      if (previous !== undefined) {
         throw new Error(
            `[hydranium] two registered languages claim the same ${kind} '${key}': '${previous}' and '${languageId}'. ` +
               'Langium resolves this by last-wins with a bare console.warn, so every such file would be parsed and ' +
               'validated by whichever grammar registered last — invisible in the LSP log. Give each grammar a ' +
               `distinct ${kind} in its langium-config.`
         );
      }
      owners.set(mapKey, languageId);
   };
   for (const language of languages) {
      const metadata = language.LanguageMetaData;
      if (!metadata) {
         // An unbound `LanguageMetaData` is a different failure with its own
         // reporting — Langium's `register` reads it one line later. Reporting
         // it here in the vocabulary of a routing collision would misname it.
         continue;
      }
      claim('language id', metadata.languageId, metadata.languageId);
      for (const extension of metadata.fileExtensions) {
         claim('file extension', extension, metadata.languageId);
      }
      for (const fileName of metadata.fileNames ?? []) {
         claim('file name', fileName, metadata.languageId);
      }
   }
}

/**
 * Fail fast when the shared `AstReflection` does not know a registered
 * language's types.
 *
 * **The composition mistake this catches.** `AstReflection` lives in Langium's
 * `LangiumGeneratedSharedCoreServices` — ONE slot for the whole project. A
 * single `langium-cli` run over several grammars emits one combined reflection
 * covering all of them, which is fine. But composing two *separately generated*
 * language packages means composing two `…GeneratedSharedModule`s, each binding
 * that one slot: last-wins, and the loser's types vanish from the reflection.
 * Nothing errors. Instead `isSubtype` silently answers `false` for those types,
 * which quietly breaks `IndexManager.allElements(type)` and `getElementByName`
 * (so reference routing finds nothing), `getTypeMetaData` (so the encoder's
 * `'grammar'` mode emits nothing), and Langium's own linking.
 *
 * The check is per language, on the types its grammar can produce, and costs
 * one grammar walk per language at boot; a single-language composition, which
 * nothing can clobber, is skipped entirely. It cannot repair the situation — a
 * reflection that spans independently generated grammars is a real design piece
 * (a composite reflection dispatching per owning language) and is not attempted
 * here; the point is to turn a silent runtime misbehaviour into a boot failure
 * that names the language and the mistake.
 *
 * **Two severities, because a clobber is not always total.** Throwing only when
 * NONE of a language's types are known misses the realistic case: two grammars
 * that share an imported base overlap heavily, so a reflection covering only
 * one of them still recognises most of the other's types and a
 * none-are-known test passes while the language's DISTINCTIVE types are
 * absent. So any non-empty gap now warns (naming the missing types), and the
 * throw is reserved for the unambiguous all-missing case. The warning can also
 * fire benignly — a generator folding an unused rule away leaves a type the
 * reflection never had — which is why partial coverage warns rather than
 * throwing.
 */
export function assertReflectionCoversLanguages(shared: LangiumSharedServices, languages: ReadonlyArray<LangiumServices>): void {
   if (languages.length < 2) {
      // One language cannot be clobbered by another's shared module.
      return;
   }
   if (typeof shared.AstReflection?.getAllTypes !== 'function') {
      // No reflection at all is a different failure (an unbound slot) with its
      // own reporting. This check is about a reflection that EXISTS but covers
      // the wrong grammar, so it stays quiet rather than reporting the absence
      // in the vocabulary of a clobbered binding.
      return;
   }
   const known = new Set(shared.AstReflection.getAllTypes());
   const logger = nested(shared as unknown as Record<string, unknown>, 'Logger') as Logger | undefined;
   for (const language of languages) {
      const produced = collectProducibleTypes(language.Grammar);
      const missing = [...produced].filter(type => !known.has(type));
      if (missing.length === 0) {
         continue;
      }
      const languageId = language.LanguageMetaData.languageId;
      if (missing.length < produced.size) {
         warnPartialReflectionCoverage(logger, languageId, missing, produced.size);
         continue;
      }
      throw new Error(
         `[hydranium] the shared AstReflection knows NONE of the ${produced.size} types the language ` +
            `'${languageId}' can produce (e.g. ${missing.slice(0, 3).join(', ')}). ` +
            'AstReflection is a single shared slot, so composing two independently generated language ' +
            'packages leaves only the last one bound. Generate all grammars in ONE langium-cli run (one ' +
            'langium-config with several entry grammars) so a single combined reflection covers them all.'
      );
   }
}

/** Maximum missing type names spelled out before the message elides the rest. */
const MAX_REPORTED_MISSING_TYPES = 8;

function warnPartialReflectionCoverage(
   logger: Logger | undefined,
   languageId: string,
   missing: readonly string[],
   producedCount: number
): void {
   const named = missing.slice(0, MAX_REPORTED_MISSING_TYPES).join(', ');
   const elided = missing.length > MAX_REPORTED_MISSING_TYPES ? `, … (${missing.length - MAX_REPORTED_MISSING_TYPES} more)` : '';
   const message =
      `[hydranium] the shared AstReflection is missing ${missing.length} of the ${producedCount} types the ` +
      `language '${languageId}' can produce: ${named}${elided}. ` +
      'For those types `isSubtype` answers false and `getTypeMetaData` is empty, so `IndexManager.allElements` ' +
      'finds nothing, reference routing misses, and the encoder emits nothing. Most likely two independently ' +
      'generated language packages each bound the single shared AstReflection slot and the last one won — ' +
      'generate all grammars in ONE langium-cli run so a single combined reflection covers them. If instead ' +
      'these are rules your generator legitimately folded away, this warning is expected.';
   if (logger) {
      logger.warn(message);
   } else {
      console.warn(message);
   }
}
