/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The diagram webview's entry point.
 *
 * Almost nothing on top of `GLSPStarter`, which already owns the whole handshake:
 * acquiring the VS Code API, announcing readiness, taking the diagram identifier
 * the endpoint sends, building a container and instantiating the widget. What an
 * adopter supplies is only which container to build.
 *
 * **The import discipline is the opposite of the properties bundle's, and that
 * is the point.** `properties.ts` reaches into client MODULE paths precisely to
 * avoid the barrel's diagram definition, whose graph pulls `@eclipse-glsp/client`
 * and its CSS. This bundle WANTS that graph — it is the diagram — so it imports
 * the diagram module directly and `esbuild.mjs` gives it the CSS and font
 * loaders the properties bundle deliberately does not have. Two entries, two
 * dependency graphs, one build file.
 *
 * Nothing here may leak back into the extension host: `check:host-load` requires
 * the built `main` in bare Node, so a stray import of this module from
 * `extension.ts` fails the gate rather than the first activation.
 */

import { GLSPStarter } from '@eclipse-glsp/vscode-integration-webview';
import { initializeOrderFlowProcessDiagramContainer } from '@hydranium/example-order-flow-client/lib/diagram/order-flow-process-diagram-module';
import type { ContainerConfiguration } from '@eclipse-glsp/client';
import { Container } from 'inversify';
// LAST, and that is what makes it work: esbuild emits the bundled stylesheet in
// import order, so these rules land after `@eclipse-glsp/client`'s and win on
// equal specificity. Moving either up would silently lose the sizing chain and
// the per-element-kind colours.
//
// The shared sheet first, the shell's own second: the diagram's appearance is
// host-agnostic and lives with the diagram module, while this package supplies
// only the webview's size and the `--vscode-*` value behind each colour role.
// Definition order does not matter for the variables themselves — a custom
// property resolves where it is USED — but it does for the rules, and the
// shell's should be the ones able to override.
import '@hydranium/example-order-flow-client/style/diagram.css';
import './diagram.css';

class OrderFlowDiagramStarter extends GLSPStarter {
   /**
    * Build the `.process` diagram container.
    *
    * The host's modules arrive in `containerConfiguration` — the diagram options
    * module the starter minted plus VS Code's own feature set — and the diagram
    * definition is appended LAST by
    * {@link initializeOrderFlowProcessDiagramContainer}. That order is not a
    * preference: sprotty's model and view registries throw on a duplicate key,
    * so whichever module registers an element type first wins by throwing at the
    * second, and the diagram definition has to be the one holding the keys.
    */
   createContainer(...containerConfiguration: ContainerConfiguration): Container {
      return initializeOrderFlowProcessDiagramContainer(new Container(), ...containerConfiguration);
   }
}

new OrderFlowDiagramStarter();
