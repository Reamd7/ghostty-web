# RESOLVED: alt-screen apps blank (btop/fresh) — rendering stack exonerated

## Final verdict (supersedes the earlier wasm-patch suspicion)

The rendering stack is **correct** under real TUI load. Three
independent proofs on recorded btop byte streams (221 WS chunks,
28KB):

1. **Isolated replay**: the recorded chunks fed to a fresh Terminal
   (full stack: open, fit-style resize mid-stream, selection manager)
   render complete btop UI — 11,708 content pixels on canvas, with
   mid-stream resizes.
2. **Manual frame on the live demo terminal**: one forced render
   paints 102,948 pixels of live btop state from the same wasm
   viewport the scheduler was skipping.
3. **Dirty propagation observed working**: content-bearing chunks
   (3719-byte btop refresh frames) mark 34/35 rows dirty; frames
   carrying those rows into render() were logged in the auto-schedule
   path.

## The two real defects found and fixed along the way

1. **Row-dirty consumption timing** (fixed): under real TUI load the
   rAF frame's row walk can observe an empty dirty table — update()
   consumes the dirty state that isRowDirty() reads, so partial-dirty
   frames could paint zero rows while data sat in the viewport.
   Writes now schedule a full-frame render (`forceAllNextRender`);
   idle blink frames still take the cheap no-dirty skip, so the R3
   idle-CPU contract holds. Contract test updated accordingly.
2. **Aborted-frame livelock** (fixed): a render aborted on viewport
   extraction failure kept dirty state "for retry" but nothing
   scheduled the retry. Both renderers now re-schedule via
   onRenderRequest on abort.

## The environmental factor

btop.exe and fresh.exe under this Windows ConPTY demo-server setup
intermittently **stop producing output** (process instability), which
is what the blank screens actually were — the last stable frames were
blink-row flicker. Six-and-a-half-second probes show zero writes
arriving while "Connected" stays green. Not a ghostty-web defect;
needs investigation in the demo PTY layer if headless TUI testing is
wanted long-term (TERM env, ConPTY flags).

## Method note

The localization pivoted on recording the WS byte tape and replaying
it against progressively richer stacks (bare GhosttyTerminal →
resize-interleaved → full Terminal) — the differential turned an
unreliable headless symptom into a deterministic reproduction that
exonerated every layer it passed through.
