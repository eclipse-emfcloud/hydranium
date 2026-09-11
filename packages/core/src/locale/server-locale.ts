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
 * The locale contract the `ServerLocale` slot holds, implemented by
 * {@link DefaultServerLocale}.
 *
 * An interface rather than the class, so the slot is compared STRUCTURALLY —
 * a class-typed slot carries its `protected` members into every assignability
 * check, compared nominally, which makes it unsatisfiable across two physical
 * copies of this package and unreplaceable by an adopter's own declaration.
 */
export interface ServerLocale {
   /** The locale, or `undefined` when no init supplied one — the framework's English. */
   readonly value: string | undefined;
   accept(locale: string): void;
}

/**
 * The locale the server was handed at init, for whoever needs to render in the
 * reading user's language. Held apart from the message renderer that reads it,
 * so replacing the renderer cannot drop locale handling.
 *
 * A plain string in and out. A consumer that must react to a change rather than
 * read the current value wraps this itself — nothing does today, and both real
 * hosts respawn the server on a display-language switch.
 */
export class DefaultServerLocale implements ServerLocale {
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
    *
    * **The line is at `info`, which is a deliberate exception to the
    * per-service default.** A locale is written once per process and it is the
    * one setting that silently changes every user-facing sentence the server
    * produces, so a reader trying to explain an unexpected language has nothing
    * else to look at: the framework ships no catalogue, so "no entry for this
    * code" and "no locale declared" both render the English and are
    * indistinguishable in the output. At `debug` the line is below the default
    * threshold and therefore absent from exactly the log someone would be
    * reading.
    */
   accept(locale: string): void {
      this.current = locale;
      this.tracer.info(`rendering messages in locale '${locale}'`);
   }
}
