/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { Clock as ProtocolClock } from '@hydranium/protocol';

/**
 * The protocol's `Clock`, as a Theia container binds it: type and injection
 * token under one identifier, as Theia declares its own. The framework's
 * frontend and backend classes that time or bound something inject it as
 * optional, and use a `SystemClock` when the container binds none, so a
 * container can supply another clock.
 */
export type Clock = ProtocolClock;
export const Clock = Symbol('Clock');
