/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   createIntegrationServices,
   LspLogger,
   type ServerAddedServices,
   type ServerAddedSharedServices,
   type ServerModuleContext,
   type ServerSharedServices,
   Settings
} from '@hydranium/core';
import { type LogThreshold, parseLogLevel } from '@hydranium/protocol';
import {
   createLspServerLanguageModule,
   createLspServerSharedModule,
   type LspServerAddedServices,
   type LspServerAddedSharedServices
} from '@hydranium/core/lsp';
import { type DeepPartial, EmptyFileSystem, type Module } from '@hydranium/langium';
import { type LangiumServices, type PartialLangiumServices, type PartialLangiumSharedServices } from '@hydranium/langium/lsp';
import { DomainSerializer } from './domain-serializer.js';
import { OrderFlowComputedPropertiesContribution } from './order-flow-ast-extension.js';
import { OrderFlowIntegrityContribution } from './order-flow-integrity.js';
import { OrderFlowProcessValidationContribution } from './process-validation.js';
import {
   DomainGeneratedModule,
   LayoutGeneratedModule,
   OrderFlowGeneratedSharedModule,
   ProcessGeneratedModule
} from './generated/module.js';
import { OrderFlowHoverProvider } from './order-flow-hover.js';
import { OrderFlowProjectManager } from './order-flow-project-manager.js';
import { OrderFlowScopeComputation } from './order-flow-scope-computation.js';
import { OrderFlowSemanticTokenProvider } from './order-flow-semantic-tokens.js';
import { OrderFlowStdlibContribution } from './order-flow-stdlib.js';
import { OrderFlowLayoutScopeProvider } from './layout-scope-provider.js';
import { LayoutSerializer } from './layout-serializer.js';
import { OrderFlowProcessScopeProvider } from './process-scope-provider.js';
import { ProcessSerializer } from './process-serializer.js';

/**
 * Order-flow DI bootstrap — the example's multi-grammar composition.
 *
 * THREE languages over ONE shared tier. That is the whole point of this
 * example: `bootstrapLangiumLanguages` registers all of them before validating
 * any slot, and because `IndexManager`, `DocumentBuilder` and `ProjectManager`
 * are shared, a `.process` file resolves references into a `.domain` file and a
 * `.layout` file resolves into a `.process` file, all through the same global
 * index the LSP head serves. The chain is two hops deep, which is what makes it
 * more than a pair: `.layout` → `.process` → `.domain`.
 *
 * All three languages come from ONE `langium-cli` run over one
 * `langium-config.json`, so `OrderFlowGeneratedSharedModule` carries a
 * single `AstReflection` covering every grammar. `AstReflection` is one
 * shared slot, so independently generated language packages would leave
 * the last-composed one bound and the other grammars' types unknown to
 * reflection — `assertReflectionCoversLanguages` fails the boot rather than
 * letting that pass silently.
 *
 * What each language overrides, and why:
 *
 * - **`ScopeComputation`** (all three) — `OrderFlowScopeComputation` maps the
 *   grammar's `public` modifier onto the framework's `public` visibility
 *   tier. Bound everywhere so one rule governs the whole workspace,
 *   even though only `.domain` declarations carry the modifier.
 * - **`ScopeProvider`** (`.process` and `.layout`) — dependent references,
 *   where a reference's candidates depend on a previous one having resolved:
 *   the nested `writes Order.status = PAID` chain in `.process`, and
 *   `DiagramNode.flowNode` narrowed to the declared process in `.layout`.
 *   `.domain` keeps the framework default; it has no dependent references.
 * - **`Serializer`** (per language) — a serializer is always grammar-shaped,
 *   so there is one per grammar and the framework cannot default any of them.
 * - **`integrity.rules`** (`.domain` and `.process`) — name-uniqueness repair
 *   at `IntegrityPhase.Parsed`. The rules dispatch on `nodeType`, so each sees
 *   only its own grammar's documents. Note the service's default `'silent'`
 *   sync mode writes repairs back to disk. NOT bound on `.layout`: a
 *   `DiagramNode` has no name, so there is nothing to keep unique.
 * - **`validation.checks`** (`.process` only) — the text half of the transition
 *   rules the diagram also enforces, so a hand-edited file reports what the
 *   canvas refuses. `.domain` and `.layout` rely on linking diagnostics alone.
 * - **`ast.extensions`** (`.domain` and `.process`) — a CROSS-GRAMMAR computed
 *   property: `Task._writtenFields` holds `.domain` `Field` nodes reached
 *   through the `.process` effect chain, which two grammars are required to
 *   express. `.layout` derives nothing.
 *
 * Shared side: `ProjectManager` is folder-scoped (see
 * `OrderFlowProjectManager`), and `lsp.configurationRoot` is bound
 * explicitly because its default is "the first registered language id",
 * which in a multi-grammar adopter is registration order rather than a
 * decision.
 */

export interface OrderFlowAddedSharedServices {
   /* override */ workspace: {
      ProjectManager: OrderFlowProjectManager;
   };
}

export type OrderFlowSharedServices = ServerSharedServices & LspServerAddedSharedServices & OrderFlowAddedSharedServices;

export type OrderFlowServices = LangiumServices &
   ServerAddedServices &
   LspServerAddedServices & {
      /* override */ shared: OrderFlowSharedServices;
   };

/** LSP settings section every language of this server reads its configuration from. */
export const ORDER_FLOW_CONFIGURATION_ROOT = 'order-flow';

/**
 * The `order-flow.log.*` subtree, as the host extensions declare it.
 *
 * Only the shape this server reads — `Settings.value` traverses it with
 * `select`, so a key added to the manifest and not named here is simply not
 * consumed.
 */
interface OrderFlowLogConfiguration {
   readonly level?: string;
}

const OrderFlowSharedModule: Module<
   OrderFlowSharedServices,
   PartialLangiumSharedServices &
      OrderFlowAddedSharedServices &
      Pick<ServerAddedSharedServices, 'additionalDocuments'> & { Logger: LspLogger; lsp: { configurationRoot: string } }
> = {
   /**
    * Rebound purely to honour the `order-flow.log.level` setting the host
    * extensions contribute. Without this the framework binds a plain
    * `LspLogger`, the setting is declared and displayed to the user, and the
    * server ignores it — so its own description ("Messages below this level are
    * not written to the output channel") would be false on the server side.
    *
    * **The threshold is process-wide** (`Logger.setLevel`), so this one binding
    * governs the LSP head, the data head and — since the GLSP logger resolves
    * it on read — the GLSP head too. The Theia shell reads the SAME key on the
    * frontend through `bindLogLevelPreference`, which is why the two sides agree
    * without either knowing about the other.
    *
    * **Live, not launch-time:** `Settings.value` re-reads on every
    * `didChangeConfiguration`, so a user changing the setting takes effect
    * without a restart. `default: undefined` leaves the
    * `HYDRANIUM_LOG_LEVEL` env baseline (and failing that `'info'`) in place
    * until a client actually delivers configuration — returning a concrete
    * default here would instead clobber the env on the first fetch, which is the
    * one thing a headless run depends on.
    */
   Logger: services =>
      new LspLogger(services, {
         logThreshold: Settings.value<OrderFlowLogConfiguration, LogThreshold | undefined>({
            services,
            // `root` is omitted: it defaults to `lsp.configurationRoot`, bound
            // below, so the key resolves as `order-flow.log.level`.
            configuration: 'log',
            default: undefined,
            select: log => parseLogLevel(log?.level)
         })
      }),
   lsp: {
      // Three languages are registered, so the framework default ("first
      // registered id") would be registration order rather than a choice.
      configurationRoot: () => ORDER_FLOW_CONFIGURATION_ROOT
   },
   workspace: {
      ProjectManager: services => new OrderFlowProjectManager(services, { logName: 'OrderFlowProjectManager' })
   },
   // Seed the primitive types as an indexed virtual document. It carries no
   // `project` header, so the framework exports its declarations at the
   // `universal` tier and `String` / `Number` / `Boolean` resolve from any
   // project without a `requires`.
   additionalDocuments: {
      stdlib: services => new OrderFlowStdlibContribution(services)
   }
};

/**
 * The three language modules are FACTORIES of {@link OrderFlowOptions}, not
 * constants, and that is forced by composition order rather than a preference.
 * `createIntegrationServices` layers baseline → generated → framework defaults
 * → protocol heads (`extra`) → these adopter overrides, so an option-carrying
 * module handed in as an `extra` would be replaced by whichever of these binds
 * the same slot. All three bind `SemanticTokenProvider`, so an option that has
 * to reach that provider has to reach the adopter binding — which means
 * reaching the module that writes it.
 */
const DomainLanguageModule = (
   options: OrderFlowOptions
): Module<OrderFlowServices, PartialLangiumServices & DeepPartial<ServerAddedServices>> => ({
   serializer: {
      Serializer: services => new DomainSerializer(services)
   },
   integrity: {
      rules: {
         nameUniqueness: () => new OrderFlowIntegrityContribution()
      }
   },
   ast: {
      extensions: {
         computedProperties: () => new OrderFlowComputedPropertiesContribution()
      }
   },
   references: {
      ScopeComputation: services => new OrderFlowScopeComputation(services, { logName: 'DomainScopeComputation' })
   },
   // Binding the slot is what makes Langium advertise `semanticTokensProvider`
   // in the initialize result; the same provider is bound on all three languages
   // because its map is keyed by `$type` over the one shared reflection.
   //
   // `HoverProvider` is bound on all three for the same reason and replaces
   // Langium's default, which answers with the declaration's preceding comment
   // found against `multilineCommentRules` — `ML_COMMENT` only. These grammars
   // comment with `//`, so the default resolves every declaration correctly and
   // then has nothing to say about any of them.
   lsp: {
      HoverProvider: services => new OrderFlowHoverProvider(services),
      SemanticTokenProvider: services => new OrderFlowSemanticTokenProvider(services, options)
   }
});

/**
 * The `*.layout` language. Deliberately THINNER than the other two, and the
 * asymmetry is the point: layout carries no names to keep unique (a
 * `DiagramNode` has no name of its own) and no computed properties to derive, so
 * it binds neither the integrity rule nor the AST-extension contribution that
 * `.domain` and `.process` share. It does bind a `ScopeComputation`, because its
 * root still needs exporting, and a `ScopeProvider` for the one dependent
 * reference the grammar has.
 */
const LayoutLanguageModule = (
   options: OrderFlowOptions
): Module<OrderFlowServices, PartialLangiumServices & DeepPartial<ServerAddedServices>> => ({
   serializer: {
      Serializer: services => new LayoutSerializer(services)
   },
   references: {
      ScopeComputation: services => new OrderFlowScopeComputation(services, { logName: 'LayoutScopeComputation' }),
      ScopeProvider: services => new OrderFlowLayoutScopeProvider(services, { logName: 'LayoutScopeProvider' })
   },
   lsp: {
      HoverProvider: services => new OrderFlowHoverProvider(services),
      SemanticTokenProvider: services => new OrderFlowSemanticTokenProvider(services, options)
   }
});

const ProcessLanguageModule = (
   options: OrderFlowOptions
): Module<OrderFlowServices, PartialLangiumServices & DeepPartial<ServerAddedServices>> => ({
   serializer: {
      Serializer: services => new ProcessSerializer(services)
   },
   integrity: {
      rules: {
         nameUniqueness: () => new OrderFlowIntegrityContribution()
      }
   },
   validation: {
      checks: {
         transitions: () => new OrderFlowProcessValidationContribution()
      }
   },
   ast: {
      extensions: {
         computedProperties: () => new OrderFlowComputedPropertiesContribution()
      }
   },
   references: {
      ScopeComputation: services => new OrderFlowScopeComputation(services, { logName: 'ProcessScopeComputation' }),
      ScopeProvider: services => new OrderFlowProcessScopeProvider(services, { logName: 'ProcessScopeProvider' })
   },
   lsp: {
      HoverProvider: services => new OrderFlowHoverProvider(services),
      SemanticTokenProvider: services => new OrderFlowSemanticTokenProvider(services, options)
   }
});

/**
 * What a host may vary about this composition.
 *
 * The two members reach the tree by DIFFERENT routes, and the difference is the
 * lesson: `extraSharedModules` is a module the caller writes, layered in;
 * `highlightKeywords` is a value threaded down to an adopter binding this file
 * owns. The second shape is needed whenever the slot the option must reach is
 * one the adopter already overrides — a layered module cannot win against that,
 * whichever way round they are composed.
 */
export interface OrderFlowOptions {
   /**
    * Shared-tier modules layered after the framework's shared defaults and the
    * LSP head's, and before this example's own overrides. It exists for the
    * case an adopter hits as soon as they want to exercise a framework option
    * whose default they are happy with in production: framework services are
    * constructed by the framework's own module (`ModelService: services => new
    * ModelService(services)`, no options), so the only way to boot one with
    * non-default options is to rebind the slot — and a factory that hard-codes
    * its composition gives a test nowhere to do that.
    */
   readonly extraSharedModules?: ReadonlyArray<Module<OrderFlowSharedServices, PartialLangiumSharedServices>>;

   /**
    * Colour keywords from the server as well as names. Left off for the VS Code
    * and Theia hosts, which ship `.tmLanguage.json` grammars whose keyword
    * scopes are finer than the flat `keyword` a semantic token can carry and
    * which semantic tokens would override. The browser page ships no grammar,
    * so it turns this on and is the only host that does.
    */
   readonly highlightKeywords?: boolean;
}

/**
 * Compose the Langium DI tree for order-flow. Returns the shared tier plus
 * all three language service trees, named after their grammars.
 *
 * Production callers pass no options.
 */
export function createOrderFlowServices(
   context: Partial<ServerModuleContext> = EmptyFileSystem,
   options: OrderFlowOptions = {}
): {
   shared: OrderFlowSharedServices;
   Domain: OrderFlowServices;
   Process: OrderFlowServices;
   Layout: OrderFlowServices;
} {
   const fullContext: ServerModuleContext = { ...EmptyFileSystem, ...context };
   const { shared, languages } = createIntegrationServices<ServerModuleContext, OrderFlowSharedServices, OrderFlowServices>({
      context: fullContext,
      sharedModules: {
         generated: OrderFlowGeneratedSharedModule,
         adopter: OrderFlowSharedModule,
         extra: [createLspServerSharedModule(fullContext), ...(options.extraSharedModules ?? [])]
      },
      languageModules: {
         generated: DomainGeneratedModule,
         adopter: () => DomainLanguageModule(options),
         extra: [createLspServerLanguageModule(fullContext)]
      },
      additionalLanguages: [
         {
            generated: ProcessGeneratedModule,
            adopter: () => ProcessLanguageModule(options)
         },
         {
            generated: LayoutGeneratedModule,
            adopter: () => LayoutLanguageModule(options)
         }
      ]
   });
   const [Domain, Process, Layout] = languages;
   return { shared, Domain, Process, Layout };
}
