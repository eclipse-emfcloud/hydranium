/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ContainerModule } from '@theia/core/shared/inversify';
import { PropertyViewWidgetProvider } from '@theia/property-view/lib/browser/property-view-widget-provider';
import { OrderFlowPropertiesViewProvider } from './order-flow-properties-view-provider';
import { OrderFlowPropertiesWidget } from './order-flow-properties-widget';
import { OrderFlowTheiaDataPort } from './order-flow-theia-data-port';
import '../../style/order-flow-properties.css';

/**
 * Contributes the order-flow properties panel into Theia's Properties view.
 *
 * A separate `theiaExtensions` entry from the diagram, and separately useful:
 * the panel is document-scoped and works over the data head alone, so a
 * deployment that wants properties without a diagram loads only this module.
 *
 * Every class bound here is a singleton for the same reason — one data
 * connection and one widget serve the whole session, and the provider hands that
 * same widget back on every selection (see
 * {@link OrderFlowPropertiesViewProvider}).
 */
export default new ContainerModule(bind => {
   bind(OrderFlowTheiaDataPort).toSelf().inSingletonScope();
   bind(OrderFlowPropertiesWidget).toSelf().inSingletonScope();
   bind(OrderFlowPropertiesViewProvider).toSelf().inSingletonScope();
   bind(PropertyViewWidgetProvider).toService(OrderFlowPropertiesViewProvider);
});
