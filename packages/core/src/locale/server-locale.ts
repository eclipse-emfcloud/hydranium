/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { Tracer } from '@hydranium/protocol';
import { type LogNameOptions } from '../langium/diagnostics/logger.js';
import type { ServerSharedServicesMinimal } from '../langium/shared-services.js';

/** Construction options for {@link ServerLocale}. */
export type ServerLocaleOptions = LogNameOptions;

/**
 * The locale the server was handed at init, for whoever needs to render in the
 * reading user's language. Held apart from the message renderer that reads it,
 * so replacing the renderer cannot drop locale handling.
 *
 * A plain string in and out. A consumer that must react to a change rather than
 * read the current value wraps this itself — nothing does today, and both real
 * hosts respawn the server on a display-language switch.
 */
export class ServerLocale {
   protected readonly tracer: Tracer;
   protected current: string | undefined;

   constructor(services: ServerSharedServicesMinimal, options: ServerLocaleOptions = {}) {
      this.tracer = services.Tracer.for(options.logName ?? 'ServerLocale').trace('instantiated');
   }

   /** The locale, or `undefined` when no init supplied one — which means the framework's English. */
   get value(): string | undefined {
      return this.current;
   }

   /**
    * Take the locale an init declared.
    *
    * **One locale per process, and the reason the OTHER heads need none of
    * their own.** The data and GLSP heads publish a port over the LSP
    * connection and are reached by forwarding a socket to it, so they are the
    * same process as the LSP head that was handed this locale — there is no
    * topology in which one of them serves a second frontend. The Theia backend
    * is the case that would break it, and it holds no locale precisely because
    * it serves every frontend at once; nothing there writes here.
    *
    * The framework accepts a locale and never sources one, and neither
    * validates nor normalises the tag: rejecting an unfamiliar one would be
    * selecting a locale.
    *
    * Override to ignore the argument, which is how a host pins a locale it
    * already knows but has no LSP client to declare.
    */
   accept(locale: string): void {
      this.current = locale;
      this.tracer.debug(`locale set to '${locale}'`);
   }
}
