/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The `.process` client/server contract.
 *
 * The shared client and the server run in different processes and cannot import
 * each other, so every diagram type, element type id and file extension exists
 * twice. **Every one of those duplications fails silently when it drifts**: GLSP
 * drops a request whose diagram type it does not know, sprotty's model and view
 * registries are exact-key maps with no prefix fallback (an unknown id becomes a
 * featureless generic element rendered by `MissingView`, warned about only in the
 * browser console), and a host registered for the wrong extension simply never
 * opens the editor. An empty canvas with no server-side error is the whole
 * failure mode, which is why the contract is asserted here instead of reviewed.
 *
 * This test imports the SERVER's own constants rather than restating the
 * strings — restating them would assert that the client agrees with the test
 * file, which is not the property at risk. It reads the server's built `lib/`,
 * the same artefact a host would consume.
 *
 * **Reading `lib/` costs one thing: this suite is only as current as the last
 * server build.** Under `npm run check` that is free — turbo's `test` depends on
 * `build`, so `lib/` is fresh by construction. Under the documented iteration
 * loop (`npm --prefix <pkg> exec -- vitest run …`, no build) it is not, and a
 * contract test passing against yesterday's constants is worse than no contract
 * test, because a green run is exactly the claim it exists to make. **Build the
 * server before trusting a bare `vitest` run of this file.**
 *
 * **AN AUTOMATED FRESHNESS GUARD BUILT FROM MTIMES DOES NOT WORK — do not add
 * one.** Both variants are measured, and both are wrong in the same direction:
 * they wedge RED with no way out.
 *
 * - Comparing every source against its output reports STALE after a perfectly
 *   good build. An example's `build` runs its own `generate`, so langium-cli
 *   rewrites `src/language-server/generated/module.ts` every time, and `tsc`
 *   correctly declines to re-emit when the content is unchanged — leaving that
 *   source hours newer than the `.js` beside it.
 * - Narrowing to the HAND-WRITTEN source fails for the same underlying reason,
 *   which is the part that is easy to miss: `tsc`'s incremental emit is decided
 *   by CONTENT, not mtime. So any mtime-only change — `touch`, `git checkout`,
 *   `git stash pop`, a file copy — makes the source newer forever, and a rebuild
 *   does NOT clear it, because there is nothing to rebuild. A gate that cannot be
 *   satisfied by the action its own message recommends is worse than the staleness
 *   it was guarding.
 *
 * A real guard would have to compare the id VALUES across the two forms, which
 * needs the server's `src` in this project — blocked by `rootDir` plus
 * `composite`, and by `@eclipse-glsp/server` (which the ids are built from) not
 * being a declared dependency here.
 */

import { ProcessLanguageMetaData } from '@hydranium/example-order-flow-server/lib/language-server/generated/module';
import * as serverProcessDiagramTypes from '@hydranium/example-order-flow-server/lib/glsp/order-flow-process-diagram-types';
import { describe, expect, it } from 'vitest';
import {
   PROCESS_BRANCH_EDGE_TYPE,
   PROCESS_DIAGRAM_FILE_EXTENSIONS,
   PROCESS_DIAGRAM_TYPE,
   PROCESS_EFFECT_COMPARTMENT_TYPE,
   PROCESS_EFFECT_TYPE,
   PROCESS_ELEMENT_TYPES,
   PROCESS_GATEWAY_NODE_TYPE,
   PROCESS_TASK_NODE_TYPE,
   PROCESS_TRANSITION_EDGE_TYPE
} from '../src/diagram/order-flow-process-diagram-types';

describe('.process diagram contract', () => {
   it('targets the diagram type the server routes by', () => {
      expect(PROCESS_DIAGRAM_TYPE).toBe(serverProcessDiagramTypes.PROCESS_DIAGRAM_TYPE);
   });

   it('names every element type id the way the server stamps it', () => {
      expect(PROCESS_TASK_NODE_TYPE).toBe(serverProcessDiagramTypes.PROCESS_TASK_NODE_TYPE);
      expect(PROCESS_GATEWAY_NODE_TYPE).toBe(serverProcessDiagramTypes.PROCESS_GATEWAY_NODE_TYPE);
      expect(PROCESS_EFFECT_COMPARTMENT_TYPE).toBe(serverProcessDiagramTypes.PROCESS_EFFECT_COMPARTMENT_TYPE);
      expect(PROCESS_EFFECT_TYPE).toBe(serverProcessDiagramTypes.PROCESS_EFFECT_TYPE);
      expect(PROCESS_TRANSITION_EDGE_TYPE).toBe(serverProcessDiagramTypes.PROCESS_TRANSITION_EDGE_TYPE);
      expect(PROCESS_BRANCH_EDGE_TYPE).toBe(serverProcessDiagramTypes.PROCESS_BRANCH_EDGE_TYPE);
   });

   it('accounts for every element type the server declares, and no others', () => {
      // Read the server module as a namespace so an element type this file does
      // not name is caught too: the pairwise assertions above only cover ids it
      // already knows, and a server type the client never registers a view for
      // is exactly the invisible failure. Everything the module exports is an
      // element type id apart from the diagram type; the `typeof` guard skips
      // any interop marker the loader adds.
      const serverElementTypeIds = Object.values(serverProcessDiagramTypes).filter(
         value => typeof value === 'string' && value !== serverProcessDiagramTypes.PROCESS_DIAGRAM_TYPE
      );

      expect([...serverElementTypeIds].sort()).toEqual([...PROCESS_ELEMENT_TYPES].sort());
   });

   it('opens the file extension the grammar claims', () => {
      expect([...PROCESS_DIAGRAM_FILE_EXTENSIONS]).toEqual(ProcessLanguageMetaData.fileExtensions);
   });
});
