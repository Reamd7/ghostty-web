/**
 * Render transaction contract tests.
 *
 * Verifies the on-demand rendering architecture:
 * - one WASM update() per transaction (frame-cached)
 * - at most one full viewport extraction per transaction
 * - zero compatibility getLine() calls on the renderer's screen-row path
 * - no per-row cell arrays / per-cell clones while painting the screen
 * - idle terminals keep no pending animation frame
 * - pool extraction failure keeps dirty state for retry
 * - public getLine() keeps stable-copy semantics
 *
 * Uses the opt-in perf counters (see lib/perf-counters.ts) as the observable.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type TerminalPerfCounters,
  disableTerminalPerfCounters,
  enableTerminalPerfCounters,
  getTerminalPerfCounters,
  resetTerminalPerfCounters,
} from './perf-counters';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';
import type { GhosttyCell } from './types';

function counters(): TerminalPerfCounters {
  const c = getTerminalPerfCounters();
  if (!c) throw new Error('perf counters not enabled');
  return c;
}
/**
 * Single-assertion test seam for addressing private scheduler/renderer
 * members whose shapes the compiler cannot name (private members block a
 * direct structural cast). Each call site fixes the shape via its type
 * argument.
 */
function privateHarness<T>(value: unknown): T {
  // SAFETY: test-only bridge; the shape is fixed by the call site's type
  // argument and exercised immediately by the assertions that follow.
  return value as T;
}

/** Drive the pending scheduled frame synchronously (tests must not depend on rAF timing). */
function runScheduledFrame(term: Terminal): void {
  privateHarness<{ runRenderTransaction(): void }>(term).runRenderTransaction();
}

describe('Render transaction', () => {
  let container: HTMLElement;
  let term: Terminal | null = null;

  beforeEach(() => {
    enableTerminalPerfCounters();
    resetTerminalPerfCounters();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (term) {
      term.dispose();
      term = null;
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    disableTerminalPerfCounters();
  });

  test('full-screen redraw: one update, one viewport extraction, no getLine', async () => {
    term = await createIsolatedTerminal({ cols: 80, rows: 24 });
    term.open(container);

    // Fill the whole screen so every row is dirty
    for (let i = 0; i < 24; i++) {
      term.write(`row ${i}\r\n`);
    }

    resetTerminalPerfCounters();
    runScheduledFrame(term);

    const c = counters();
    expect(c.renderTransactions).toBe(1);
    expect(c.wasmUpdateCalls).toBe(1);
    expect(c.getViewportCalls).toBe(1);
    expect(c.viewportCellsParsed).toBe(80 * 24);
    // The renderer paints screen rows from the pool: no compatibility
    // getLine() (which would add another full extraction + 80 clones)
    expect(c.getLineCalls).toBe(0);
    expect(c.lineCellsCloned).toBe(0);
    expect(c.renderedRows).toBe(24);
  });

  test('no-op transaction after clean render: no update, no viewport work', async () => {
    term = await createIsolatedTerminal({ cols: 80, rows: 24 });
    term.open(container);
    term.write('hello');
    runScheduledFrame(term);

    resetTerminalPerfCounters();
    runScheduledFrame(term);

    const c = counters();
    expect(c.renderTransactions).toBe(1);
    expect(c.getViewportCalls).toBe(0);
    expect(c.viewportCellsParsed).toBe(0);
    expect(c.renderedRows).toBe(0);
  });

  test('idle terminal keeps no pending frame after the last transaction', async () => {
    term = await createIsolatedTerminal({ cols: 80, rows: 24, cursorBlink: false });
    term.open(container);
    const harness = privateHarness<{ renderFramePending: boolean }>(term);
    runScheduledFrame(term);

    expect(harness.renderFramePending).toBe(false);

    // With no writes, selection, hover, scroll or blink, letting the event
    // loop spin must not run any further transaction.
    resetTerminalPerfCounters();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(counters().renderTransactions).toBe(0);
  });

  test('scrollToLine renders immediately through the scheduler', async () => {
    term = await createIsolatedTerminal({ cols: 80, rows: 24 });
    term.open(container);
    for (let i = 0; i < 60; i++) {
      term.write(`Line ${i}\r\n`);
    }
    runScheduledFrame(term);

    resetTerminalPerfCounters();
    term.scrollToLine(10);
    expect(counters().scheduleRequests).toBeGreaterThan(0);

    runScheduledFrame(term);
    const c = counters();
    // Scrolled viewport forces all rows; screen rows still come from the
    // single pool, scrollback rows from the per-row provider.
    expect(c.renderTransactions).toBe(1);
    expect(c.getViewportCalls).toBe(1);
    expect(c.getLineCalls).toBe(0);
    expect(c.getScrollbackLineCalls).toBe(10); // rows 0..9 come from scrollback
    expect(c.renderedRows).toBe(24);
  });

  test('cursor blink toggle requests a scheduled frame, not a render loop', async () => {
    term = await createIsolatedTerminal({ cols: 80, rows: 24, cursorBlink: true });
    term.open(container);
    term.write('hi');
    runScheduledFrame(term);

    const rendererHarness = privateHarness<{ toggleCursorBlink(): void }>(term.renderer);

    resetTerminalPerfCounters();
    rendererHarness.toggleCursorBlink();
    expect(counters().scheduleRequests).toBe(1);

    // The blink frame redraws only the cursor row from the shared pool.
    runScheduledFrame(term);
    const c = counters();
    expect(c.renderTransactions).toBe(1);
    expect(c.getViewportCalls).toBe(1);
    expect(c.getLineCalls).toBe(0);
    expect(c.renderedRows).toBe(1);
  });

  test('disabling blink restores cursor visibility and requests a frame', async () => {
    term = await createIsolatedTerminal({ cols: 80, rows: 24, cursorBlink: true });
    term.open(container);

    const rendererHarness = privateHarness<{
      toggleCursorBlink(): void;
      cursorVisible: boolean;
    }>(term.renderer);
    rendererHarness.toggleCursorBlink();
    expect(rendererHarness.cursorVisible).toBe(false);

    resetTerminalPerfCounters();
    term.options.cursorBlink = false;
    expect(rendererHarness.cursorVisible).toBe(true);
    // Blink stop restores visibility and repaints through the scheduler
    expect(counters().scheduleRequests).toBe(1);
  });

  test('dispose cancels the pending frame', async () => {
    term = await createIsolatedTerminal({ cols: 80, rows: 24 });
    term.open(container);
    term.write('hello');
    const pending = privateHarness<{ renderFramePending: boolean }>(term);
    expect(pending.renderFramePending).toBe(true);

    resetTerminalPerfCounters();
    term.dispose();
    term = null;
    expect(pending.renderFramePending).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(counters().renderTransactions).toBe(0);
  });

  test('public getLine() returns stable copies unaffected by later extractions', async () => {
    term = await createIsolatedTerminal({ cols: 80, rows: 24 });
    term.open(container);
    term.write('ABC');

    const wasmTerm = term.wasmTerm!;
    const line = wasmTerm.getLine(0);
    expect(line).not.toBeNull();
    const snapshot: GhosttyCell[] = line!.map((cell) => ({ ...cell }));

    // Screen changes and further extractions must not mutate the copy
    term.write('XYZ');
    wasmTerm.getViewport();
    wasmTerm.getViewportPool();

    expect(line!.length).toBe(snapshot.length);
    for (let i = 0; i < snapshot.length; i++) {
      expect(line![i]).toEqual(snapshot[i]);
    }
  });

  test('viewport pool failure aborts the frame without clearing dirty state', async () => {
    term = await createIsolatedTerminal({ cols: 80, rows: 24 });
    term.open(container);

    const renderer = term.renderer!;
    const mockBuffer = {
      beginFrame: () => 1, // DirtyState.PARTIAL
      endFrame: () => {},
      getViewportPool: () => null, // extraction failure
      getCursor: () => ({ x: 0, y: 0, visible: true }),
      getDimensions: () => ({ cols: 80, rows: 24 }),
      isRowDirty: () => true,
      getLine: () => null,
      clearDirty: () => {
        throw new Error('clearDirty must not run when the viewport pool failed');
      },
    };

    expect(() => renderer.render(mockBuffer, false)).not.toThrow();
  });
});
