// Scene registry: each scene is a VT byte producer over (cols).
      // Deterministic — the whole point is a repeatable pixel verdict.
      const SCENES = {
        s1_bg: (cols) => {
          const out = [];
          const colors = [
            '\x1b[40m', '\x1b[41m', '\x1b[42m', '\x1b[43m',
            '\x1b[44m', '\x1b[45m', '\x1b[46m', '\x1b[47m',
            '\x1b[48;5;208m', '\x1b[48;5;99m', '\x1b[48;2;18;52;86m',
            '\x1b[48;2;200;30;30m',
          ];
          for (let i = 0; i < colors.length; i++) {
            out.push(colors[i] + ' '.repeat(cols) + '\x1b[0m');
          }
          return out.join('\r\n');
        },
        s2_style: () => {
          return [
            'plain text 0123456789',
            '\x1b[1mbold text\x1b[0m \x1b[3mitalic\x1b[0m',
            '\x1b[4munderline\x1b[0m \x1b[9mstrikethrough\x1b[0m',
            '\x1b[7minverse\x1b[0m \x1b[2mdim/faint\x1b[0m',
            '\x1b[1;4;31mbold red underline\x1b[0m',
            '\x1b[38;5;208mfg 256-orange\x1b[0m \x1b[38;2;0;191;255mfg truecolor\x1b[0m',
            '\x1b[33;44mfg on bg\x1b[0m',
          ].join('\r\n');
        },
        s3_unicode: () => {
          return [
            'CJK: 你好，世界！终端渲染测试',
            'CJK wide: 中文全角占两列',
            'emoji: \u{1F600} \u{1F680} \u{1F44D} flags: \u{1F1E8}\u{1F1F3}\u{1F1FA}\u{1F1F8}',
            'combining: e\u0301 a\u0308 n\u0303',
            'box: ┌─┬─┐ │ ├─┼─┤ └─┴─┘ ─ │ ┌ ┐',
            'powerline-ish: \u{E0B0}\u{E0B2} \u{E0A0} \u{E0B6}',
          ].join('\r\n');
        },
        s4_blocks: () => {
          return [
            '\u2580\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588',
            '\u2589\u258A\u258B\u258C\u258D\u258E\u258F\u2590',
            '\u2594\u2595\u2596\u2597\u2598\u2599\u259A\u259B\u259C\u259D\u259E\u259F',
            '\x1b[31m\u2588\u2588\x1b[32m\u2588\u2588\x1b[34m\u2588\u2588\x1b[0m',
            '\x1b[7m\u2591\u2592\u2593\x1b[0m (shade trio via glyphs)',
          ].join('\r\n');
        },
      };

      const COLS = 40;
      const ROWS = 14;
      const FONT_SIZE = 15;

      const params = new URLSearchParams(location.search);
      const sceneNames = params.get('scenes')?.split(',') ?? Object.keys(SCENES);
      const selfCheck = params.get('self') === '1';
      const cursorStyle = params.get('cursor') ?? 'block';

      const setStatus = (t) => { document.getElementById('status').textContent = t; };

      async function readPixels(canvas) {
        return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = canvas.width;
            c.height = canvas.height;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);
            resolve(ctx.getImageData(0, 0, c.width, c.height));
          };
          img.onerror = () => resolve(null);
          img.src = canvas.toDataURL('image/png');
        });
      }

      async function pixelDiff(a, b, tolerance) {
        const ea = await readPixels(a);
        const eb = await readPixels(b);
        if (!ea || !eb) return { error: 'canvas read failed' };
        if (ea.width !== eb.width || ea.height !== eb.height) {
          return { error: 'size mismatch', ref: `${ea.width}x${ea.height}`, gl: `${eb.width}x${eb.height}` };
        }
        let mismatch = 0, maxChannelDiff = 0, sumDiff = 0;
        const n = ea.width * ea.height;
        for (let i = 0; i < ea.data.length; i += 4) {
          const m = Math.max(
            Math.abs(ea.data[i] - eb.data[i]),
            Math.abs(ea.data[i + 1] - eb.data[i + 1]),
            Math.abs(ea.data[i + 2] - eb.data[i + 2])
          );
          if (m > tolerance) mismatch++;
          if (m > maxChannelDiff) maxChannelDiff = m;
          sumDiff += m;
        }
        return {
          width: ea.width,
          height: ea.height,
          mismatch,
          mismatchPct: +((mismatch / n) * 100).toFixed(4),
          maxChannelDiff,
          meanChannelDiff: +(sumDiff / n).toFixed(4),
        };
      }

      function makeDiff(canvasRef, canvasGl, getRefRenderer, getGlRenderer, ghostty) {
        return async (tolerance = 8, mismatchLimitPct = 0.5) => {
          const results = [];
          for (const name of sceneNames) {
            const producer = SCENES[name];
            if (!producer) { results.push({ scene: name, error: 'unknown scene' }); continue; }
            // Two independent terminals fed identical bytes: the R1 frame
            // protocol gives each renderer its own dirty state (a second
            // renderer reading a cleaned buffer would legitimately abort).
            const termRef = ghostty.createTerminal(COLS, ROWS);
            const termGl = ghostty.createTerminal(COLS, ROWS);
            const data = producer(COLS);
            termRef.write(data);
            termGl.write(data);

            const refR = getRefRenderer();
            const glR = getGlRenderer();
            refR.resize(COLS, ROWS);
            glR.resize(COLS, ROWS);
            refR.render(termRef, true, 0);
            glR.render(termGl, true, 0);

            const d = await pixelDiff(canvasRef, canvasGl, tolerance);
            results.push({
              scene: name,
              ...d,
              pass: d.error === undefined && d.mismatchPct <= mismatchLimitPct && d.maxChannelDiff <= tolerance * 3,
            });
          }
          return { tolerance, results, allPass: results.every((r) => r.pass) };
        };
      }

      async function main() {
        setStatus('loading wasm…');
        const { Ghostty } = await import('../lib/ghostty.ts');
        const ghostty = await Ghostty.load();
        const { CanvasRenderer } = await import('../lib/renderer.ts');

        // WebGL renderer is optional until M1 lands: import failure must be
        // reported, not break the loop.
        let WebGLRenderer = null;
        let webglError = null;
        try {
          // Non-literal specifier + @vite-ignore: vite must not try to
          // resolve this at transform time — the whole point is that the
          // module may not exist until M1 lands.
          const webglPath = '../lib/renderers/webgl/' + 'renderer.ts';
          ({ WebGLRenderer } = await import(/* @vite-ignore */ webglPath));
        } catch (e) {
          webglError = String(e && e.message ? e.message : e);
        }

        await document.fonts.ready;

        const canvasRef = document.getElementById('c-ref');
        const canvasGl = document.getElementById('c-gl');
        const common = { fontSize: FONT_SIZE, fontFamily: 'monospace', cursorStyle, cursorBlink: false };

        const refRenderer = new CanvasRenderer(canvasRef, { ...common });
        let rightRenderer = null;
        let rightLabel = 'webgl (candidate)';

        if (selfCheck) {
          rightRenderer = new CanvasRenderer(canvasGl, { ...common });
          rightLabel = 'canvas2d (self-check mirror)';
        } else if (webglError) {
          rightLabel = 'webgl (not built: ' + webglError.slice(0, 70) + ')';
        } else {
          try {
            rightRenderer = new WebGLRenderer(canvasGl, { ...common });
          } catch (e) {
            webglError = String(e && e.message ? e.message : e);
            rightLabel = 'webgl (init failed: ' + webglError.slice(0, 70) + ')';
          }
        }
        document.getElementById('gl-title').textContent = rightLabel;

        if (!rightRenderer) {
          window.__diff = () => ({ error: 'right pane unavailable', detail: webglError });
          setStatus('__diff() reports the unavailable pane');
          return;
        }

        window.__diff = makeDiff(canvasRef, canvasGl, () => refRenderer, () => rightRenderer, ghostty);
        setStatus(selfCheck ? 'self-check: expecting zero mismatch' : 'ready — call __diff()');
      }

      main().catch((e) => setStatus('fatal: ' + e));
