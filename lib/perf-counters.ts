/**
 * Terminal render performance counters.
 *
 * Opt-in instrumentation for tests and profilers. Disabled by default so the
 * production hot path pays nothing beyond one null check per counter site.
 *
 * Counters distinguish Wasm boundary crossings from data volumes: "cells
 * parsed" measures how many cells crossed the shared linear memory and were
 * decoded in JS, which is not the same as the number of export calls.
 */

export interface TerminalPerfCounters {
  /** scheduleRender() invocations (before coalescing). */
  scheduleRequests: number;
  /** scheduleRender() calls skipped because a frame was already pending. */
  coalescedScheduleSkips: number;
  /** Render transactions executed. */
  renderTransactions: number;
  /** Real ghostty_render_state_update boundary crossings (frame-cached calls do not count). */
  wasmUpdateCalls: number;
  /** Full viewport extractions (getViewport/getViewportPool). */
  getViewportCalls: number;
  /** Cells decoded from Wasm memory into the viewport cell pool. */
  viewportCellsParsed: number;
  /** Compatibility getLine() calls (each triggers a full viewport extraction + row clone). */
  getLineCalls: number;
  /** Cell objects deep-copied by compatibility getLine(). */
  lineCellsCloned: number;
  /** getScrollbackLine() calls (one row per Wasm call). */
  getScrollbackLineCalls: number;
  /** Cells decoded from Wasm memory for scrollback rows. */
  scrollbackCellsParsed: number;
  /** isRowDirty() boundary crossings. */
  isRowDirtyCalls: number;
  /** Rows painted by the renderer. */
  renderedRows: number;
}

function createCounters(): TerminalPerfCounters {
  return {
    scheduleRequests: 0,
    coalescedScheduleSkips: 0,
    renderTransactions: 0,
    wasmUpdateCalls: 0,
    getViewportCalls: 0,
    viewportCellsParsed: 0,
    getLineCalls: 0,
    lineCellsCloned: 0,
    getScrollbackLineCalls: 0,
    scrollbackCellsParsed: 0,
    isRowDirtyCalls: 0,
    renderedRows: 0,
  };
}

let counters: TerminalPerfCounters | null = null;

/** Enable counting and return the counter object. */
export function enableTerminalPerfCounters(): TerminalPerfCounters {
  if (!counters) counters = createCounters();
  return counters;
}

/** Stop counting. Hot-path counter sites go back to a single null check. */
export function disableTerminalPerfCounters(): void {
  counters = null;
}

/** Current counters, or null when counting is disabled. */
export function getTerminalPerfCounters(): TerminalPerfCounters | null {
  return counters;
}

/** Zero all counters (keeps counting enabled). */
export function resetTerminalPerfCounters(): void {
  if (counters) counters = createCounters();
}
