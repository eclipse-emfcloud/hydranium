/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * End-to-end for the three heads in one web worker.
 *
 * **What this covers that nothing else can.** The framework's own
 * `start-glsp-server-in-worker.test.ts` runs the worker launcher headless over a
 * Node `MessagePort`, which settles the launch surface — but a GLSP model
 * reaching a VIEW has no headless equivalent, and the bug that cost the most on
 * this slice was exactly there: sprotty leaves its `<svg>` at the SVG default of
 * 300x150 and culls every element outside it, so a complete five-node model drew
 * two. Every assertion below on the rendered shape count exists because of that.
 *
 * The three heads are asserted TOGETHER rather than in three specs, because the
 * claim is that they share one Langium store. Split across specs each would pass
 * against three separate stores.
 */

import { expect, type Locator, type Page, test } from '@playwright/test';

/** Must match `WORKSPACE_ROOT_URI` / the seeded workspace in `src/head-channels.ts`. */
const WORKSPACE_DOCUMENT_COUNT = 8;

/** The one deliberate error in `examples/order-flow/workspace`. */
const WORKSPACE_DIAGNOSTIC_COUNT = 1;

/**
 * The seeded FILES, which is one fewer than the documents that validate.
 *
 * The difference is the point rather than an off-by-one: the eighth document is
 * an in-code contribution on the `virtual:` scheme, registered independently of
 * the workspace folder and backed by no file — so it is counted by the LSP head
 * and cannot appear in a list of things the page can open.
 */
const SEEDED_DOCUMENT_COUNT = WORKSPACE_DOCUMENT_COUNT - 1;

/** `orders/fulfillment.process`: Pay, PaymentOk, Pick, Ship, Cancel. */
const EXPECTED_NODES = ['Pay', 'PaymentOk', 'Pick', 'Ship', 'Cancel'];

/** Two `transition` lines plus the gateway's two branches. */
const EXPECTED_EDGE_COUNT = 4;

const MOUNT = '#order-flow-process-diagram';

/**
 * The graph, named by sprotty's own class rather than as `svg`.
 *
 * A bare `${MOUNT} svg` is ambiguous and silently so: GLSP's tool palette and
 * its minimise button live inside the mount and carry inline icon `<svg>`s, so
 * the loose selector measured one of those and reported a width of 0 — which
 * reads exactly like the sizing bug this spec exists to catch.
 */
const GRAPH = `${MOUNT} svg.sprotty-graph`;

/**
 * The page's own completion report, once it is neither placeholder nor pending.
 *
 * A count of the GRAPH the head sent, not of what is currently drawn, so it is
 * stable under anything that moves the canvas — which is what makes it usable as
 * a readiness gate. A DOM-derived report would vary with the viewport, and a
 * gate keyed on one would be a gate on the window size.
 */
const RENDERED_REPORT = /^\d+ node\(s\) and \d+ edge\(s\)$/;

/**
 * `orders/fulfillment.layout` as seeded: four entries, in file order, and no
 * `Cancel`.
 *
 * The absence is what makes `Cancel` the interesting drag target — the write
 * path for a node with no entry APPENDS one, and appending is the branch a
 * fixture where everything is already positioned can never reach.
 */
const SEEDED_LAYOUT = '4 entries: Pay 40,100; PaymentOk 260,90; Pick 440,200; Ship 660,200';

/** {@link SEEDED_LAYOUT} with one entry appended, up to the appended entry itself. */
const FIVE_ENTRIES = SEEDED_LAYOUT.replace('4 entries', '5 entries');

/**
 * The page's workspace report with nothing in storage.
 *
 * Asserted as an exact string rather than a pattern, because the two states it
 * has to be told apart from — a restore, and a save — are both prefixed
 * differently and a loose match would accept either.
 */
const FIRST_VISIT = 'no stored edits — seeded from the committed workspace';

/**
 * The two editors FIXED under the diagram, over the documents it is a view of.
 *
 * Fixed is what makes them safe to address by id: the page's third editor shows
 * whatever the workspace list last selected, so a selector pointing at that one
 * would be a claim about which document happened to be in it.
 */
const PROCESS_EDITOR = '#process-editor';
const LAYOUT_EDITOR = '#layout-editor';

/**
 * `orders/fulfillment.layout`'s declaration — the first line of it that is not a
 * comment, and therefore the line the page scrolls each editor to on open.
 */
const LAYOUT_DECLARATION = 'layout FulfillmentLayout for Fulfillment {';

/**
 * The last entry of `orders/fulfillment.layout`, spelled as the fixture has it.
 *
 * Used as the target for the in-place-replace check below, because it is the one
 * line on the page holding a NUMBER — and a number is what Monaco's editor
 * worker knows how to increment.
 */
const SHIP_ENTRY = '   node Ship at 660, 200 size 160, 60';

/** Just past `660`, so the word at the caret is that number. Derived, not counted. */
const SHIP_X_COLUMN = SHIP_ENTRY.indexOf('660') + '660'.length;

/**
 * The line whose highlighting is read, chosen because it carries three
 * different kinds AND a repeat: `process` and `for` are both keywords, which
 * this host colours because it ships no TextMate grammar; `Fulfillment` is a
 * `namespace`; and `Order` is a `class` reaching across a grammar boundary into
 * `orders.domain`. The keyword PAIR is what makes the classes comparable
 * against each other rather than against a literal.
 */
const HIGHLIGHTED_LINE = 'process Fulfillment for Order {';

/**
 * Text typed at the end of the `.process` file to make it unparseable.
 *
 * Outside the closing brace, so it is a plain syntax error at a stable position
 * and needs no cursor arithmetic. One extra diagnostic, measured.
 */
const SYNTAX_ERROR_TEXT = 'nonsense';

/**
 * The tool palette's collapse toggle.
 *
 * A SIBLING of the palette and not a child of it, which is the whole reason it
 * needs naming here: `@eclipse-glsp/client` inserts it into the diagram's base
 * div, so hiding the palette on a read-only canvas leaves it standing unless
 * something puts the two together. See `OrderFlowProcessToolPalette`.
 */
const PALETTE_TOGGLE = `${MOUNT} .minimize-palette-button`;

/** GLSP's status band, the surface the server's read-only reason lands on. */
const STATUS_BAND = `${MOUNT} .sprotty-status`;

/**
 * A character no `.process` token can start with, typed to make the document
 * fail LEXING rather than parsing.
 *
 * Distinct from {@link SYNTAX_ERROR_TEXT}, which is a well-formed identifier in
 * the wrong place and so a PARSING error. Both are structural and both take the
 * canvas read-only, but only this one exercises the lexer's own diagnostic — the
 * one Langium words from chevrotain rather than from its own message provider.
 *
 * One character, so recovery is a single `Backspace`.
 */
const LEXING_ERROR_TEXT = '§';

/**
 * The line in `orders/fulfillment.process` that the completion assertions ask
 * on, spelled exactly as the fixture has it.
 *
 * **The columns below are DERIVED from this string, not written as numbers.** The
 * assertions depend on asking at the character where a reference begins, and a
 * literal `25` says nothing about which reference that is and is silently wrong
 * the moment the fixture's indentation changes.
 */
const EFFECT_LINE = '   task Pay writes Order.status = PAID';

/** Where `Order.status`'s field reference begins — the second link of the chain. */
const FIELD_COLUMN = EFFECT_LINE.indexOf('status');

/** Where the enum literal begins — the third link, a hop through `Field.type`. */
const LITERAL_COLUMN = EFFECT_LINE.indexOf('PAID');

test.describe('order-flow in a web worker', () => {
   test('all three heads answer from one Langium store', async ({ page }) => {
      const consoleOutput: string[] = [];
      page.on('console', message => consoleOutput.push(`${message.type()}: ${message.text()}`));
      page.on('pageerror', error => consoleOutput.push(`pageerror: ${error.message}`));

      await page.goto('/');

      // The LSP head, against the same oracle the README names: `hydranium-cli
      // validate` over `examples/order-flow/workspace` from Node. A SHORTER list
      // is the failure this seeding arrangement is most likely to produce, so the
      // count is exact rather than a lower bound.
      await expect(page.locator('#status')).toHaveText(
         `${WORKSPACE_DOCUMENT_COUNT} documents validated, ${WORKSPACE_DIAGNOSTIC_COUNT} diagnostics`
      );

      // The data head, on its own channel. Agreement with the LSP head about the
      // same document is the one-store claim; two heads calling a document clean
      // would be satisfied by a head that never looked, which is why the fixture
      // document is the one with the deliberate error.
      await expect(page.locator('#data-head')).toHaveText(/^root DomainModel, 1 diagnostic\(s\)$/);

      // The GLSP head, on the third channel.
      await expect(page.locator('#glsp-head')).toHaveText(`${EXPECTED_NODES.length} node(s) and ${EXPECTED_EDGE_COUNT} edge(s)`);

      // The layout secondary, read back through the data head. Asserted here as
      // the pre-edit baseline the editing test below measures against — an edit
      // test that computes its own baseline cannot tell "the entry was created"
      // from "the entry was already there".
      await expect(page.locator('#layout-head')).toHaveText(SEEDED_LAYOUT);

      // Both Monaco editors, over the same LSP channel the diagnostics above
      // arrive on. Their content is not asserted here because the STATUS LINE
      // already asserts it: each editor sends `didOpen` with the text it was
      // given, so text differing from the seeded bytes would land in the
      // server's text-document store and change the diagnostic count away from
      // the Node oracle's. An exact count is therefore also the check that the
      // page is opening the documents the worker seeded.
      //
      // Each editor is asserted on its DECLARATION rather than on its first
      // line, and that is the property the page's reveal exists for: every
      // fixture here opens with a comment block written for a reader of the
      // repository, and `fulfillment.layout`'s runs to nineteen lines. An editor
      // left at line 1 shows nothing but prose, so the document a diagram drag
      // rewrites appears not to change.
      await expect(page.locator(`${PROCESS_EDITOR} .view-lines`)).toContainText(HIGHLIGHTED_LINE);
      await expect(page.locator(`${LAYOUT_EDITOR} .view-lines`)).toContainText(LAYOUT_DECLARATION);

      // And the same claim read off the DOM rather than off the page's own
      // report, because the report is code under test too. Element ids come from
      // the server's index, so naming them checks WHICH nodes arrived and not
      // merely how many — a culled Pick and a duplicated Pay would both pass a
      // bare count.
      // Scoped to the GRAPH, not the mount: sprotty also renders the whole model
      // into a HIDDEN measuring div for bounds computation, and while that div is
      // a sibling rather than a child, keeping the scope tight is what stopped
      // this suite from ever being able to pass on the measuring copy alone —
      // which is precisely the state the culling bug produced.
      for (const node of EXPECTED_NODES) {
         await expect(page.locator(`${GRAPH} [id="order-flow-process-diagram_${node}"]`)).toHaveCount(1);
      }
      // `g.sprotty-edge`, not `.sprotty-edge`: an edge's group AND the `<path>`
      // inside it both carry the class.
      await expect(page.locator(`${GRAPH} g.sprotty-edge`)).toHaveCount(EXPECTED_EDGE_COUNT);

      // SILENT, not merely error-free, and that stricter form is affordable
      // because it is currently true: the page binds the one host service GLSP
      // would otherwise warn about on every container build. The console is this
      // host's only log — the worker posts its failures on the global channel and
      // the language server's lines arrive over the LSP one — so a warning that
      // means nothing is worse here than elsewhere: it trains the reader to skim
      // the one place real failures appear. A new dependency that warns should
      // have to be looked at rather than absorbed.
      expect(consoleOutput).toEqual([]);
   });

   test('the diagram fills its mount instead of the SVG default', async ({ page }) => {
      await page.goto('/');
      // Wait for the page's own report before measuring. A rect read while the
      // graph is still being laid out is not a smaller box, it is a zero one —
      // the same reading a missing stylesheet produces, so the wait is what
      // keeps this test about the property it names.
      await expect(page.locator('#glsp-head')).toHaveText(RENDERED_REPORT);

      const size = await page.evaluate(
         ([graphSelector, mountSelector]) => {
            const graph = document.querySelector(graphSelector)?.getBoundingClientRect();
            const mount = document.querySelector(mountSelector)?.getBoundingClientRect();
            return {
               graph: { width: graph?.width ?? 0, height: graph?.height ?? 0 },
               mount: { width: mount?.width ?? 0, height: mount?.height ?? 0 }
            };
         },
         [GRAPH, MOUNT]
      );

      // Compared against the MOUNT rather than against 300x150, and the first
      // draft of this test is why. `> 300` / `> 150` looks like it excludes the
      // SVG default and does not: the mount has a 1px border, so the default
      // renders 302x152 and passes both. The control — deleting the sizing rule
      // — left this test green while the shape count in the test above dropped
      // to 2 of 5, which is a targeted guard that guards nothing. Asserting the
      // graph FILLS its mount is the property the rule exists for and cannot be
      // satisfied by a 302px box in a 960px mount.
      //
      // A few pixels of slack for the border, and a floor so a collapsed mount
      // cannot make "fills it" trivially true.
      expect(size.mount.width).toBeGreaterThan(300);
      expect(size.graph.width).toBeGreaterThan(size.mount.width - 4);
      expect(size.graph.height).toBeGreaterThan(size.mount.height - 4);
   });

   test('the loaded model is framed inside the canvas rather than anchored in a corner', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#glsp-head')).toHaveText(RENDERED_REPORT);

      const framing = await page.evaluate(
         ([graphSelector, mountSelector]) => {
            const mount = document.querySelector(mountSelector)?.getBoundingClientRect();
            const shapes = Array.from(document.querySelectorAll(`${graphSelector} > g > g[id] > .sprotty-node`));
            return {
               transform: document.querySelector(`${graphSelector} > g`)?.getAttribute('transform') ?? 'no viewport group',
               mount: { left: mount?.left ?? 0, right: mount?.right ?? 0, top: mount?.top ?? 0, bottom: mount?.bottom ?? 0 },
               shapes: shapes.map(shape => {
                  const box = shape.getBoundingClientRect();
                  return {
                     id: shape.parentElement?.id ?? 'unnamed',
                     left: box.left,
                     right: box.right,
                     top: box.top,
                     bottom: box.bottom
                  };
               })
            };
         },
         [GRAPH, MOUNT]
      );

      // Every seeded node, and this is the assertion the fit earns. The `.layout`
      // file places nodes by RANK, so the model is wider than the pane at this
      // viewport — left unframed it renders at `scale(1) translate(0,0)` with
      // `Ship` running off the right edge, and nothing on the page says so.
      // Named per shape rather than counted, so the failure says WHICH node left
      // the canvas.
      expect(framing.shapes).toHaveLength(EXPECTED_NODES.length);
      for (const shape of framing.shapes) {
         expect({ id: shape.id, outside: shape.left < framing.mount.left - 1 || shape.right > framing.mount.right + 1 }).toEqual({
            id: shape.id,
            outside: false
         });
      }

      // **And the viewport is a NUMBER**, which names the cause rather than
      // catching it. sprotty's own spelling for "fit everything" — an empty id
      // list, what `Ctrl+Shift+F` sends — resolves the element set by falling
      // back to every bounds-aware element in the index and yields
      // `translate(NaN,NaN)` over this model. Measured as a control, that state
      // culls every shape, so the page reports `nothing drawn after 15s` and the
      // gate above is what goes red; this line is here so the next reader of
      // that failure does not have to rediscover why.
      expect(framing.transform).not.toContain('NaN');
   });

   test('dragging a never-positioned node CREATES its layout entry', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#layout-head')).toHaveText(SEEDED_LAYOUT);

      // `Cancel` because it has no seeded entry. A drag of `Pay` would exercise
      // the update branch, which is the one a fixture where everything is
      // positioned already covers; the append branch is reachable only from a
      // node the `.layout` file never named.
      await dragBy(page, nodeLocator('Cancel'), { x: 300, y: 180 });

      // Read through the DATA head, so this measures the write and not the
      // client's optimistic move feedback — sprotty draws the node at the drop
      // point whether or not the operation ever reached the source model.
      const entry = await expectLayoutEntry(page, 'Cancel');

      // Not merely "an entry exists". The handler appends at `0, 0` and then
      // overwrites from the operation's `newPosition`, and `newPosition` is
      // OPTIONAL in `ElementAndBounds` — so an operation that arrived without
      // one would leave the entry at the origin, which for this node is also
      // exactly where it started. `Cancel 0,0` is therefore the shape of a
      // half-completed write, and a bare existence check cannot see it.
      expect(entry.x).toBeGreaterThan(50);
      expect(entry.y).toBeGreaterThan(50);
   });

   test('a diagram drag reaches the layout EDITOR, not only the store', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#layout-head')).toHaveText(SEEDED_LAYOUT);

      await dragBy(page, nodeLocator('Cancel'), { x: 300, y: 180 });

      // The store first, through the data head — the same assertion the drag test
      // above makes, and the reason it is repeated here is that it is the half
      // that ALREADY passed before this page answered `workspace/applyEdit`. The
      // request went out on every drag and `vscode-jsonrpc` replied
      // `MethodNotFound`; `ModelService` logged that through the tracer, which
      // reaches `window/logMessage` and nothing else, so the mirror to the editor
      // was lost with no symptom anywhere.
      const entry = await expectLayoutEntry(page, 'Cancel');

      // Read without scrolling anything, which is what the page's open-time
      // reveal buys. Monaco virtualises, so an entry outside the viewport is not
      // in the DOM at all — and `fulfillment.layout`'s `layout` block starts
      // below nineteen lines of comment, so an editor left at line 1 would need
      // scrolling first. Doing that here would also scroll the PAGE, which puts
      // the diagram mount out of the viewport and makes `dragBy` press at a
      // coordinate that lands nowhere.
      //
      // The editor, holding the SAME numbers the store does. Compared against the
      // store's values rather than against a range, because that agreement is the
      // property `applyEdit` exists to provide and it is what a stale or
      // mis-addressed edit breaks — an editor showing a Cancel entry at some
      // other position would satisfy a bare "contains node Cancel".
      await expect(page.locator(`${LAYOUT_EDITOR} .view-lines`)).toContainText(`node Cancel at ${entry.x}, ${entry.y}`);

      // And the seeded entries are still there, individually. The push is a
      // MINIMAL edit computed against the server's shadow of this buffer, so a
      // range addressed one line off splices the file — and the symptom is a
      // duplicated or truncated neighbour rather than a missing insertion.
      await expect(page.locator(`${LAYOUT_EDITOR} .view-lines`)).toContainText(SHIP_ENTRY.trim());
      await expect(page.locator(`${LAYOUT_EDITOR} .view-lines`)).toContainText('node Pick at 440, 200 size 160, 60');
   });

   test('the applyEdit echo of a diagram drag does not corrupt the document', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#layout-head')).toHaveText(SEEDED_LAYOUT);
      await expect(page.locator('#status')).toHaveText(
         `${WORKSPACE_DOCUMENT_COUNT} documents validated, ${WORKSPACE_DIAGNOSTIC_COUNT} diagnostics`
      );

      // The regression is silent DATA CORRUPTION on a path that reports success
      // at every step. The server pushes a minimal `applyEdit`; the page applies
      // it and echoes INCREMENTAL ranges keyed to the buffer it held before the
      // push; the store applied those ranges to text the authored write had
      // already advanced. Measured on this fixture, the echo's two ranges
      // (delete the comment header, insert the entry) both address lines past
      // the end of the shortened text, clamp, and between them empty the
      // document.
      //
      // `Cancel` is the only node that can show it: its drag INSERTS a line,
      // while every seeded node's drag replaces a coordinate, which re-applies
      // as a no-op and hides the defect completely. That is why the whole suite
      // was green through it.
      await dragBy(page, nodeLocator('Cancel'), { x: 300, y: 180 });
      await expectLayoutEntry(page, 'Cancel');

      // **The entry count is NOT the observable, and believing it was cost a
      // cycle.** The page's layout report is rendered from the last transfer
      // model the data head produced, so a document that stops PARSING leaves
      // the previous report standing — the report read "5 entries" both with the
      // defect and without it. What moves is the diagnostic count.
      //
      // And this is an ABSENCE assertion, so nothing above establishes it: the
      // echo is a whole socket round trip behind the write, and
      // `expectLayoutEntry` polls green on the write alone. Measured from the
      // server's own log, the echo is applied ~35 ms after the write's line; a
      // second is thirty times that.
      await page.waitForTimeout(1000);
      await expect(page.locator('#status')).toHaveText(
         `${WORKSPACE_DOCUMENT_COUNT} documents validated, ${WORKSPACE_DIAGNOSTIC_COUNT} diagnostics`
      );

      // The count too, for the OTHER corruption shape the same defect produces:
      // where the echo's ranges stay in bounds it duplicates the inserted line
      // instead of emptying the file, and duplicate entries are legal in this
      // grammar — so that shape yields no diagnostic at all and only the count
      // can see it.
      await expect(page.locator('#layout-head')).toContainText('5 entries:');
   });

   test('creating a task from the palette writes both documents', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#layout-head')).toHaveText(SEEDED_LAYOUT);
      // The canvas click below is a pointer gesture, so it needs the framed
      // viewport for the same reason a drag does.
      await expectFramedDiagram(page);

      await page.locator(`${MOUNT} .tool-button`, { hasText: 'Task' }).click();
      // Clicked through the LOCATOR with a relative position, not through
      // `page.mouse` with absolute page coordinates. The mount is taller than
      // the viewport, so an absolute point in its lower half is off-screen and
      // the synthetic click lands nowhere — the palette shows the tool armed,
      // the console stays clean, and nothing is created.
      const mount = await boundingBoxOf(page.locator(MOUNT));
      // Low and left of centre: the seeded nodes occupy the upper band and the
      // tool palette the upper right, so this is empty canvas at any zoom the
      // fit produces.
      await page.locator(MOUNT).click({ position: { x: mount.width * 0.4, y: mount.height * 0.85 } });
      // The create handler asks the client to open its label editor so the first
      // keystroke renames the node. Dismissed rather than left open, because an
      // active inline editor swallows the keyboard for anything after this.
      await page.keyboard.press('Escape');

      // The PRIMARY write, first. The element id is assigned by the server's
      // index over the rebuilt `.process` AST, so this is evidence about the
      // document rather than about the client's optimistic ghost. Asserted
      // before the layout entry so each of the two writes has an assertion that
      // can fail on its own — the layout entry would otherwise mask this one,
      // since a failure in either write breaks it.
      await expect(page.locator(`${GRAPH} [id="order-flow-process-diagram_NewTask"]`)).toHaveCount(1);

      // The SECONDARY write, read back through the data head.
      const entry = await expectLayoutEntry(page, 'NewTask');
      expect(entry.x).toBeGreaterThan(0);
      expect(entry.y).toBeGreaterThan(0);
   });

   /**
    * A document that stops parsing takes the canvas read-only, and the canvas
    * says so.
    *
    * **Three assertions rather than one, because the three surfaces have three
    * different owners and any of them can regress alone.** The palette is
    * withdrawn by `@eclipse-glsp/client` on the edit mode; the toggle is
    * withdrawn by this example's `OrderFlowProcessToolPalette`, because upstream
    * leaves it standing; and the band is written by the framework's
    * `onParseErrorChanged`. A test that only checked the palette would pass
    * against a canvas with a dangling control and no stated reason, which is the
    * state this whole slice exists to remove.
    *
    * **The recovery half is not symmetry, it is the load-bearing half.** A
    * read-only indicator that never clears is worse than none: it makes an
    * editable diagram look permanently locked, and the palette coming back is
    * the thing that would then contradict it.
    */
   test('a document that stops parsing takes the diagram read-only, with the reason on the canvas', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator(`${MOUNT} .tool-button`).first()).toBeVisible();
      await expect(page.locator(PALETTE_TOGGLE)).toBeVisible();
      // The band is EMPTY rather than absent to begin with: the extension is
      // mounted by GLSP's own diagram startup, so "no status" is a blank one.
      await expect(page.locator(STATUS_BAND)).toHaveText('');

      await page.locator(`${PROCESS_EDITOR} .view-line`).last().click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(LEXING_ERROR_TEXT);

      // The band FIRST, because it is the only one of the three that carries the
      // server's own account: reaching it means the `StatusAction` travelled the
      // GLSP channel, which the two visibility assertions cannot distinguish from
      // a purely client-side reaction to a stale edit mode.
      await expect(page.locator(STATUS_BAND)).toHaveText('Read-only: this document has a syntax error. Fix it to edit the diagram again.');
      await expect(page.locator(`${MOUNT} .tool-palette`)).toBeHidden();
      await expect(page.locator(PALETTE_TOGGLE)).toBeHidden();

      await page.keyboard.press('Backspace');

      await expect(page.locator(STATUS_BAND)).toHaveText('');
      await expect(page.locator(`${MOUNT} .tool-palette`)).toBeVisible();
      await expect(page.locator(PALETTE_TOGGLE)).toBeVisible();
   });

   test('highlighting comes from the server, not from a client grammar', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator(`${PROCESS_EDITOR} .view-lines`)).toContainText(HIGHLIGHTED_LINE);

      // Read as one span per token with its Monaco colour class, because that is
      // the only observable that distinguishes the two ways this can be broken
      // and they look identical on screen:
      //
      //  - No provider at all → Monaco renders the whole line as ONE span. There
      //    is no Monarch grammar underneath in this page, so nothing else splits
      //    it.
      //  - A provider whose token types the theme does not name → Monaco splits
      //    the line correctly and resolves EVERY span to the default foreground.
      //    This one is not hypothetical: standalone Monaco matches a theme rule's
      //    `token` against the semantic token type NAME, not against a TextMate
      //    scope the way VS Code does, so a theme written the VS Code way loads
      //    without complaint and colours nothing.
      //
      // Asserting on distinct classes catches both; asserting on the span count
      // alone would pass the second, and a screenshot would pass neither
      // informatively.
      // Polled for the SPLIT before reading the classes. The line's text is on
      // the page well before the semantic tokens are, because Monaco renders the
      // model immediately and only then asks the provider — so reading the spans
      // on the line after the text assertion finds one unsplit span and reports
      // it as missing highlighting. The wait is what keeps this test about where
      // the colours come from rather than about how fast they arrive.
      await expect
         .poll(async () => (await tokenSpansOnLine(page, PROCESS_EDITOR, HIGHLIGHTED_LINE)).map(span => span.text.trim()))
         .toContain('Fulfillment');

      const spans = await tokenSpansOnLine(page, PROCESS_EDITOR, HIGHLIGHTED_LINE);
      const classOf = (text: string): string | undefined => spans.find(span => span.text.trim() === text)?.tokenClass;

      // `Fulfillment` is a `namespace` and `Order` a `class`; the provider maps
      // both to the same colour on purpose, so they agree.
      expect(classOf('Fulfillment')).toBeDefined();
      expect(classOf('Order')).toBe(classOf('Fulfillment'));

      // The keywords, and the assertion has to work harder than it looks.
      //
      // `expect(classOf('process')).not.toBe(classOf('Fulfillment'))` — which
      // is what stood here — is green in BOTH states this page has been in:
      // before the server coloured keywords `process` carried the default
      // foreground and so differed from a name, and after it `process` is
      // keyword-blue and still differs from a name. It reports the feature
      // working before the feature exists.
      //
      // Nor is "`process` and `for` agree" enough on its own. With no Monarch
      // or TextMate grammar in this page, two UNCLAIMED tokens agree too — on
      // the default class — so that pair is satisfied by a server that answered
      // with no keywords at all.
      //
      // What only the keyword stream produces is a line split at every token
      // boundary: each keyword becomes its own span and the gaps between spans
      // become default-class spans of pure whitespace. Unclaimed, `process` and
      // the space after it are ONE span and no whitespace-only span exists at
      // all. So the whitespace span is the anchor — it is the default colour,
      // by construction — and the three assertions together say: the keywords
      // agree with each other, and they are a colour rather than the absence of
      // one.
      const whitespaceClass = spans.find(span => span.text.trim() === '')?.tokenClass;
      expect(whitespaceClass).toBeDefined();
      expect(classOf('for')).toBe(classOf('process'));
      expect(classOf('process')).not.toBe(whitespaceClass);
      expect(classOf('process')).not.toBe(classOf('Fulfillment'));
   });

   test('an edit reaches the server and its diagnostics come back as markers', async ({ page }) => {
      // Registered before the navigation, because a worker created during load
      // is announced once and a listener attached afterwards never hears about
      // it.
      const workers: string[] = [];
      page.on('worker', worker => workers.push(worker.url()));

      await page.goto('/');
      await expect(page.locator('#status')).toHaveText(
         `${WORKSPACE_DOCUMENT_COUNT} documents validated, ${WORKSPACE_DIAGNOSTIC_COUNT} diagnostics`
      );

      // Clicked through a rendered line rather than through Monaco's input
      // element. Monaco 0.56 drives its editor with the EditContext API, so the
      // `textarea.inputarea` every older recipe names does not exist — the only
      // textarea in the tree is `.ime-text-area`, and waiting for the old
      // selector times out with the editor plainly visible on screen.
      await page.locator(`${PROCESS_EDITOR} .view-line`).last().click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(SYNTAX_ERROR_TEXT);

      // The OUTBOUND half first: the server's own count moved, so `didChange`
      // arrived and the document was rebuilt. Asserted before the marker so each
      // direction has an assertion that can fail alone — the marker depends on
      // both, and would mask this one.
      await expect(page.locator('#status')).toHaveText(
         `${WORKSPACE_DOCUMENT_COUNT} documents validated, ${WORKSPACE_DIAGNOSTIC_COUNT + 1} diagnostics`
      );

      // The INBOUND half: `publishDiagnostics` reached this editor's model as a
      // marker. Scoped to the process editor, so a marker that landed on the
      // wrong model — the failure a URI mismatch produces — cannot satisfy it.
      await expect(page.locator(`${PROCESS_EDITOR} .squiggly-error`)).toHaveCount(1);
      await expect(page.locator(`${LAYOUT_EDITOR} .squiggly-error`)).toHaveCount(0);

      // **TWO workers, from two separately-emitted bundles**, named rather than
      // counted: Monaco's own is a third bundle whose URL reaches it through
      // `MonacoEnvironment.getWorker`, derived from the same constant that sets
      // esbuild's `outfile`.
      //
      // The two ways this can break are NOT alike, and only one of them is loud.
      // Both were measured:
      //  - **Wrong URL** → Monaco warns ("Could not create web worker(s).
      //    Falling back to loading web worker code in main thread") and carries
      //    on, so the console-silence assertion in the first test catches it too.
      //    This assertion is the one that says WHICH bundle was missing.
      //  - **Worker created but its RPC never boots** → completely SILENT, and
      //    this assertion cannot see it either: the worker is still constructed.
      //    That case is covered by the last test in this file, which asserts on a
      //    value only the worker can compute.
      expect(workers.filter(url => url.endsWith('/out/order-flow-worker.js'))).toHaveLength(1);
      expect(workers.filter(url => url.endsWith('/out/monaco-editor-worker.js'))).toHaveLength(1);
   });

   test('completion walks the dependent scope chain', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator(`${PROCESS_EDITOR} .view-lines`)).toContainText(EFFECT_LINE.trim());

      // **Asked at an EXISTING reference, in a document that parses cleanly.**
      // The obvious gesture — typing `writes Order.` and asking — makes the
      // request HANG: the truncated document never reaches a state the
      // completion handler answers at. That is recorded in the server package's
      // own `lsp-harness.integration.test.ts`, and error recovery is a separate
      // concern from scoping, which is what this asserts.
      await requestCompletion(page, FIELD_COLUMN);

      // The second link: `status` is offered because `Order` resolved, so the
      // candidates are Order's fields.
      await expect(suggestions(page).filter({ hasText: 'status' })).toHaveCount(1);
      await expect(suggestions(page).filter({ hasText: 'total' })).toHaveCount(1);
      // And the discriminating half — `sku` and `quantity` are `LineItem`'s
      // fields. A type-filtered global lookup would offer them, so their absence
      // is what separates a real dependent scope from one. Asserted AFTER the
      // presences on purpose: an absence is satisfied by a list that has not
      // rendered yet, and `status` being there is what proves it has.
      await expect(suggestions(page).filter({ hasText: 'sku' })).toHaveCount(0);
      await expect(suggestions(page).filter({ hasText: 'quantity' })).toHaveCount(0);

      await page.keyboard.press('Escape');

      // The third link, one hop further: the literal slot's candidates come from
      // the enumeration that `Order.status`'s TYPE resolves to, which is a
      // second dependent lookup through `Field.type.declared`.
      await requestCompletion(page, LITERAL_COLUMN);
      await expect(suggestions(page).filter({ hasText: 'PAID' })).toHaveCount(1);
      await expect(suggestions(page).filter({ hasText: 'CANCELLED' })).toHaveCount(1);
      // Not a field, not an entity — the slot narrowed rather than widened.
      await expect(suggestions(page).filter({ hasText: 'status' })).toHaveCount(0);
      await expect(suggestions(page).filter({ hasText: 'Order' })).toHaveCount(0);
   });

   test('accepting a suggestion in front of a reference REPLACES it', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator(`${PROCESS_EDITOR} .view-lines`)).toContainText(EFFECT_LINE.trim());

      // The caret sits at the START of `PAID`, which is the position the
      // completion context describes as whitespace — so the server has to measure
      // the name to the RIGHT of the cursor to offer a range covering it.
      // Without that the item goes out with an empty range and this accept
      // produces `SHIPPEDPAID`: the suggestion inserted in front of the word it
      // was meant to stand in for.
      await requestCompletion(page, LITERAL_COLUMN);
      await suggestions(page).filter({ hasText: 'SHIPPED' }).click();

      // Read off the editor rather than through the data head, because the claim
      // is about the TEXT the accept produced. `= SHIPPED` and nothing after it
      // is what distinguishes replace from insert; a bare "contains SHIPPED"
      // would pass on `SHIPPEDPAID` too.
      await expect(page.locator(`${PROCESS_EDITOR} .view-lines`)).toContainText('task Pay writes Order.status = SHIPPED');
      await expect(page.locator(`${PROCESS_EDITOR} .view-lines`)).not.toContainText('SHIPPEDPAID');
   });

   test('hover renders the declaration a cross-grammar reference resolves to', async ({ page }) => {
      await page.goto('/');

      // Waits for the semantic-token split, because the hover target has to be
      // the `Order` SPAN: before the tokens arrive the whole line is one span and
      // hovering it lands on `process`, which resolves to a different
      // declaration.
      await expect
         .poll(async () => (await tokenSpansOnLine(page, PROCESS_EDITOR, HIGHLIGHTED_LINE)).map(span => span.text.trim()))
         .toContain('Order');
      await page
         .locator(`${PROCESS_EDITOR} .view-line`)
         .filter({ hasText: HIGHLIGHTED_LINE })
         .locator('span[class^="mtk"]', { hasText: 'Order' })
         .first()
         .hover();

      // `entity Order` is declared in `orders/fulfillment.process`'s SIBLING
      // GRAMMAR — a `.domain` file the page has not opened — so this is the
      // shared index answering, not the open document. Filtered by content
      // because Monaco keeps more than one hover container in the DOM and the
      // others are empty.
      const hover = page.locator('.monaco-hover').filter({ hasText: 'entity Order' });
      await expect(hover).toHaveCount(1);
      // The field list, so this is the resolved DECLARATION and not an echo of
      // the reference text under the cursor.
      await expect(hover).toContainText('id, status, total, shipTo, lines');
   });

   test('the workspace list reaches the documents the diagnostics report names', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#status')).toHaveText(
         `${WORKSPACE_DOCUMENT_COUNT} documents validated, ${WORKSPACE_DIAGNOSTIC_COUNT} diagnostics`
      );

      // Every SEEDED document, which is fewer than the report counts: the eighth
      // is an in-code contribution on the `virtual:` scheme with no file behind
      // it, so it appears in the problems list and cannot appear here.
      const rows = page.locator('#document-list .document-row');
      await expect(rows).toHaveCount(SEEDED_DOCUMENT_COUNT);

      // **The count on a document NOBODY opened, which is the whole point of the
      // list.** `audit-leak.domain` exists so a diagnostic is published for a file
      // the page never opens, and before this list the report named it with no way
      // to see it. A list filtered to the open documents would show a clean
      // workspace and agree with itself instead of with the server.
      const auditLeak = rows.filter({ hasText: 'audit-leak' });
      await expect(auditLeak.locator('.badge')).toHaveText(String(WORKSPACE_DIAGNOSTIC_COUNT));
      await expect(rows.filter({ hasText: 'orders/returns.process' }).locator('.badge')).toHaveText('0');

      // Opening it puts it in the SELECTION editor, and leaves the pinned pair
      // alone — the pair is what the diagram is a view of, so a selection that
      // displaced either would leave the canvas drawing a document off screen.
      await auditLeak.click();
      await expect(page.locator('#selected-editor-title')).toHaveText('orders/audit-leak.domain');
      await expect(page.locator('#process-editor-title')).toHaveText('orders/fulfillment.process');
      await expect(page.locator('#layout-editor-title')).toHaveText('orders/fulfillment.layout');

      // And the diagnostic reached it as a marker, which is the check that the
      // document was genuinely OPENED rather than merely named in a header: the
      // adapter only paints markers on a model it has, so a title that changed
      // without a `didOpen` behind it fails here.
      await expect(page.locator('#selected-editor .squiggly-error')).toHaveCount(WORKSPACE_DIAGNOSTIC_COUNT);
   });

   test('clicking a diagnostic opens its document at the line', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#problem-list .problem-row')).toHaveCount(WORKSPACE_DIAGNOSTIC_COUNT);

      // The one deliberate error in the workspace, in a document the page has not
      // opened — so this click has to open it AND put the cursor on the line,
      // rather than reveal a line in something already on screen.
      await page.locator('#problem-list .problem-row').first().click();
      await expect(page.locator('#selected-editor-title')).toHaveText('orders/audit-leak.domain');

      // **The POSITION, proved by TYPING at it.** This document is fourteen
      // lines, so it fits in the pane whole and every line is on screen whatever
      // the reveal did — a `scrollTop` check would pass against a reveal that
      // lost the line number entirely. Monaco's caret is not a reliable
      // observable either: the layer is rendered conditionally on focus, so its
      // absence fails for the wrong reason. What the caret's position
      // unambiguously decides is where a keystroke lands, so the test puts one
      // there.
      await expect(page.locator('#selected-editor .view-line').filter({ hasText: 'stamp: AuditStamp' })).toHaveCount(1);
      await page.keyboard.type('X');
      await expect(page.locator('#selected-editor .view-line').filter({ hasText: 'X   stamp: AuditStamp' })).toHaveCount(1);

      // And the row said which line, so the number the page acted on is the one
      // the server published rather than a default.
      await expect(page.locator('#problem-list .problem-row .badge').first()).toHaveText(/^\d+:\d+$/);
   });

   /**
    * **The point is that ONE switch moves both halves**, so this asserts a
    * chrome label the page owns AND a diagnostic the server rendered, in the same
    * language, from a single `?locale=`. Either alone is satisfied by a page that
    * localized one half: chrome-only passes while every message stays English,
    * and diagnostic-only passes while every label does.
    *
    * The diagnostic is the discriminating half of the pair, because it can only
    * be German if the locale reached `initialize` — the page cannot render it.
    */
   test('one locale switch reaches the page chrome AND the server messages', async ({ page }) => {
      await page.goto('/?locale=de');
      await expect(page.locator('#glsp-head')).toHaveText(RENDERED_REPORT);

      await expect(page.locator('#document-panel h2')).toHaveText('Arbeitsbereich');
      await expect(page.locator('#log-panel h2')).toHaveText('Serverprotokoll');
      await expect(page.locator('#save-workspace span')).toHaveText('Arbeitsbereich speichern');
      // A `title`, so the attribute family is covered too — tooltip and
      // accessible-name prose is exactly what gets left untranslated.
      await expect(page.locator('#reset-layout')).toHaveAttribute('title', 'Ursprüngliche Bereichsgrößen wiederherstellen');
      await expect(page.locator('#log-filter')).toHaveAttribute('placeholder', 'Filter');
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');

      // The server half, from the same parameter.
      await expect(page.locator('#problem-list .problem-row')).toContainText('Referenz auf');

      // `Order Flow` is a product noun and stays put; asserted so a later sweep
      // that "finishes the job" by translating it fails here instead of shipping.
      await expect(page.locator('.titlebar h1')).toContainText('Order Flow');
   });

   /**
    * **This test does not discriminate on its own, and that is recorded rather
    * than papered over.** Measured: it stays green with the chrome overlay
    * disabled entirely, because "an unknown code leaves English" is also
    * satisfied by "nothing is ever translated". What separates the two is the
    * test above, which shows a KNOWN code changing the same labels — so the pair
    * carries the property and neither half does alone. Read them together.
    */
   test('an unknown locale falls back to the document rather than blanking it', async ({ page }) => {
      // The fallback every catalogue in this repo has, and the reason the English
      // lives in the markup: a code with no catalogue must leave the page
      // readable, not empty. `zz` reaches neither the page's overlay nor the
      // server's.
      await page.goto('/?locale=zz');
      await expect(page.locator('#glsp-head')).toHaveText(RENDERED_REPORT);
      await expect(page.locator('#document-panel h2')).toHaveText('Workspace');
      await expect(page.locator('#problem-list .problem-row')).toContainText('Could not resolve reference');
   });

   test('the language switch is the URL, so the choice is addressable', async ({ page }) => {
      await page.goto('/?locale=de');
      await expect(page.locator('#glsp-head')).toHaveText(RENDERED_REPORT);
      await expect(page.locator('#page-locale')).toHaveValue('de');

      // Back to the default, which DELETES the parameter rather than emptying it
      // — a `?locale=` left behind would have the address bar claim a language
      // the page is not using.
      await page.locator('#page-locale').selectOption('');
      await expect(page).toHaveURL(/\/$/);
      await expect(page.locator('#document-panel h2')).toHaveText('Workspace');
      await expect(page.locator('#page-locale')).toHaveValue('');
   });

   test('the log panel carries all three heads on one channel', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#glsp-head')).toHaveText(RENDERED_REPORT);

      // The count, which survives a filter and a scroll and is therefore the one
      // place the panel's whole contents are stated. A bare `> 0` rather than an
      // exact number: it is the server's build chatter, and pinning it would make
      // this a test of log volume.
      await expect(page.locator('#log-summary')).toHaveText(/^[1-9]\d*$/);

      // No click to open the dock first: nothing on this page is collapsed by
      // default any more, since the dock is its own resizable track rather than a
      // footer that takes its height from the editors.
      const lines = page.locator('#log div');

      // The LSP head, and specifically the page's own `didOpen` — authored by
      // `language-client`, which is the id the framework's text store gives the
      // LSP textual client.
      await expect(lines.filter({ hasText: 'fulfillment.layout' }).filter({ hasText: 'by language-client' })).not.toHaveCount(0);

      // The GLSP head, whose lines come from `@eclipse-glsp/server`'s own logger
      // rather than from the framework's — and the MESSAGE is what carries that,
      // `Initializing server with:` being upstream's own text in
      // `DefaultGLSPServer.initialize`. The component tag cannot carry it: GLSP
      // resolves a logger per injecting class and tags every line with that
      // class's name, and the framework rebinds `GLSPServer` to its own
      // subclass, so a tag alone matches lines the framework itself wrote.
      // Asserting BOTH keeps the pair of claims separate — upstream logged it,
      // and the framework's caller-tagged logger is what it logged through.
      // (The tag reads `HydraniumGlspServer2` on the page: the decorated-class
      // emit shadows its own name and the bundler renames the inner binding,
      // which is what `Function.name` reports. The substring still matches.)
      await expect(lines.filter({ hasText: 'HydraniumGlspServer' }).filter({ hasText: 'Initializing server with:' })).not.toHaveCount(0);

      // **The DATA head, and this is the assertion that earns the test.** That
      // head has its own `MessagePort` and its own protocol, so a line naming ITS
      // client id proves the claim the panel makes: the framework's logger routes
      // through the shared services' LSP connection, so ONE `window/logMessage`
      // channel carries every head. A panel fed only by the head it is attached
      // to would satisfy both assertions above and fail this one.
      await expect(lines.filter({ hasText: 'audit-leak.domain' }).filter({ hasText: 'by order-flow-browser-page' })).not.toHaveCount(0);
   });

   test('one switch drives the page chrome, the diagram roles and both editors', async ({ page }) => {
      // Loaded under a DARK OS preference, so the first half of this test is the
      // `prefers-color-scheme` claim rather than a default that happens to agree.
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.goto('/');
      await expect(page.locator('#glsp-head')).toHaveText(RENDERED_REPORT);
      // The editor colour cannot be read before the semantic tokens arrive: until
      // then the line is one unsplit span with the editor's default foreground,
      // which is a different colour from either scheme's `namespace` rule and
      // would read as the theme being wrong.
      await expect
         .poll(async () => (await tokenSpansOnLine(page, PROCESS_EDITOR, HIGHLIGHTED_LINE)).map(span => span.text.trim()))
         .toContain('Fulfillment');

      // Arm the selection tool, because its `.clicked` state is the only one of
      // the four colours that does not exist until something puts it there — and
      // it is the one worth guarding: GLSP renders a header tool as a bare
      // `<i class="codicon ... clicked">` with no `tool-button` class, so a rule
      // written for `.tool-button.clicked` matches NOTHING and GLSP's own
      // light-theme default shows through. That reads as coverage in the
      // stylesheet and as a rendering defect on the page, and no assertion on the
      // graph itself can see it.
      await page.locator(`${MOUNT} .header-tools [title="Enable selection tool"]`).click();

      await expect.poll(() => paintedColours(page)).toEqual(DARK_PAINT);

      // And now the half that a page keying its CSS off the media query directly
      // would fail: the switch has to OVERRULE the OS, which is why the roles are
      // scoped to a `data-theme` attribute instead.
      await page.locator('#dark-scheme').uncheck();
      await expect.poll(() => paintedColours(page)).toEqual(LIGHT_PAINT);
   });

   test('a SAVED edit survives a reload, and an unsaved one does not', async ({ page }) => {
      await page.goto('/');
      // The first-visit state, asserted so the restore below is a CHANGE from a
      // known baseline. Playwright gives each test its own storage partition, so
      // every test in this file starts here — but that is a property of the
      // harness rather than of the page, and this line is what makes it visible.
      await expect(page.locator('#workspace')).toHaveText(FIRST_VISIT);
      await expect(page.locator('#layout-head')).toHaveText(SEEDED_LAYOUT);

      // A diagram drag, so what is persisted has been through the whole write
      // path — GLSP operation, `ModelService.update`, `applyEdit` into the
      // editor — rather than typed straight into a buffer.
      await dragBy(page, nodeLocator('Cancel'), { x: 300, y: 180 });
      const entry = await expectLayoutEntry(page, 'Cancel');

      // **Nothing has reached storage yet, and this half is the one that makes
      // the other half mean something.** The write lives in the server's
      // in-memory text document until a save, exactly as it would on a Node
      // host — so a reload here returns the seeded workspace, and a page that
      // persisted on every write would pass the reload assertion below while
      // being a different design.
      await page.reload();
      await expect(page.locator('#workspace')).toHaveText(FIRST_VISIT);
      await expect(page.locator('#layout-head')).toHaveText(SEEDED_LAYOUT);

      await dragBy(page, nodeLocator('Cancel'), { x: 300, y: 180 });
      const saved = await expectLayoutEntry(page, 'Cancel');
      await page.locator('#save-workspace').click();
      // ONE document, not two: both editors are open and only the layout was
      // written, so a save that reported two would be pinning
      // `fulfillment.process` in storage at bytes nobody changed.
      await expect(page.locator('#workspace')).toHaveText(/^saved 1 document\(s\)/);

      await page.reload();

      // **The discriminating assertion, and it is read through the DATA head.**
      // The layout report is rendered from the transfer model the data head
      // produced for the reloaded document, so it measures what the language
      // server read out of the restored filesystem — where the editor's own
      // content would only show what the page put into it.
      await expect(page.locator('#layout-head')).toHaveText(`${FIVE_ENTRIES}; Cancel ${saved.x},${saved.y}`);
      // And the same position the pre-reload write produced, so this is the
      // stored edit rather than a second drag's coincidence.
      expect(saved).toEqual(entry);

      // The rest of the workspace came back intact: eight documents, one
      // deliberate error. A restore that shadowed a seeded file with an empty
      // entry, or lost one, moves this line — and it is the only assertion here
      // that covers the seven documents the page never opens.
      await expect(page.locator('#status')).toHaveText(
         `${WORKSPACE_DOCUMENT_COUNT} documents validated, ${WORKSPACE_DIAGNOSTIC_COUNT} diagnostics`
      );
      // The page's own account of where the content came from, which is the one
      // observable that distinguishes "restored" from "the seed happens to say
      // this too".
      await expect(page.locator('#workspace')).toHaveText('restored 1 file(s) from storage: orders/fulfillment.layout');
   });

   test('resetting the workspace returns the next load to the committed seed', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#layout-head')).toHaveText(SEEDED_LAYOUT);

      await dragBy(page, nodeLocator('Cancel'), { x: 300, y: 180 });
      await expectLayoutEntry(page, 'Cancel');
      await page.locator('#save-workspace').click();
      await expect(page.locator('#workspace')).toHaveText(/^saved 1 document\(s\)/);

      // Reset reloads the page itself, once the worker answers that the store is
      // empty — so there is no explicit `page.reload()` here and its absence is
      // the point: a reset that only cleared the store would leave this page
      // showing the edit it just discarded.
      await page.locator('#reset-workspace').click();

      await expect(page.locator('#workspace')).toHaveText(FIRST_VISIT);
      await expect(page.locator('#layout-head')).toHaveText(SEEDED_LAYOUT);
      await expect(page.locator('#status')).toHaveText(
         `${WORKSPACE_DOCUMENT_COUNT} documents validated, ${WORKSPACE_DIAGNOSTIC_COUNT} diagnostics`
      );
   });

   test("Monaco's editor worker computes, and not merely gets constructed", async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#layout-head')).toHaveText(SEEDED_LAYOUT);

      // **In-place replace is the one thing this page does whose ANSWER comes
      // from Monaco's editor worker.** `InPlaceReplaceController` routes through
      // `IEditorWorkerService.navigateValueSet` → `worker.$navigateValueSet`, so
      // the incremented value is computed off the main thread. Everything else
      // Monaco runs there — link detection, the diff algorithm, minimal edits —
      // either has no input on this page or has a main-thread fallback whose
      // result is indistinguishable.
      //
      // Without this the worker is only ever asserted to EXIST: the test above
      // names its bundle, but a worker whose RPC never boots is still
      // constructed, and every other test in this file stays green with the
      // bootstrap in `src/page/monaco-editor-worker.ts` disabled — including the
      // console-silence one, because nothing is logged. Measured, which is why
      // this test exists and why it is the only guard on that path.

      // No scrolling first: the page reveals each editor's declaration on open,
      // so the layout entries are already rendered. Scrolling the editor by
      // clicking its topmost line is not merely unnecessary but BROKEN — a
      // scrolled Monaco draws a `.scroll-decoration` shadow over the first
      // visible line, which intercepts the click and times out with the line
      // plainly on screen.
      await putCaret(page, LAYOUT_EDITOR, SHIP_ENTRY, SHIP_X_COLUMN);
      // `Control+Shift+Period` is `editor.action.inPlaceReplace.down`, which is
      // "next value" — 660 → 661. Its sibling on Comma goes the other way, and
      // the names are inverted relative to the argument they pass, so the
      // direction is stated here rather than inferred from the key.
      await page.keyboard.press('Control+Shift+Period');

      // Read through the DATA head, not off the editor, which makes this one
      // assertion cover the whole chain: the worker computed 481, Monaco applied
      // it, the adapter's `didChange` carried it to the server, and the shared
      // Langium store now holds it. Compared against the seeded line with one
      // number substituted, so an edit that disturbed any other entry fails here
      // too.
      await expect(page.locator('#layout-head')).toHaveText(SEEDED_LAYOUT.replace('Ship 660,200', 'Ship 661,200'));
   });

   /**
    * The server renders in the locale the page declares at `initialize`, and
    * `?locale=` is how a reader switches it in one reload.
    *
    * A worker has no host to ask for a language — no `vscode.env.language`, no
    * Theia `localeId` — so the page states one, and this is the only host in the
    * repo where the whole chain is visible on one screen: the query parameter,
    * the `initialize` param, the server's catalogue, and the published sentence.
    */
   test('renders diagnostics in the locale the page declared', async ({ page }) => {
      await page.goto('/?locale=de');
      await expect(page.locator('#status')).toHaveText(
         `${WORKSPACE_DOCUMENT_COUNT} documents validated, ${WORKSPACE_DIAGNOSTIC_COUNT} diagnostics`
      );

      // The workspace's one intended error, worded by LANGIUM and claimed by the
      // framework as `hydranium/core/unresolved-reference` — so seeing German
      // here is the whole feature: an unowned upstream sentence, translated by
      // the server, arriving on a surface that carries no catalogue at all.
      // Matched on the invariant half of the German plus the ref text rather
      // than the full sentence, so a `referenceType` change in the grammar does
      // not break a test about locales.
      const problems = page.locator('.problem-row');
      await expect(problems.filter({ hasText: 'konnte nicht aufgelöst werden' }).filter({ hasText: 'AuditStamp' })).toHaveCount(1);
   });

   test('renders the tool palette in the declared locale too', async ({ page }) => {
      // The seam is not error-shaped, which is the thing this asserts and
      // nothing else does: a palette label is a NOUN an adopter owns, and it
      // goes through the same one `MessageRenderer` binding as a framework
      // diagnostic. On this page both are visible at once under `?locale=de` —
      // the toolbox in German beside German squiggles.
      //
      // Read as the FULL label set rather than per-button, because the failure
      // that actually happened while writing this was a stale cached worker
      // bundle serving the pre-render palette: a per-button `hasText` reported
      // "no German button" for it, which reads as a render that did not happen
      // rather than as code the page never loaded. The whole set names what
      // arrived.
      await page.goto('/?locale=de');
      await expect(page.locator('#glsp-head')).toHaveText(RENDERED_REPORT);

      await expect(page.locator(`${MOUNT} .tool-button`)).toHaveText(['Aufgabe', 'Verzweigung', 'Übergang', 'Effekt']);
   });

   /**
    * MONACO's own menu in the declared locale — the one surface on this page
    * whose language is not the framework's to set.
    *
    * Everything else here is translated by a catalogue somebody in this repo
    * wrote. This is `monaco-editor-core`'s shipped German, reached by putting
    * `globalThis._VSCODE_NLS_MESSAGES` in place before Monaco's modules are
    * evaluated — which is the whole reason `order-flow-page.ts` exists as a
    * boot module separate from `workbench.ts`.
    *
    * **The right-click goes at the EDITOR's box, not the `.view-lines` one.**
    * Monaco renders past its viewport, so `.view-lines` reports a box taller
    * than the pane and a point inside it can be off-screen — measured, the
    * synthetic click then lands nowhere, no menu opens, and the failure reads as
    * a missing context-menu contribution rather than as bad coordinates.
    */
   test("renders Monaco's own context menu in the declared locale", async ({ page }) => {
      await page.goto('/?locale=de');
      await expect(page.locator(`${PROCESS_EDITOR} .view-lines`)).toContainText(HIGHLIGHTED_LINE);

      await rightClickInEditor(page, PROCESS_EDITOR);

      // The menu is Monaco's own overlay, appended to the body rather than into
      // the editor, so it is addressed from the document root.
      await expect(page.locator('.context-view .action-label').filter({ hasText: 'Ausschneiden' })).toHaveCount(1);
      await expect(page.locator('.context-view .action-label').filter({ hasText: 'Befehlspalette' })).toHaveCount(1);
   });

   test("labels Monaco's menu in English with no locale — the control on the row above", async ({ page }) => {
      // Without this the row above passes against a page that always loaded the
      // German bundle, which is the one thing the boot module could get wrong in
      // a way no other assertion sees.
      await page.goto('/');
      await expect(page.locator(`${PROCESS_EDITOR} .view-lines`)).toContainText(HIGHLIGHTED_LINE);

      await rightClickInEditor(page, PROCESS_EDITOR);

      await expect(page.locator('.context-view .action-label').filter({ hasText: 'Cut' })).toHaveCount(1);
      await expect(page.locator('.context-view .action-label').filter({ hasText: 'Ausschneiden' })).toHaveCount(0);
   });

   /**
    * A LEXER error in the declared locale — the message no layer of this stack
    * words itself.
    *
    * The unresolved-reference case above is Langium's sentence; this one is
    * CHEVROTAIN's, two dependencies down, copied through `processLexingErrors`
    * untouched and arriving with a `data.code` that names a kind rather than a
    * message. It is also the first message a user of a new language meets. So it
    * is the furthest the identity mechanism reaches, and the case an adopter
    * could not translate at all before the framework claimed it.
    *
    * Matched on the German plus the offending character, so a reworded German
    * clause does not break it while a rendering that lost the parameter — the
    * failure a code with no params would produce — still does.
    */
   test('renders a lexer error in the declared locale', async ({ page }) => {
      await page.goto('/?locale=de');
      await expect(page.locator('#status')).toHaveText(
         `${WORKSPACE_DOCUMENT_COUNT} documents validated, ${WORKSPACE_DIAGNOSTIC_COUNT} diagnostics`
      );

      await page.locator(`${PROCESS_EDITOR} .view-line`).last().click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(LEXING_ERROR_TEXT);

      const problems = page.locator('.problem-row');
      await expect(problems.filter({ hasText: 'Unerwartetes Zeichen' }).filter({ hasText: LEXING_ERROR_TEXT })).toHaveCount(1);
      await expect(problems.filter({ hasText: 'unexpected character' })).toHaveCount(0);
   });

   test('renders the lexer error in English with no locale — the control on the row above', async ({ page }) => {
      // Without this the row above passes against a page that always got German
      // — and, more specifically here, against an identity attached to the wrong
      // message, since chevrotain's own sentence is what the pass must reproduce
      // for an adopter shipping no catalogue.
      await page.goto('/');
      await expect(page.locator('#status')).toHaveText(
         `${WORKSPACE_DOCUMENT_COUNT} documents validated, ${WORKSPACE_DIAGNOSTIC_COUNT} diagnostics`
      );

      await page.locator(`${PROCESS_EDITOR} .view-line`).last().click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(LEXING_ERROR_TEXT);

      const problems = page.locator('.problem-row');
      await expect(problems.filter({ hasText: `unexpected character: ->${LEXING_ERROR_TEXT}<-` })).toHaveCount(1);
   });

   /**
    * The server states which language it is rendering in, in its own log.
    *
    * **The one thing on the page that can distinguish an undeclared locale from
    * an untranslated code**, which otherwise look identical: the framework ships
    * no catalogue, so both produce the English. Asserted from the LOG panel
    * rather than from the page's own status line on purpose — the page already
    * knows what it asked for, so a page-authored line would be a claim about
    * the query parameter, whereas this one crosses the channel and comes back
    * from the server that will do the rendering.
    *
    * Both directions in one test, because the pair is the assertion: the same
    * page with the parameter removed has to say the OTHER thing, or a server
    * that ignored the locale entirely would satisfy the first half.
    */
   test('the log says which language the server renders in', async ({ page }) => {
      await page.goto('/?locale=de');
      await expect(page.locator('#glsp-head')).toHaveText(RENDERED_REPORT);

      const lines = page.locator('#log div');
      await expect(lines.filter({ hasText: "rendering messages in locale 'de'" })).not.toHaveCount(0);
      await expect(lines.filter({ hasText: 'no locale declared' })).toHaveCount(0);

      await page.goto('/');
      await expect(page.locator('#glsp-head')).toHaveText(RENDERED_REPORT);

      const englishLines = page.locator('#log div');
      await expect(englishLines.filter({ hasText: 'no locale declared' })).not.toHaveCount(0);
      await expect(englishLines.filter({ hasText: 'rendering messages in locale' })).toHaveCount(0);
   });

   /**
    * The read-only band in the declared locale.
    *
    * A third seam shape after the diagnostic and the palette noun, and the one
    * that reaches furthest: this sentence is the framework's OWN, raised by
    * `@hydranium/glsp-server` on a GLSP action, and it arrives translated by an
    * adopter catalogue that says nothing about diagrams. Matched on the invariant
    * opening word rather than the full sentence, so a reworded recovery clause
    * does not break a test about locales.
    */
   test('renders the diagram read-only band in the declared locale', async ({ page }) => {
      await page.goto('/?locale=de');
      await expect(page.locator(`${MOUNT} .tool-button`).first()).toBeVisible();

      await page.locator(`${PROCESS_EDITOR} .view-line`).last().click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(LEXING_ERROR_TEXT);

      await expect(page.locator(STATUS_BAND)).toContainText('Schreibgeschützt');
      await expect(page.locator(STATUS_BAND)).not.toContainText('Read-only');
   });

   test('labels the palette in English with no locale — the control on the row above', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#glsp-head')).toHaveText(RENDERED_REPORT);

      await expect(page.locator(`${MOUNT} .tool-button`)).toHaveText(['Task', 'Gateway', 'Transition', 'Effect']);
   });

   test('renders the English when no locale is declared — the control on the row above', async ({ page }) => {
      // Same page, same catalogue, only the query parameter differs. Without
      // this the row above would pass against a page that always got German, and
      // against a server that ignored the locale entirely.
      await page.goto('/');
      await expect(page.locator('#status')).toHaveText(
         `${WORKSPACE_DOCUMENT_COUNT} documents validated, ${WORKSPACE_DIAGNOSTIC_COUNT} diagnostics`
      );

      const problems = page.locator('.problem-row');
      await expect(problems.filter({ hasText: 'Could not resolve reference to' }).filter({ hasText: 'AuditStamp' })).toHaveCount(1);
      await expect(problems.filter({ hasText: 'konnte nicht aufgelöst werden' })).toHaveCount(0);
   });
});

/**
 * The three colours that a colour-scheme switch has to move together, read as
 * PAINTED values rather than as the variables behind them.
 *
 * One per mechanism, because the three are themed by different means and a
 * switch that moves two of them is the failure worth catching:
 *
 * - `chrome` — the page's own surface, plain CSS on `body`.
 * - `diagramNode` — a task node's stroke, which is `--order-flow-task-accent`
 *   reaching an SVG element through `@hydranium/example-order-flow-client`'s
 *   stylesheet. Read off the ELEMENT, so it proves the role arrives where it is
 *   drawn rather than that a custom property was reassigned.
 * - `editorToken` — the colour Monaco resolved for a `namespace` semantic token,
 *   which is the only one of the three that is not CSS at all: it comes from a
 *   `defineTheme` rule selected by `setTheme`.
 * - `armedTool` — the border of the palette's armed header tool, which is GLSP's
 *   OWN DOM rather than the graph. Read as the border and not the background,
 *   because the background is a `color-mix` whose computed serialisation is not
 *   worth pinning; the border is a plain role value.
 */
interface PaintedColours {
   readonly chrome: string;
   readonly diagramNode: string;
   readonly editorToken: string;
   readonly armedTool: string;
}

/** `--order-flow-surface` #1f1f1f, `--order-flow-task-accent` #4a90d9, `namespace` #4ec9b0, focus #0078d4. */
const DARK_PAINT: PaintedColours = {
   chrome: 'rgb(31, 31, 31)',
   diagramNode: 'rgb(74, 144, 217)',
   editorToken: 'rgb(78, 201, 176)',
   armedTool: 'rgb(0, 120, 212)'
};

/** `--order-flow-surface` #ffffff, `--order-flow-task-accent` #1a7bbe, `namespace` #267f99, focus #005fb8. */
const LIGHT_PAINT: PaintedColours = {
   chrome: 'rgb(255, 255, 255)',
   diagramNode: 'rgb(26, 123, 190)',
   editorToken: 'rgb(38, 127, 153)',
   armedTool: 'rgb(0, 95, 184)'
};

/**
 * Read the three painted colours.
 *
 * Absolute values rather than "it changed", because a switch that landed in some
 * third state — a role left at its fallback, a Monaco theme that failed to
 * define — satisfies "changed" and is exactly what this is meant to catch.
 */
async function paintedColours(page: Page): Promise<PaintedColours> {
   return page.evaluate(
      ([graphSelector, editorSelector, needle]) => {
         const despace = (value: string): string => value.replace(/\s+/g, ' ');
         const node = document.querySelector(`${graphSelector} [id$="_Pay"] > .sprotty-node`);
         const lines = Array.from(document.querySelectorAll(`${editorSelector} .view-line`));
         const line = lines.find(candidate => despace(candidate.textContent ?? '').includes(despace(needle)));
         const token = Array.from(line?.querySelectorAll('span[class^="mtk"]') ?? []).find(
            span => despace(span.textContent ?? '').trim() === 'Fulfillment'
         );
         const armed = document.querySelector('.tool-palette .header-tools .clicked');
         return {
            chrome: getComputedStyle(document.body).backgroundColor,
            diagramNode: node === null ? 'no task node' : getComputedStyle(node).stroke,
            editorToken: token === undefined ? 'no namespace token' : getComputedStyle(token).color,
            armedTool: armed === null ? 'no armed tool' : getComputedStyle(armed).borderTopColor
         };
      },
      [GRAPH, PROCESS_EDITOR, HIGHLIGHTED_LINE]
   );
}

/** The rows of Monaco's suggest widget. */
function suggestions(page: Page): Locator {
   return page.locator('.suggest-widget .monaco-list-row');
}

/**
 * Open Monaco's context menu over the middle of an editor.
 *
 * **The point comes from the EDITOR's box, never from `.view-lines`.** Monaco
 * renders past its viewport, so the line container reports a box taller than the
 * pane it sits in — measured, a point ten pixels into that box was off-screen,
 * the synthetic right-click reached nothing, and the only symptom was a
 * `.context-view` that stayed empty.
 *
 * `page.mouse` rather than `locator.click`, because there is no element to name:
 * the target is a coordinate inside a virtualised surface, and a locator that
 * resolves to an over-rendered line is exactly the failure above.
 */
async function rightClickInEditor(page: Page, editorSelector: string): Promise<void> {
   const box = await boundingBoxOf(page.locator(editorSelector));
   await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
   await expect(page.locator('.context-view .action-label').first()).toBeVisible();
}

/**
 * Put the caret at `column` of the rendered line containing `lineText`.
 *
 * **The caret is placed by clicking the line's left EDGE and then walking
 * right**, not by clicking the token that holds the column. Clicking a token
 * needs the semantic-token split to have happened — before it, the line is a
 * single span and a click anywhere in it lands at column 0, which for a
 * completion request silently asks at the start of the line and returns the
 * keyword list. Walking from a known origin is independent of highlighting.
 *
 * `Home` is not used as the origin: Monaco's is smart-home, which stops at the
 * first non-whitespace character, so it would land three columns off on an
 * indented line.
 *
 * The line must be RENDERED. Monaco virtualises, so a line outside the viewport
 * is not in the DOM and the locator simply times out.
 */
async function putCaret(page: Page, editorSelector: string, lineText: string, column: number): Promise<void> {
   const line = page.locator(`${editorSelector} .view-line`).filter({ hasText: lineText.trim() });
   await line.click({ position: { x: 1, y: 5 } });
   for (let step = 0; step < column; step += 1) {
      await page.keyboard.press('ArrowRight');
   }
}

/** Put the caret at `column` of {@link EFFECT_LINE} and ask for completion. */
async function requestCompletion(page: Page, column: number): Promise<void> {
   await putCaret(page, PROCESS_EDITOR, EFFECT_LINE, column);
   // Explicitly invoked rather than left to a trigger character, so the test is
   // about the candidate set the server computes and not about which keystrokes
   // Monaco decides are worth asking on.
   await page.keyboard.press('Control+Space');
}

/** One rendered token: its text and the Monaco colour class the theme resolved it to. */
interface TokenSpan {
   readonly text: string;
   readonly tokenClass: string;
}

/**
 * The token spans of the rendered line containing `text`.
 *
 * Monaco VIRTUALISES its lines, so this only sees what is on screen — which is
 * why the callers wait for the line's text before asking. `mtk<n>` is Monaco's
 * generated colour class; the number is an index into the theme's colour map and
 * is not stable across theme edits, so the assertions compare classes with each
 * other rather than against a literal.
 *
 * **Every space is normalised out of the comparison, and skipping that cost a
 * cycle.** Monaco renders the spaces inside a line as U+00A0, so a plain
 * `textContent.includes('process Fulfillment for Order {')` never matches — while
 * Playwright's own `toContainText` normalises whitespace and matches the very
 * same line happily. The pair reads as the line being present for the assertion
 * and absent for this helper, which looks like a race and is not.
 */
async function tokenSpansOnLine(page: Page, editorId: string, text: string): Promise<TokenSpan[]> {
   return page.evaluate(
      ([selector, needle]) => {
         const despace = (value: string): string => value.replace(/\s+/g, ' ');
         // `Array.from` rather than spread: this project compiles against the
         // Node lib, where `NodeListOf` is not declared iterable.
         const lines = Array.from(document.querySelectorAll(`${selector} .view-line`));
         const line = lines.find(candidate => despace(candidate.textContent ?? '').includes(despace(needle)));
         const spans = line === undefined ? [] : Array.from(line.querySelectorAll('span[class^="mtk"]'));
         return spans.map(span => ({ text: despace(span.textContent ?? ''), tokenClass: span.className }));
      },
      [editorId, text]
   );
}

/**
 * Wait until the diagram is not only rendered but FRAMED.
 *
 * Required before any pointer gesture on the canvas, and `#layout-head` is not a
 * substitute even though it settles first: the page opens the layout document
 * through the data head BEFORE it mounts the diagram, so a test that gates on
 * that report can press the mouse while the fit is still pending — the press is
 * measured against the load-time viewport and the release against the fitted
 * one, and the operation goes out with a delta that matches neither.
 *
 * `#glsp-head` is the right gate because `mountProcessDiagram` frames the model
 * before it counts the shapes, so the line appearing means both are done. The
 * symptom without this is a drag that lands at the wrong coordinates
 * intermittently, which reads as a flaky write path.
 */
async function expectFramedDiagram(page: Page): Promise<void> {
   await expect(page.locator('#glsp-head')).toHaveText(RENDERED_REPORT);
}

/** One rendered flow node, by the id the server's index assigns it. */
function nodeLocator(name: string): (page: Page) => Locator {
   return page => page.locator(`${GRAPH} [id="order-flow-process-diagram_${name}"]`);
}

async function boundingBoxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
   const box = await locator.boundingBox();
   if (box === null) {
      throw new Error(`No bounding box for ${locator}`);
   }
   return box;
}

/**
 * Press on the centre of `target` and release it `by` pixels away.
 *
 * The intermediate moves are not cosmetic. GLSP's change-bounds tool arms on the
 * first `mousemove` after the press and only then starts accumulating the
 * delta — a single jump straight to the destination is consumed as the arming
 * move, so the operation goes out with a zero delta and the file is never
 * written. That failure looks like the write path being broken.
 */
async function dragBy(page: Page, target: (page: Page) => Locator, by: { x: number; y: number }): Promise<void> {
   await expectFramedDiagram(page);
   const box = await boundingBoxOf(target(page));
   const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
   await page.mouse.move(from.x, from.y);
   await page.mouse.down();
   await page.mouse.move(from.x + by.x, from.y + by.y, { steps: 10 });
   await page.mouse.up();
}

/**
 * Wait for `name` to appear as the LAST entry of the page's layout report, and
 * return its position.
 *
 * Last, not anywhere: both write paths append, so position in the line is what
 * distinguishes a created entry from one the fixture already had. The four
 * seeded entries are matched literally in front of it, so a write that also
 * disturbed them fails here rather than being averaged away — a serializer that
 * reflows the whole file is a real hazard on this path.
 */
async function expectLayoutEntry(page: Page, name: string): Promise<{ x: number; y: number }> {
   const report = page.locator('#layout-head');
   await expect(report).toHaveText(new RegExp(`^5 entries: ${SEEDED_LAYOUT.slice('4 entries: '.length)}; ${name} -?[\\d.]+,-?[\\d.]+$`));
   const text = await report.textContent();
   const match = /(-?[\d.]+),(-?[\d.]+)$/.exec(text ?? '');
   if (match === null) {
      throw new Error(`Layout report has no trailing position: ${text}`);
   }
   return { x: Number(match[1]), y: Number(match[2]) };
}
