/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { ServerLanguageServices, ServerSharedServices } from '@hydranium/core';
import type { ConflictResolver, Tracer } from '@hydranium/protocol';
import { serviceIdentifier } from '../util/service-identifier.js';

/**
 * Inversify service-identifier registry for the framework services the
 * `@hydranium/glsp-server` runtime exposes to `@injectable()` GLSP
 * components. Framework GLSP-side classes are `@injectable()` and need an
 * Inversify token to receive the Langium-style services the rest of the
 * framework hands around via plain constructor arguments.
 *
 * Every token here is a service whose value is **fixed for the container tier
 * that binds it** — process-wide shared services, a per-session conflict
 * policy, the grammar a diagram type edits. That is the whole membership rule,
 * and it is why the registry is short: see below for what deliberately does
 * NOT get a token.
 *
 * Grouped under one object (rather than top-level `Hydranium<Role>` consts)
 * so the token identity is decoupled from the implementation class name.
 * Mirrors GLSP's own `TYPES` registry idiom.
 *
 * Bound by the adopter from their services trees — the app-tier ones directly,
 * the session-tier language by declaring a grammar on the diagram module.
 * Inject with the real service type as the field type.
 *
 * **Split by tier, because GLSP has no language tier.** GLSP's containers are
 * app (per process) -> server (per connection) -> session (per open diagram);
 * Langium's are shared (per process) -> language (per grammar, routed by URI).
 * Only the outermost pair line up. A per-language service therefore CANNOT be
 * bound at the app tier — that container is built before any document exists,
 * so it can only ever hold one grammar's services. The tokens below are split
 * accordingly:
 *
 * - **SharedCoreServices** — the framework's Langium-style shared services
 *   tree ({@link ServerSharedServices}); the services-tree root that state /
 *   index classes inject. Bound once at the app tier. Carries
 *   `ServiceRegistry`, which is how everything below reaches a language.
 * - **DiagramLanguage** — the {@link ServerLanguageServices} of the grammar a
 *   diagram type edits, bound at the SESSION tier by
 *   `AbstractHydraniumGlspDiagramModule` from its declared `declareLanguage()`.
 *   Static (a diagram type has one grammar), so it is safe for the eagerly
 *   constructed handlers GLSP builds at `InitializeClientSession`. Read it
 *   through `AbstractHydraniumGlspState.diagramLanguage`.
 * - **ConflictResolver** — the policy the GLSP state consults when a write
 *   (forward-write, undo, redo, save) races a foreign edit.
 *   `HydraniumGlspAppModule` binds it to `options.conflictResolver`
 *   when supplied, else a default `ReconcilingConflictResolver` (field-level
 *   three-way merge) unless the adopter opts into `ForceConflictResolver`.
 * - **Tracer** — the measure-and-emit observability handle (timing, memory,
 *   profiling). Bound per-request, auto-tagged with the requesting class name
 *   (mirroring GLSP's `LoggerFactory` caller-tagging), so an `@injectable()`
 *   GLSP class that times just injects it and its timing lines carry its own
 *   component — no manual `for(...)`. The non-injectable recording command,
 *   which can't inject, borrows the state's `tracer` getter instead.
 *
 * **No per-language SERVICE has a token — only the language does.** There is
 * no `ElementKeyProvider`, `NameProvider`, `ScopeProvider` or
 * `CandidateProvider` symbol, because every one of them is keyed by a document
 * that the container cannot know: the target node's, for naming and keying;
 * the one a reference is WRITTEN in, for scope and candidates. A GLSP
 * component asks about several documents over its life — the diagram's own,
 * the element it is editing, a drop target — so an injected provider instance
 * answers as if there were one right answer and the routing decision vanishes
 * from the call site. `this.candidateProvider` reads as language-neutral, and
 * nothing prompts the author to ask which document the reference lives in;
 * that is exactly how a foreign node ends up named under the diagram's
 * grammar, producing a plausible string that matches nothing.
 *
 * So callers name the language they mean: `modelState.diagramLanguage` for a
 * reference written on the canvas, `modelState.languageServicesFor(node)` for
 * anything reached through a reference. `ServiceRegistry.getServicesFor(target)`
 * serves the same purpose where no model state is at hand.
 *
 * The app-tier tokens are bound by `HydraniumGlspAppModule`, the
 * session-tier one by `AbstractHydraniumGlspDiagramModule`. A multi-grammar
 * adopter declares a language per diagram module and needs nothing else.
 */
export const HydraniumTypes = {
   SharedCoreServices: serviceIdentifier<ServerSharedServices>('HydraniumSharedCoreServices'),
   DiagramLanguage: serviceIdentifier<ServerLanguageServices>('HydraniumDiagramLanguage'),
   ConflictResolver: serviceIdentifier<ConflictResolver>('HydraniumConflictResolver'),
   Tracer: serviceIdentifier<Tracer>('HydraniumTracer')
} as const;
