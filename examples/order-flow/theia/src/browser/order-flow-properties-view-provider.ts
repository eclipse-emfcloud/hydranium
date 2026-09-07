/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { inject, injectable } from '@theia/core/shared/inversify';
import type { PropertyViewContentWidget } from '@theia/property-view/lib/browser/property-view-content-widget';
import type { PropertyViewWidgetProvider } from '@theia/property-view/lib/browser/property-view-widget-provider';
import { orderFlowUriOf } from '../common/order-flow-selection-uri';
import { OrderFlowPropertiesWidget } from './order-flow-properties-widget';

/**
 * Contributes the order-flow properties panel into Theia's own Properties view.
 *
 * **Why the built-in view rather than a bespoke one.** The panel lands where a
 * Theia user already looks for properties, and the view owns the lifecycle a
 * standalone widget would have to hand-roll: attaching, detaching, focus, and
 * dispatching selection to whichever provider claims it.
 *
 * **Document-scoped, driven by selection Theia already publishes.** No
 * selection glue is contributed here, because none is needed: the navigator
 * publishes a `FileSelection[]`, the tab bar a `{ uri }`, a focused
 * `Navigatable` itself, and — the one worth calling out — the open diagram
 * publishes a `GlspSelection` carrying `sourceUri`, because GLSP's
 * `theiaSelectModule` (and with it `TheiaGLSPSelectionForwarder`) is part of
 * `THEIA_DEFAULT_MODULES` and is therefore already bound in every hydranium
 * diagram container. So the panel follows the diagram and the Explorer alike
 * without this shell owning a forwarder of its own.
 *
 * What the forwarder's `selectedElementsIDs` would buy — element-scoped
 * properties — is deliberately not taken: the data head has no element-addressed
 * request, so it would need a protocol change rather than more wiring. See
 * {@link orderFlowUriOf}.
 *
 * `DefaultPropertyViewWidgetProvider` is NOT extended. That base routes through
 * `PropertyDataService` contributions to feed Theia's tree-shaped property
 * widget; this panel owns its own model over the data head and renders its own
 * DOM, so implementing the interface directly is both shorter and honest about
 * what it does.
 */
@injectable()
export class OrderFlowPropertiesViewProvider implements PropertyViewWidgetProvider {
   @inject(OrderFlowPropertiesWidget) protected readonly widget!: OrderFlowPropertiesWidget;

   readonly id = 'order-flow';
   readonly label = 'Order Flow Properties';

   /**
    * Claim the selection when, and only when, it names an order-flow document.
    *
    * The priority is above Theia's own `resources` provider (which returns 1 for
    * any file selection), so a `.process` file shows editable model properties
    * rather than the generic file-stat tree. Every other selection returns 0 and
    * falls through to that provider untouched — a properties view that shadowed
    * unrelated files with an empty panel would be worse than not contributing.
    */
   canHandle(selection: unknown): number {
      return orderFlowUriOf(selection) !== undefined ? 2 : 0;
   }

   /**
    * Hand back the single long-lived widget.
    *
    * Always the same instance, because `PropertyViewWidget.replaceContentWidget`
    * keys on the widget id: a fresh widget per selection would be detached and
    * re-attached on every click, tearing down the data connection with it.
    */
   async provideWidget(_selection: unknown): Promise<PropertyViewContentWidget> {
      return this.widget;
   }

   /**
    * Point the widget at the selected document.
    *
    * Theia calls this after `provideWidget` on every selection change, which is
    * what makes the singleton widget updatable rather than static.
    */
   updateContentWidget(selection: unknown): void {
      this.widget.showDocument(orderFlowUriOf(selection));
   }
}
