/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { HydraniumGlspIndex } from '@hydranium/glsp-server';
import { injectable } from 'inversify';

/**
 * `order-flow`'s GLSP index. The framework default `doFindId` (via
 * `ElementKeyProvider.getElementKey`) is what this example needs, so the
 * subclass adds nothing — it exists so a later id strategy has a stable place
 * to land, and so the framework index is shown composing without overrides.
 *
 * Relevant to `.process` specifically: transitions, gateway branches and
 * effects are genuinely unnamed elements. Binding no override means they are
 * keyed by `DefaultElementKeyProvider`, which is `NameBasedKeyProvider` — not
 * the separate `PositionalKeyProvider` strategy. What keys them is that
 * provider's fallback for a node with no name,
 * `` `${$containerProperty}@${$containerIndex}` ``, so a transition's id is
 * `transitions@0`.
 *
 * **That fallback is index-encoded, and it is why the operation handlers stamp
 * containment plumbing.** `NameBasedKeyProvider`'s stability profile advertises
 * stability across sibling reorder and mid-array insert / delete, which holds
 * for NAMED nodes only — an unnamed node's id moves when its index moves. A
 * node appended without `$containerProperty` / `$containerIndex` therefore has
 * no id at all, and deleting one of three transitions renumbers the survivors.
 * The containment helpers the operation handlers share own both halves:
 * `appendChild` stamps the position on create, `removeChildren` renumbers it on
 * delete.
 */
@injectable()
export class OrderFlowGlspIndex extends HydraniumGlspIndex {}
