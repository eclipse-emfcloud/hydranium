/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AbstractHydraniumGlspDiagramManager } from '@hydranium/glsp-client-theia/browser';
import { processUriFor } from '@hydranium/example-order-flow-protocol';
import type { GLSPDiagramWidget, GLSPWidgetOpenerOptions } from '@eclipse-glsp/theia-integration/lib/browser';
import type { WidgetOpenerOptions } from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';
import { injectable } from '@theia/core/shared/inversify';
import { OrderFlowProcessDiagramLanguage } from '../common/order-flow-diagram-language';

// Positive priorities appear in Open With; staying below the text editor keeps layouts opening as text.
const LAYOUT_DIAGRAM_OPENER_PRIORITY = 50;

/** Opens process diagrams, redirecting layouts to their owning process. */
@injectable()
export class OrderFlowProcessDiagramManager extends AbstractHydraniumGlspDiagramManager {
   static readonly ID = 'order-flow-process-diagram-manager';

   override get id(): string {
      return OrderFlowProcessDiagramManager.ID;
   }

   override canHandle(uri: URI, options?: WidgetOpenerOptions): number {
      const processUri = processUriFor(uri.toString());
      return processUri !== uri.toString() ? LAYOUT_DIAGRAM_OPENER_PRIORITY : super.canHandle(uri, options);
   }

   override open(uri: URI, options?: GLSPWidgetOpenerOptions): Promise<GLSPDiagramWidget> {
      return super.open(new URI(processUriFor(uri.toString())), options);
   }

   protected readonly diagramLanguage = OrderFlowProcessDiagramLanguage;
   protected readonly managerLabel = 'Order Flow Process Diagram Editor';
}
