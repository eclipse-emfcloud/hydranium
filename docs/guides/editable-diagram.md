# Make a diagram editable

Use this when a GLSP diagram must write model changes back to the shared
workspace. It is not needed for a read-only projection; a read-only diagram can
stop at a model state and GModel factory.

Heads: GLSP · LSP · data

## The seam

The framework supplies the lifecycle around a diagram, but the adopter owns the
diagram language, GModel factory, source storage, operation handlers, and
configuration. `AbstractHydraniumGlspDiagramModule` is the per-diagram seam;
the app module is process-wide. The recording command turns an AST mutation into
a shared-model update, so the LSP and data heads observe the same write. See
[GLSP server](../../packages/glsp-server/README.md) and [browser hosting](../concepts/browser-hosting.md)
for host-specific bring-up.

## Steps

1. Subclass the diagram module and bind the source language, model state,
   storage, configuration, GModel factory, and submission handler. The module
   is where the diagram declares which grammar it edits.

<!-- snippet-preamble
import type { BindingTarget, DiagramConfiguration, GModelFactory, ModelState, ModelSubmissionHandler, SourceModelStorage } from '@eclipse-glsp/server';
import type { LanguageMetaData } from '@hydranium/langium';
declare const AppLanguageMetaData: LanguageMetaData;
declare const AppModelState: BindingTarget<ModelState>;
declare const AppModelStorage: BindingTarget<SourceModelStorage>;
declare const AppDiagramConfiguration: BindingTarget<DiagramConfiguration>;
declare const AppGModelFactory: BindingTarget<GModelFactory>;
declare const AppSubmissionHandler: BindingTarget<ModelSubmissionHandler>;
-->

```ts
import { AbstractHydraniumGlspDiagramModule } from '@hydranium/glsp-server';

export class AppDiagramModule extends AbstractHydraniumGlspDiagramModule {
   readonly diagramType = 'app-diagram';

   protected override declareLanguage(): LanguageMetaData {
      return AppLanguageMetaData;
   }

   protected override bindModelState(): BindingTarget<ModelState> {
      return AppModelState;
   }

   protected override bindSourceModelStorage(): BindingTarget<SourceModelStorage> {
      return AppModelStorage;
   }

   protected override bindDiagramConfiguration(): BindingTarget<DiagramConfiguration> {
      return AppDiagramConfiguration;
   }

   protected override bindGModelFactory(): BindingTarget<GModelFactory> {
      return AppGModelFactory;
   }

   protected override bindModelSubmissionHandler(): BindingTarget<ModelSubmissionHandler> {
      return AppSubmissionHandler;
   }
}
```

2. Add an operation handler for every advertised edit. Mutate the shared source
   model inside `HydraniumGlspRecordingCommand`; its `postChange` bridge derives
   the patch and calls the state update path, which persists and republishes the
   result to the other heads.

<!-- snippet-preamble
import type { Command, CreateNodeOperation, MaybePromise } from '@eclipse-glsp/server';
import { JsonCreateNodeOperationHandler } from '@eclipse-glsp/server';
import { HydraniumGlspRecordingCommand, ReconcilingTransferHydraniumGlspState } from '@hydranium/glsp-server';
import type { AstNode } from '@hydranium/langium';
import type { TransferElement } from '@hydranium/protocol';
type AppNode = AstNode & { name: string };
type AppRoot = AstNode & { nodes: AppNode[] };
type AppSourceModel = TransferElement & { nodes: AppNode[] };
class AppGlspState extends ReconcilingTransferHydraniumGlspState<AppRoot, AppSourceModel> {}
declare const appState: AppGlspState;
declare const createAppNode: (operation: CreateNodeOperation) => AppNode;
-->

```ts
class AppCreateNodeOperationHandler extends JsonCreateNodeOperationHandler {
   declare protected modelState: typeof appState;
   override readonly label = 'Create node';
   override readonly elementTypeIds = ['app-node'];

   override createCommand(operation: CreateNodeOperation): MaybePromise<Command | undefined> {
      const node = createAppNode(operation);
      return new HydraniumGlspRecordingCommand(this.modelState, 'Create node', () => {
         this.modelState.sourceRoot.nodes.push(node);
      });
   }
}
```

   The concrete command can be a thin adopter subclass, as in the example's
   `OrderFlowCommand`; the important part is that the handler mutates the
   framework state through the recording-command path rather than changing a
   detached projection or only the GModel.

3. Preserve GLSP's default operation handlers when adding yours. The base
   `DiagramModule` binds `CompoundOperationHandler` and
   `LayoutOperationHandler`; omitting `super.configureOperationHandlers(...)`
   silently removes both.

<!-- snippet-preamble
import type { InstanceMultiBinding, OperationHandlerConstructor } from '@eclipse-glsp/server';
import { AbstractHydraniumGlspDiagramModule } from '@hydranium/glsp-server';
import type { BindingTarget, DiagramConfiguration, GModelFactory, ModelState, ModelSubmissionHandler, SourceModelStorage } from '@eclipse-glsp/server';
import type { LanguageMetaData } from '@hydranium/langium';
declare abstract class AppDiagramModule extends AbstractHydraniumGlspDiagramModule {
   readonly diagramType: string;
   protected declareLanguage(): LanguageMetaData;
   protected bindModelState(): BindingTarget<ModelState>;
   protected bindSourceModelStorage(): BindingTarget<SourceModelStorage>;
   protected bindDiagramConfiguration(): BindingTarget<DiagramConfiguration>;
   protected bindGModelFactory(): BindingTarget<GModelFactory>;
   protected bindModelSubmissionHandler(): BindingTarget<ModelSubmissionHandler>;
}
declare const AppCreateNodeOperationHandler: OperationHandlerConstructor;
-->

```ts
export class AppDiagramModuleWithHandlers extends AppDiagramModule {
   protected override configureOperationHandlers(binding: InstanceMultiBinding<OperationHandlerConstructor>): void {
      super.configureOperationHandlers(binding);
      binding.add(AppCreateNodeOperationHandler);
   }
}
```

4. Start the GLSP server with the app module and the diagram module. Use the
   same shared services tree as the LSP and data heads so a diagram write is
   visible to text and data clients.

<!-- snippet-preamble
import type { MessageConnection } from 'vscode-jsonrpc';
import type { ServerSharedServices } from '@hydranium/core';
declare const shared: ServerSharedServices & { readonly lsp: { readonly Connection: MessageConnection } };
declare const AppDiagramModuleWithHandlers: new () => import('@hydranium/glsp-server').AbstractHydraniumGlspDiagramModule;
-->

```ts
import { ServerModule } from '@eclipse-glsp/server';
import { GlspClientLogger, HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { startGlspServer } from '@hydranium/glsp-server/node';

startGlspServer({
   createLogger: caller => new GlspClientLogger(shared, { component: caller }),
   serverModule: new ServerModule().configureDiagramModule(new AppDiagramModuleWithHandlers()),
   appModules: [new HydraniumGlspAppModule({ shared })],
   lspConnection: shared.lsp.Connection
});
```

## How you know it worked

Run the GLSP integration suite:

```sh
npm exec -w @hydranium/example-order-flow-server -- vitest run test/glsp/process-operations.integration.test.ts
```

Open the diagram, perform one operation, and assert all three boundaries: the
operation is accepted, the shared source document changes, and a subsequent
model request contains the changed element. Add a text-side assertion when the
operation can affect another grammar. A useful red control removes the
operation handler or the recording-command write; the test must fail before
accepting the operation as successful.

## What this guide does not give

It does not provide a GModel factory, operation semantics, or a host client.
Those are necessarily adopter-owned. It also does not make an arbitrary
diagram safe to edit: validation, conflict handling, undo/redo policy, and the
choice of primary versus secondary source documents remain part of the diagram
design.
