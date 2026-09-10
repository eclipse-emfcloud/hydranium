/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The properties panel's own user-facing messages.
 *
 * An adopter declares its messages with the same `defineMessage` the framework
 * uses, and that is the whole of the mechanism: a stable code beside an English
 * default, resolved at the raise site and rendered by whoever knows the reading
 * user's locale.
 *
 * **The `hydranium/` code namespace is reserved for the framework**, whose
 * per-package tests assert that every code in a framework barrel names the
 * package it is declared in. An adopter therefore prefixes with its OWN name —
 * here `order-flow/<area>/<name>`, segments limited to `[a-z0-9-]`. Sharing the
 * framework's prefix would put two owners in one keyspace, and a rename on
 * either side would silently shadow the other's catalogue entry.
 *
 * **Declared here rather than per host, because the panel is one surface.** The
 * Theia widget and the VS Code webview mount the same `PropertiesForm` over the
 * same `OrderFlowPropertiesModel` and differ only in how they reach the data
 * head, so a failure has to read identically in both. A code per host would make
 * a translator maintain two entries for one sentence and let them drift.
 *
 * **Complete sentences with the detail interpolated**, matching what the
 * framework's own messages carry. A bare fragment has to be nested in a sentence
 * its owner did not write, so no translator controls the whole and the
 * composition cannot be made to read correctly in every language. `describeError`
 * is what fills `{detail}`: a technical error string is not itself translatable
 * text, so it travels as a parameter rather than needing a code of its own.
 */

import { defineMessage } from '@hydranium/protocol';

export const PROPERTIES_OPEN_FAILED = defineMessage(
   'order-flow/properties/open-failed',
   'Order Flow properties: could not open {uri}. {detail}'
);

export const PROPERTIES_CLOSE_FAILED = defineMessage(
   'order-flow/properties/close-failed',
   'Order Flow properties: could not close the previous document. {detail}'
);

export const PROPERTIES_WRITE_FAILED = defineMessage(
   'order-flow/properties/write-failed',
   "Order Flow properties: could not save '{field}'. {detail}"
);
