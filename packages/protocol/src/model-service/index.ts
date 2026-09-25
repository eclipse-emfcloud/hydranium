/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Generic payload types the data protocol shares with core: the based-on
// version, which the server's model service checks writes against, and the
// reference candidates, which core's scope and completion code produce.

export * from './based-on';
export * from './reference-candidate';
