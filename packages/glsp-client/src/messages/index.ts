/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Every user-facing message `@hydranium/glsp-client` raises. The client tier
// renders only its own messages, which fire when no server could have worded
// them: the loader formats the English, and a host that knows the reading
// user's locale renders the code through its own mechanism instead, as the
// Theia loader does through `nls`. The barrel is how an adopter rendering their
// own diagram chrome discovers the codes exist.

export { DIAGRAM_LOAD_FAILED } from '../diagram-load-failed';
export { DIAGRAM_MESSAGE_DETAILS } from '../diagram-message-details';
export { DIAGRAM_MESSAGE_DISMISS } from '../diagram-message-dismiss';
