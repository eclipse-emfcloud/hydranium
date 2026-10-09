# Make a diagram editable

Use this when a GLSP diagram must write model changes back to the shared
workspace. It is not needed for a read-only projection; a read-only diagram can
stop at a model state and GModel factory.

Heads: GLSP · LSP · data

## The seam

The framework supplies the lifecycle around a diagram, but the adopter owns the
diagram language, GModel factory, source storage, operation handlers, and
configuration. `AbstractHydraniumGlspDiagramModule` is the per-diagram seam; the
app module is process-wide. The recording command turns an AST mutation into a
shared-model update, so the LSP and data heads observe the same write. See
[GLSP server](../../packages/glsp-server/README.md) and
[Host in a browser](host-in-a-browser.md) for host-specific bring-up.

## Steps

1. Subclass the diagram module and bind the model state, storage,
   configuration, GModel factory, and submission handler. The module declares
   no grammar: a session uses the language its loaded document routes to.

<!-- snippet-preamble
import type { BindingTarget, DiagramConfiguration, GModelFactory, ModelState, ModelSubmissionHandler, SourceModelStorage } from '@eclipse-glsp/server';
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

2. Add an operation handler for every edit the diagram offers. Change
   `sourceRoot` inside a `HydraniumGlspRecordingCommand`: the operation works
   on a copy nobody else sees, writes the change once when it completes, and
   undo and redo apply that one change. The rules that keep it working:
   - Edit another document through `modelState.workingRootOf(uri)`, never
     through a root read from the model service.
   - A node of the copy belongs to no document. Pass
     `modelState.builtNodeOf(node)` to anything that looks a document up: a
     scope, reference candidates, a qualified name.
   - Build references with `modelState.referenceTo(target, source)`, and ask
     for reference candidates with
     `modelState.referenceInfoOf(node, property)`, passed to
     `modelState.candidateProviderFor(node).find`.
   - One gesture is one operation. Combine edits in a `CompoundOperation`,
     and never dispatch an operation and await it from a GModel factory, a
     submit or an undo: the two wait for each other forever.

   [GLSP operations](../contributing/design/glsp-operations.md) explains each
   rule, and what runs again on undo and redo.

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
declare abstract class AppDiagramModule extends AbstractHydraniumGlspDiagramModule {
   readonly diagramType: string;
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

## A diagram that writes more than one file

Some diagrams keep part of their state in a second file, such as a layout file
beside the model. Build your state on `ReconcilingMultiDocumentGlspState` and
name the extra file in an override of `trackWriteSet`, with
`trackSecondaryDocument(uri)`. The diagram then writes its files together: if
another client changed any of them since you read it, none is written, and the
conflict resolver gets the whole set. Saving the diagram saves every file it
has open.

If the extra file may not exist yet, as on the first drag in a diagram that was
never laid out, override `openForWrite` and create it there with
`createSecondaryDocument`: a write never creates a file. If the write then
fails, the diagram closes the file again, so a failed operation leaves none
behind. The order-flow example's `OrderFlowGlspState` does this for its
`.layout` file.

Each extra file is checked against the version it had when the diagram last
read its main file. To write over whatever another client did to it instead,
override `secondaryBaseVersion` to return `'any'`.

## How you know it worked

Test each operation as the scaffold's diagram test does: start your diagram
module in `makeGlspHarness` over a scratch workspace, open a document, dispatch
the operation, and wait for the dirty state the server sends once the edit is
written. Then assert the document's text, and that an undo and a redo take the
change out and put it back. When the operation can affect another grammar,
assert that document too.

Check that the test can fail: remove the operation handler, or the write in
its recording command, and the test must turn red. The order-flow example's
version is `server/test/glsp/process-operations.integration.test.ts`, and
[Test your language](test-your-language.md) covers the rest.

## What this guide does not give

It does not provide a GModel factory, operation semantics, or a host client.
Those are necessarily adopter-owned. It also does not make an arbitrary
diagram safe to edit: validation, conflict handling, undo/redo policy, and the
choice of primary versus secondary source documents remain part of the diagram
design.
