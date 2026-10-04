/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { waitFor } from '@hydranium/protocol/testing';
import { apply, move, openDiagram, textOf } from './uncommitted-edit-harness.js';

describe('a diagram whose connection ends', () => {
   it('keeps its unsaved text for the revert grace when the server shuts down', async () => {
      const setup = await openDiagram();
      const { services, diagram, layoutUri } = setup;
      const store = services.shared.workspace.TextDocuments;
      await apply(diagram, move(diagram, diagram.state.sourceRoot.nodes[0].name, 512, 384));
      const edited = textOf(setup, layoutUri);
      expect(store.isDirty(layoutUri)).toBe(true);

      await diagram.shutdown();

      expect(store.isRevertPending(layoutUri)).toBe(true);
      expect(textOf(setup, layoutUri)).toBe(edited);
   });

   it('reverts its unsaved text at once when the diagram closes', async () => {
      const setup = await openDiagram();
      const { services, diagram, layoutUri } = setup;
      const store = services.shared.workspace.TextDocuments;
      await apply(diagram, move(diagram, diagram.state.sourceRoot.nodes[0].name, 512, 384));

      await diagram.server.disposeClientSession({ clientSessionId: diagram.state.clientId });

      expect(store.isRevertPending(layoutUri)).toBe(false);
      await waitFor(() => !store.isDirty(layoutUri), { message: 'the closed diagram’s text never reverted' });
   });
});
