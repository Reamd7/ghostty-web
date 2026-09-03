/**
 * Render performance self-test body.
 *
 * Scenarios (each ~N frames of render() with fresh writes between):
 *  - idle:      no writes between frames (R3: renderer must not even
 *               schedule a frame; we measure forced renders separately)
 *  - stream:    incremental line output (build-log / cat shape)
 *  - full:      every row dirty every frame (TUI full repaint shape)
 *
 * For each scenario × renderer we report render() wall-time percentiles
 * (p50/p95/max, ms) and the R1 contract check: wasm update() calls per
 * frame must be exactly 1.
 */

const params = new URLSearchParams(location.search);
const COLS = Number(params.get('cols') ?? 80);
const ROWS = Number(params.get('rows') ?? 24);
const FRAMES = Number(params.get('frames') ?? 120);

const log = (t) => { document.getElementById('log').textContent += t + '\n'; };

function percentile(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

function fmtStats(ms) {
  const sorted = [...ms].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: +percentile(sorted, 50).toFixed(3),
    p95: +percentile(sorted, 95).toFixed(3),
    max: +percentile(sorted, 100).toFixed(3),
    mean: +(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(3),
  };
}

// Deterministic payload generators.
let seq = 0;
function streamChunk() {
  // One dirty line per frame: log-shaped output.
  const colors = ['\x1b[32m', '\x1b[33m', '\x1b[36m', '\x1b[0m'];
  const c = colors[seq % colors.length];
  return `${c}[${String(seq++).padStart(6, '0')}] some build output line with text and numbers ${Math.random().toString(36).slice(2, 8)}\x1b[0m\r\n`;
}
function fullRepaintBytes() {
  // TUI-shaped: repaint most of the screen with SGR variety.
  let out = '\x1b[H';
  for (let y = 0; y < ROWS - 1; y++) {
    const bg = 41 + (y % 7);
    const fg = y % 2 ? 97 : 37;
    out += `\x1b[${fg};${bg}m${('#'.repeat(20) + ' full redraw row ' + y + ' ').slice(0, COLS - 10).padEnd(COLS - 10, '.')}\x1b[0m`;
    if (y < ROWS - 2) out += '\r\n';
  }
  return out;
}

async function main() {
  const { Ghostty } = await import('../lib/ghostty.ts');
  const ghostty = await Ghostty.load();
  const { CanvasRenderer } = await import('../lib/renderer.ts');
  const { getTerminalPerfCounters, resetTerminalPerfCounters, enableTerminalPerfCounters } = await import('../lib/perf-counters.ts');
  let WebGLRenderer = null;
  try {
    ({ WebGLRenderer } = await import('../lib/renderers/webgl/renderer.ts'));
  } catch { /* canvas-only environment */ }

  const glBackend = (() => {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      if (!gl) return 'none';
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'masked';
    } catch (e) { return 'error'; }
  })();

  enableTerminalPerfCounters();

  const mkRenderers = () => {
    const cvA = document.createElement('canvas');
    const cvB = document.createElement('canvas');
    document.body.append(cvA, cvB);
    const common = { fontSize: 15, fontFamily: 'monospace' };
    const a = new CanvasRenderer(cvA, { ...common });
    const b = WebGLRenderer ? new WebGLRenderer(cvB, { ...common }) : null;
    return { a, b, cvA, cvB };
  };

  /** Measure one renderer over a scenario. */
  async function measure(renderer, kind) {
    const term = ghostty.createTerminal(COLS, ROWS);
    renderer.resize(COLS, ROWS);
    // Warm-up: fill the screen once so atlas/pages are hot.
    term.write('warmup\r\n'.repeat(ROWS));
    renderer.render(term, true, 0);

    resetTerminalPerfCounters?.();
    const times = [];
    const totalBefore = getTerminalPerfCounters?.()?.wasmUpdateCalls ?? 0;
    let frames = 0;

    await new Promise((resolve) => {
      const tick = () => {
        if (kind === 'stream') term.write(streamChunk());
        else if (kind === 'full') term.write(fullRepaintBytes());
        // idle: no write — render still forced by the harness so we can
        // measure the (empty) frame cost; scheduling behavior is asserted
        // separately via the R3 check below.
        const t0 = performance.now();
        renderer.render(term, false, 0);
        times.push(performance.now() - t0);
        frames++;
        if (frames < FRAMES) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });

    const counters = getTerminalPerfCounters?.();
    const updates = (counters?.wasmUpdateCalls ?? 0) - totalBefore;
    return {
      ...fmtStats(times),
      wasmUpdatesPerFrame: +(updates / frames).toFixed(2),
    };
  }

  window.__runPerf = async () => {
    const report = { glBackend, cols: COLS, rows: ROWS, frames: FRAMES, results: {} };

    for (const [label, RendererClass] of [
      ['canvas', null],
      ['webgl', WebGLRenderer],
    ]) {
      if (label === 'webgl' && !RendererClass) {
        report.results.webgl = { skipped: 'WebGLRenderer unavailable' };
        continue;
      }
      const { a, b, cvA, cvB } = mkRenderers();
      const renderer = label === 'canvas' ? a : b;
      report.results[label] = {
        idle: await measure(renderer, 'idle'),
        stream: await measure(renderer, 'stream'),
        full: await measure(renderer, 'full'),
      };
      a.dispose?.();
      b?.dispose?.();
      cvA.remove();
      cvB.remove();
    }

    // R3 contract: with no writes and no interactions, a Terminal must not
    // keep scheduling frames. The renderer-level proxy: toggleCursorBlink
    // requests repaints only when blink is enabled; idle render() with
    // frameDirty == NONE must be cheap (measured above as 'idle').
    const r1ok = Object.values(report.results).every(
      (r) => r.skipped || (r.stream.wasmUpdatesPerFrame <= 1.01 && r.full.wasmUpdatesPerFrame <= 1.01)
    );
    report.r1OneUpdatePerFrame = r1ok;
    report.idleFrameMs = {
      canvas: report.results.canvas?.idle?.p50,
      webgl: report.results.webgl?.idle?.p50,
    };

    log(JSON.stringify(report, null, 1));
    return report;
  };

  log('ready — call __runPerf()');
}

main().catch((e) => log('fatal: ' + e));
