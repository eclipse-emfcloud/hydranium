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
 *
 * **The panel's own LABELS carry codes as well as its failures, and the two
 * differ in who renders them.** A failure is resolved at the raise site and
 * handed to whoever owns the surface, that being the tier which knows the
 * reading user's locale. A label has no raise site — `PropertiesForm` draws it —
 * so the form is handed a renderer instead. Leaving the labels as literals is
 * what makes a panel read half-translated, and the untranslated half is the half
 * a reader meets on an ordinary document rather than on a broken one.
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

export const PROPERTIES_NO_DOCUMENT = defineMessage('order-flow/properties/no-document', 'No Order Flow document selected');

export const PROPERTIES_NO_FIELDS = defineMessage('order-flow/properties/no-fields', 'This document root has no editable text properties.');

export const PROPERTIES_LOADING = defineMessage('order-flow/properties/loading', 'Loading…');

export const PROPERTIES_APPLY_HINT = defineMessage('order-flow/properties/apply-hint', 'Press Enter to apply');

export const PROPERTIES_DISCONNECTED = defineMessage(
   'order-flow/properties/disconnected',
   'The data server connection closed. Reopen the panel to reconnect.'
);

/**
 * Each of these says what became of the write AND whose value the box now holds,
 * because the two come apart: a merge kept the edit, a conflict replaced it with
 * someone else's, and an unavailable document left text nothing has accepted. A
 * translation that shortens one to "saved" or "not saved" leaves a reader unable
 * to tell whether what is in front of them is their own.
 */
export const PROPERTIES_WRITE_MERGED = defineMessage(
   'order-flow/properties/write-merged',
   'Saved. Someone else had edited another field; both changes were kept.'
);

export const PROPERTIES_WRITE_CONFLICT = defineMessage(
   'order-flow/properties/write-conflict',
   'Not saved — someone else changed this field first. The value shown is theirs.'
);

export const PROPERTIES_WRITE_UNAVAILABLE = defineMessage(
   'order-flow/properties/write-unavailable',
   'Not saved — the document could not be re-read to resolve a conflict.'
);
