/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * What `DataSession`'s document wrappers admit and refuse once their arguments
 * are read off the server rather than off the framework's own arg types.
 *
 * The guarantees are type-level, so `typecheck:test` is what runs them — a
 * separate turbo task from `build`, which does not typecheck tests. Each
 * refusal is a `@ts-expect-error`, and an UNUSED one is itself an error, so a
 * clean compile proves every one of them fired. The acceptances carry no
 * directive and fail outright if the wrappers narrow back.
 *
 * The assertions live in a function nothing calls: the calls would otherwise go
 * out on a real wire for a verdict already reached at compile time.
 */

import { describe, expect, it } from 'vitest';
import type { DataSession } from '../../src/client/data-session';
import { asSnapshotVersion } from '../../src/model-service/based-on';
import type { DataServerProtocol, TransferSaveDocumentArgs } from '../../src/data';
import type { CloseModelArgs, OpenModelArgs } from '../../src/model-server';
import type { TransferDiagnostic } from '../../src/transfer-diagnostic';
import type { TransferDocument } from '../../src/transfer-document';
import type { TransferElement } from '../../src/transfer-element';

interface Root extends TransferElement {
   $type: 'TypeOne';
}

/** An adopter's open, carrying a field the framework's `OpenModelArgs` has no room for. */
interface WidenedOpenArgs extends OpenModelArgs {
   extra?: string;
}

/** The same widening on the save path. */
interface WidenedSaveArgs extends TransferSaveDocumentArgs<Root> {
   extra?: string;
}

/** The same widening on the close path. */
interface WidenedCloseArgs extends CloseModelArgs {
   extra?: string;
}

/** And an adopter's diagnostic, which has to survive the way back. */
interface RichDiagnostic extends TransferDiagnostic {
   ruleId: string;
}

interface WidenedServer extends DataServerProtocol<Root, RichDiagnostic> {
   openModelDocument(args: WidenedOpenArgs): Promise<TransferDocument<Root, RichDiagnostic>>;
   closeModelDocument(args: WidenedCloseArgs): Promise<void>;
   saveModelDocument(args: WidenedSaveArgs): Promise<TransferDocument<Root, RichDiagnostic>>;
}

const URI_A = 'file:///a.x';

async function typeAssertions(plain: DataSession<Root>, widened: DataSession<Root, WidenedServer>): Promise<void> {
   // Accepted: the adopter's own field reaches the wrapper it was declared for.
   const opened = await widened.openDocument({ uri: URI_A, extra: 'open-field' });
   await widened.closeDocument({ uri: URI_A, extra: 'close-field' });
   await widened.saveDocument({ uri: URI_A, model: { $type: 'TypeOne' }, extra: 'save-field', basedOn: 'anything' });

   // Accepted: and the adopter's diagnostic survives the return, which is the
   // half the self-referential bound on `TServer` buys.
   const ruleId: string | undefined = opened.diagnostics[0]?.ruleId;
   void ruleId;

   // Accepted: the default instantiation still takes the framework's own fields.
   await plain.openDocument({ uri: URI_A, languageId: 'plaintext' });
   await plain.updateDocument({ uri: URI_A, model: { $type: 'TypeOne' }, basedOn: asSnapshotVersion(1) });

   // @ts-expect-error the default server declares no `extra`, so reading the
   // arguments off the server must not have loosened them into taking anything
   await plain.openDocument({ uri: URI_A, extra: 'open-field' });
   // @ts-expect-error same, on the save path. `basedOn` is supplied so the only
   // thing wrong with this call is `extra` — a missing required field would
   // satisfy the directive too, and it cannot report which error it absorbed.
   await plain.saveDocument({ uri: URI_A, model: { $type: 'TypeOne' }, extra: 'save-field', basedOn: 'anything' });
   // @ts-expect-error the session owns `clientId`, widened server or not
   await widened.openDocument({ uri: URI_A, clientId: 'someone-else' });
   // @ts-expect-error the default server answers the framework diagnostic
   const absent: string | undefined = (await plain.openDocument({ uri: URI_A })).diagnostics[0]?.ruleId;
   void absent;
}

describe('DataSession argument types', () => {
   it('compiles, which is the assertion', () => {
      expect(typeAssertions).toBeTypeOf('function');
   });
});
