/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Re-export, because these are WIRE values and the side that has to recognise
 * them is the client. They are defined in `@hydranium/protocol` so a frontend
 * can name them without depending on the server tier; this path stays so
 * server-side code keeps importing them from where it already does.
 */
export { FRAMEWORK_CLIENT_IDS, LANGUAGE_CLIENT_ID, REVERT_ON_CLOSE_CLIENT_ID, UNKNOWN_CLIENT_ID } from '@hydranium/protocol';
