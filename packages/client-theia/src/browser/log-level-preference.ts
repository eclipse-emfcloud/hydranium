/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DisposableCollection, Logger, parseLogLevel } from '@hydranium/protocol';
// Narrow import paths, not the `@theia/core/lib/browser` barrel: it touches DOM
// globals at module load, which breaks node-environment unit tests. This module
// only needs the contribution token (a bare Symbol) and two common services.
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { ILogger } from '@theia/core/lib/common/logger';
import { PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import { inject, injectable, type interfaces } from '@theia/core/shared/inversify';

/** Inversify token for the preference id {@link LogLevelPreferenceContribution} watches. */
export const LogLevelPreference = Symbol('LogLevelPreference');

/**
 * Applies the framework log threshold from a Theia preference, once per
 * application.
 *
 * **Why this is a `FrontendApplicationContribution` and not a logger concern.**
 * The threshold is a process-global (`Logger.setLevel`, read by every
 * `AbstractLogger` at emit time), so applying it is an *application* lifecycle
 * event. Applying it from a logger's `@postConstruct` instead puts a global side
 * effect on the construction of an object whose singleton scope is the
 * per-diagram container, which costs two things:
 *
 *  - the `onPreferenceChanged` subscription is never disposed AND is re-created
 *    for every diagram container, so opening N diagrams leaves N live listeners
 *    holding N loggers;
 *  - with no diagram open the preference is never applied at all, so anything
 *    logging before the first diagram runs at the default threshold.
 *
 * Bound by {@link bindLogLevelPreference} in the **frontend** container — a
 * diagram container is a child and cannot contribute to the parent's
 * multi-binding.
 */
@injectable()
export class LogLevelPreferenceContribution implements FrontendApplicationContribution {
   @inject(LogLevelPreference) protected readonly preferenceName!: string;
   @inject(PreferenceService) protected readonly preferences!: PreferenceService;
   @inject(ILogger) protected readonly logger!: ILogger;

   /** Holds the single preference subscription. `DisposableCollection` disposes a
    *  push-after-dispose immediately, so a subscription that lands after
    *  {@link onStop} cannot outlive the application either. */
   protected readonly toDispose = new DisposableCollection();
   /** Guards against a second subscription if `onStart` is ever invoked twice —
    *  a duplicated listener is exactly the failure this contribution exists to
    *  prevent. */
   protected subscribed = false;

   /**
    * Returns `void` rather than the promise, so `FrontendApplication.start` does
    * NOT await it.
    *
    * This is load-bearing: `PreferenceService.ready` resolves only once the
    * preference providers are initialised, which happens as part of the same
    * startup sequence that runs the contributions, so awaiting it here deadlocks
    * the frontend on its preload splash. The threshold is therefore applied as
    * soon as preferences are ready, which is early but not synchronously before
    * the first possible log line.
    */
   onStart(): void {
      void this.applyWhenReady();
   }

   /** The awaited body of {@link onStart}, separated so it can be driven directly
    *  in tests without going through the non-awaited lifecycle hook. */
   protected async applyWhenReady(): Promise<void> {
      try {
         await this.preferences.ready;
         this.applyLevel();
         if (this.subscribed) {
            return;
         }
         this.subscribed = true;
         this.toDispose.push(
            this.preferences.onPreferenceChanged(event => {
               if (event.preferenceName === this.preferenceName) {
                  this.applyLevel();
               }
            })
         );
      } catch (err) {
         // Reported, not swallowed: an unapplied threshold silently hides every
         // diagnostic below the default, which reads as "the feature is broken".
         this.logger.error(`Failed to apply the log threshold from '${this.preferenceName}'`, err);
      }
   }

   onStop(): void {
      this.toDispose.dispose();
   }

   /**
    * Read the preference and apply it. An unparseable or unset value leaves the
    * current threshold alone rather than resetting it to a default — the value may
    * legitimately have been set by another source (an env baseline, a test).
    *
    * Override for a custom preference→level mapping.
    */
   protected applyLevel(): void {
      const level = parseLogLevel(this.preferences.get<string>(this.preferenceName));
      if (level) {
         Logger.setLevel(level);
      }
   }
}

/**
 * Bind {@link LogLevelPreferenceContribution} for `preferenceName`.
 *
 * Call from a **frontend** container module. Adopters using
 * `AbstractHydraniumGlspTheiaFrontendModule` set its `logLevelPreference` field
 * instead and the base calls this for them.
 */
export function bindLogLevelPreference(bind: interfaces.Bind, preferenceName: string): void {
   bind(LogLevelPreference).toConstantValue(preferenceName);
   bind(LogLevelPreferenceContribution).toSelf().inSingletonScope();
   bind(FrontendApplicationContribution).toService(LogLevelPreferenceContribution);
}
