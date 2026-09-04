/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * GLSP GModel concept classifier — a default contribution for heads with a
 * `@hydranium/glsp-server` diagram layer. GModel elements are class instances
 * from `@eclipse-glsp/graph` (GGraph/GNode/GEdge/GLabel/GCompartment/…), each
 * carrying a `type` string and the shared own-prop set
 * {type,id,children,cssClasses}. So this mirrors CST (recognise by constructor)
 * and AST (sub-label by the discriminator) at once: a GModel instance →
 * `GModel:<type>` (the field is `type`, NOT `$type`).
 *
 * The `type` string is itself hierarchical by GLSP convention
 * (`<kind>:<subtype>`), so the label becomes a 3-level path
 * `GModel:<kind>:<subtype>` that the analyzer drills into (group `GModel`, then
 * by kind `node`/`edge`/`comp`/`label`/`graph`, then by subtype). A flat `type`
 * (`graph`, `label`) is simply a 2-level leaf — never wrong.
 *
 * The element vocabulary is framework-fixed (`@eclipse-glsp/graph`), so it ships
 * as a default rather than behind discovery. On a non-GLSP heap it matches
 * nothing and is inert. Only leaf option bags (`layoutOptions`/`args`) are plain
 * objects — negligible mass — so no plain-object predicate is needed; the
 * structural fallback catches any GModel subtype a head adds beyond this set.
 */

import { has, propertySet, readableType } from './concepts.mjs';

/** `@eclipse-glsp/graph` element classes — the framework-fixed GModel vocabulary. */
const GMODEL_CTORS = new Set([
   'GGraph',
   'GNode',
   'GEdge',
   'GLabel',
   'GCompartment',
   'GPort',
   'GForeignObjectElement',
   'GHtmlRoot',
   'GIssueMarker'
]);

/** @type {import('./concepts.mjs').ConceptClassifier} */
export const glspClassifier = {
   classify(node) {
      if (node.type !== 'object') {
         return undefined;
      }
      const { name } = node;
      if (name && GMODEL_CTORS.has(name)) {
         return `GModel:${readableType(node)}`;
      }
      // Recognise any GModel element by its shared own-prop shape
      // {type,id,children,cssClasses}, regardless of constructor name. A bundled
      // server renames the classes (`_GLabel`) and heads add their own
      // subclasses (`_AttributeCompartment`), so a name allow-list misses most
      // of a real diagram — the structural signature is what holds. The shape is
      // GLSP-specific, and Langium runs first, so only unclassified objects reach
      // this check (no risk of stealing a model node).
      if (has(propertySet(node), 'type', 'id', 'children', 'cssClasses')) {
         return `GModel:${readableType(node)}`;
      }
      return undefined;
   },

   // Matches the raw per-node labels (exclusive-retained attribution anchors)
   // and the bare group (`GModel`, retainer-path selection).
   isAnchor(label) {
      return label.startsWith('GModel');
   },

   descriptions: {
      GModel:
         'GLSP graphical-model elements for the open diagrams (nodes, edges, labels, ports, compartments). Sub-levels are the GLSP `type`, itself a `<kind>:<subtype>` path.'
   }
};
