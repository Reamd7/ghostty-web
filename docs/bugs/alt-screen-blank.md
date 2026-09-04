# BUG: alt-screen apps render blank on webgl-renderer branch (btop/fresh)

## Symptom
- btop (scoop 1.0.3) and fresh (0.4.7) enter the alternate screen
  (ESC [?1049h verified via isAlternateScreen()=true), then the canvas
  stays empty (all background pixels). Shell prompt/echo on the primary
  screen renders fine. Intermittently a full btop frame renders once
  (observed once per fresh page load), then never again.
- Affects BOTH renderers (canvas 2D and WebGL) — not a renderer bug.

## Reproduction (deterministic in 8/9 runs)
demo server + demo/index.html, type `btop`, wait 10s, canvas is blank.
Runtime probes (monkey-patched, no source changes): writes reach
term.write (39 calls, 3710-byte frames), renders run (44 calls),
getViewportPool succeeds every time (74/74, 3675 cells), rAF healthy
(59fps), visibility visible, viewportY=0, canvas 2D context healthy.

## The contradiction that localizes it
- getViewportPool() AT RENDER TIME returns the CMD banner
  ("Microsoft Windows [Version ...") — primary-screen content —
  while isAlternateScreen() is true. The alt-screen frames written by
  btop never appear in the extracted viewport.
- Forced forceAll=true every frame still renders blank — ruling out
  all dirty-tracking hypotheses.
- Independent minimal repro (write ?1049h + cursor-addressed text)
  DOES show updated content in the pool — the failure needs the real
  btop/fresh byte stream or timing.

## Prime suspect
The wasm-api patch's renderStateGetViewport reads
`t.screens.active.pages` — "active" resolution during/after alt-screen
switching under real TUI load, or the render_state rows/cols
bookkeeping vs the active screen, returns stale primary-screen data so
the renderer paints the pre-alt state (then usually nothing, since the
initial alt frame arrives after the switch frame was already consumed).

## Also ruled out
PTY crash loop (no WS reconnect storm), DirtyState semantics in
isolation (clearDirty→write→update yields row-dirty=1), abort-frame
retry accounting (counts were cursor-blink ticks), scheduling chain,
environment (real GPU, visible page).

## Status
Not fixed. Needs: (1) Zig-level trace of renderStateGetViewport's
screen selection during a recorded btop session; (2) compare against
the main branch (v1.22 era, pre-R1/R3) where btop was reported working
in production — this branch is a regression candidate (R1 frame
transaction or the 1.3.1 submodule bump).
