/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as Mocha from 'mocha';

/**
 * Spec output for the log plus an `xunit` file for the CI summary, since Mocha
 * takes one reporter. `done` is forwarded because Mocha calls it on this
 * reporter only, and `xunit` closes its file there.
 */
class HostTierReporter extends Mocha.reporters.Spec {
   protected readonly xunit: Mocha.reporters.XUnit;

   constructor(runner: Mocha.Runner, options: Mocha.MochaOptions) {
      super(runner, options);
      this.xunit = new Mocha.reporters.XUnit(runner, options);
   }

   override done(failures: number, callback: (failures: number) => void): void {
      this.xunit.done(failures, callback);
   }
}

export = HostTierReporter;
