/**
 * Differential harness: xterm.js (@xterm/headless) vs ghostty-vt.
 *
 * For each scenario, feed identical bytes to both cores, drain xterm's
 * parser, then compare every cell's character + fg + bg + flags.
 * Colors are compared as resolved RGB: xterm via toCss-ish conversion of
 * its color number (palette + theme), ghostty via its per-cell RGB.
 * Flags: compare the union of {bold, italic, underline, strikethrough,
 * inverse, invisible, faint} mapped onto both sides' bit layouts.
 */

const COLS = 40;
const ROWS = 12;

const log = (t) => { document.getElementById('log').textContent += t + '\n'; };

// Basic xterm.js theme (256-color base palette starts the same).
const THEME = {
  foreground: '#cccccc',
  background: '#000000',
  // ghostty-vt's built-in xterm-standard palette (wasm-side resolved RGB)
  black: '#000000', red: '#cc6666', green: '#66cc66', yellow: '#cccc66',
  blue: '#6666cc', magenta: '#cc66cc', cyan: '#66cccc', white: '#cccccc',
  brightBlack: '#666666', brightRed: '#ff6666', brightGreen: '#66ff66',
  brightYellow: '#ffff66', brightBlue: '#6666ff', brightMagenta: '#ff66ff',
  brightCyan: '#66ffff', brightWhite: '#ffffff',
};

const SCENARIOS = {
  plain: 'hello differential world\r\nsecond line\r\nthird',
  sgr_styles:
    '\x1b[1mbold\x1b[0m \x1b[3mitalic\x1b[0m \x1b[4munderline\x1b[0m ' +
    '\x1b[9mstrike\x1b[0m \x1b[7minverse\x1b[0m \x1b[2mfaint\x1b[0m \x1b[8minvis\x1b[0m',
  sgr_colors:
    '\x1b[31mred\x1b[0m \x1b[42mongreen\x1b[0m \x1b[93mbrightYel\x1b[0m ' +
    '\x1b[38;5;208mfg256\x1b[0m \x1b[48;5;21mbg256\x1b[0m ' +
    '\x1b[38;2;10;200;30mfgTrue\x1b[0m \x1b[48;2;9;9;90mbgTrue\x1b[0m',
  cursor_moves:
    'line one\r\nline two\r\nline three' +
    '\x1b[2;5H' + 'X' + '\x1b[1;1H' + '\x1b[K',
  erase:
    'aaaaaaaaaa\r\nbbbbbbbbbb\r\ncccccccccc' +
    '\x1b[2;3X' + '\x1b[1;4P' + '\x1b[3L' + '\x1b[H\x1b[2Jtop-cleared',
  scroll_regions:
    Array.from({ length: 20 }, (_, i) => 'row-' + i).join('\r\n') +
    '\x1b[5;20r' + '\x1b[20;1H' + 'inside-region',
  wrap:
    'x'.repeat(COLS) + 'wrapped-char' + '\r\n' + 'y'.repeat(COLS + 5),
  tabs: 'a\tb\tc\td\r\n\x1b[3G|\t|',
  wide_cjk: '中文测试 mixed 英文',
  saved_cursor: 'AAA\x1b7BBB\x1b8CCC',
  line_ops:
    'one\r\ntwo\r\nthree\r\nfour' + '\x1b[1;1H' + '\x1b[2M' + '\r\nafter-delete',
};

// Flag bit mapping: {name: [xtermAttributeCheck, ghosttyFlag]}
function ghosttyFlags(cell) {
  return {
    bold: !!(cell.flags & 1),
    italic: !!(cell.flags & 2),
    underline: !!(cell.flags & 4),
    strikethrough: !!(cell.flags & 8),
    inverse: !!(cell.flags & 16),
    invisible: !!(cell.flags & 32),
    faint: !!(cell.flags & 128),
  };
}

function xtermFlags(cell) {
  // xterm.js IBufferCell: isBold()/isItalic()/isUnderline()/isStrikethrough()/
  // isInverse()/isInvisible()/isDim()
  return {
    bold: !!cell.isBold(),
    italic: !!cell.isItalic(),
    underline: !!cell.isUnderline(),
    strikethrough: !!cell.isStrikethrough(),
    inverse: !!cell.isInverse(),
    invisible: !!cell.isInvisible(),
    faint: !!cell.isDim(),
  };
}

function xtermColorRgb(cell, kind, theme) {
  // kind: 'fg' | 'bg'. Returns [r,g,b] or null for default.
  const isFg = kind === 'fg';
  const isDefault = isFg ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return null;
  if (isFg ? cell.isFgRGB() : cell.isBgRGB()) {
    // RGB stored as 24-bit color number
    const n = isFg ? cell.getFgColor() : cell.getBgColor();
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  // Palette index (16 base + 240 extended). Base 16 from theme.
  const n = isFg ? cell.getFgColor() : cell.getBgColor();
  if (n < 16) {
    const hex = [
      theme.black, theme.red, theme.green, theme.yellow,
      theme.blue, theme.magenta, theme.cyan, theme.white,
      theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow,
      theme.brightBlue, theme.brightMagenta, theme.brightCyan, theme.brightWhite,
    ][n];
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  // 256-color cube/grayscale formula (xterm standard)
  if (n < 232) {
    const c = n - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    const r = steps[Math.floor(c / 36)];
    const g = steps[Math.floor((c % 36) / 6)];
    const b = steps[c % 6];
    return [r, g, b];
  }
  const gray = 8 + (n - 232) * 10;
  return [gray, gray, gray];
}

async function main() {
  const { Ghostty } = await import('../lib/ghostty.ts');
  const ghostty = await Ghostty.load();
  const { Terminal: XTerm } = await import('@xterm/headless');

  window.__runDiff = async () => {
    // Palette sync: ghostty-vt resolves SGR colors through its built-in
    // theme (Tomorrow-style), not the VT-standard palette. Extract the
    // actual 16 colors from ghostty cells and inject them as xterm's
    // theme so palette-index comparisons compare like for like.
    {
      const t = ghostty.createTerminal(16, 2);
      let bytes = '';
      for (let i = 0; i < 16; i++) bytes += `\x1b[${i < 8 ? 40 + i : 10 + i}m \x1b[0m`;
      t.write(bytes);
      t.update();
      const pool = t.getViewportPool();
      const keys = [
        'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
        'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
        'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
      ];
      for (let i = 0; i < 16; i++) {
        const c = pool[i];
        const hex = '#' + [c.bg_r, c.bg_g, c.bg_b].map((v) => v.toString(16).padStart(2, '0')).join('');
        THEME[keys[i]] = hex;
      }
    }

    const report = [];
    for (const [name, data] of Object.entries(SCENARIOS)) {
      // --- xterm side ---
      const xterm = new XTerm({ cols: COLS, rows: ROWS, theme: THEME, scrollback: 0, allowProposedApi: true });
      xterm.write(data);
      // Drain: headless write is sync after the callback; give it a tick.
      await new Promise((r) => setTimeout(r, 20));

      // --- ghostty side ---
      const term = ghostty.createTerminal(COLS, ROWS);
      term.write(data);
      term.update();

      const pool = term.getViewportPool();
      const diffs = [];
      let cellCount = 0;
      let mismatchCount = 0;

      const xbuf = xterm.buffer.active;
      for (let y = 0; y < ROWS; y++) {
        const xline = xbuf.getLine(y);
        for (let x = 0; x < COLS; x++) {
          const xc = xline?.getCell(x);
          if (!xc) continue;
          const gc = pool ? pool[y * COLS + x] : null;
          if (!gc) continue;
          cellCount++;

          const xch = xc.getChars() || '';
          const gch =
            gc.grapheme_len > 0 && term.getGraphemeString
              ? term.getGraphemeString(y, x)
              : gc.codepoint > 0
                ? String.fromCodePoint(gc.codepoint)
                : '';
          const sameChar = xch === gch || (xch === '' && gch === '');

          const xfg = xtermColorRgb(xc, 'fg', THEME);
          const xbg = xtermColorRgb(xc, 'bg', THEME);
          const gf = ghosttyFlags(gc);
          const xf = xtermFlags(xc);
          const sameFlags = Object.keys(gf).every((k) => gf[k] === xf[k]);

          // Color: ghostty resolves defaults to actual RGB (fg 212/212/212
          // bg 30/30/30 in this fork's default theme per DEFAULT_THEME).
          // ghostty-vt cell defaults: fg 204/204/204, bg 0/0/0. The
          // canvas renderer maps these to theme colors at paint time;
          // the differential compares cell-level state, so both cores
          // must see the same defaults.
          const GHOSTTY_DEFAULT_FG = [204, 204, 204];
          const GHOSTTY_DEFAULT_BG = [0, 0, 0];
          const gfg = [gc.fg_r, gc.fg_g, gc.fg_b];
          const gbg = [gc.bg_r, gc.bg_g, gc.bg_b];
          const norm = (c, dflt) => (c === null ? dflt : c);
          const sameFg = arrayEq(norm(xfg, GHOSTTY_DEFAULT_FG), gfg);
          const sameBg = arrayEq(norm(xbg, GHOSTTY_DEFAULT_BG), gbg);

          if (!sameChar || !sameFlags || !sameFg || !sameBg) {
            mismatchCount++;
            if (diffs.length < 8) {
              diffs.push({
                x: y * COLS + x,
                pos: `(${x},${y})`,
                char: [JSON.stringify(xch), JSON.stringify(gch)],
                flags: !sameFlags ? [xf, gf] : undefined,
                fg: !sameFg ? [xfg, gfg] : undefined,
                bg: !sameBg ? [xbg, gbg] : undefined,
              });
            }
          }
        }
      }
      xterm.dispose();
      report.push({
        scenario: name,
        cells: cellCount,
        mismatch: mismatchCount,
        mismatchPct: cellCount ? +((mismatchCount / cellCount) * 100).toFixed(2) : 0,
        sample: diffs,
      });
    }
    return report;
  };

  log('ready — call __runDiff()');
}

function arrayEq(a, b) {
  if (!a || !b) return a === b;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

main().catch((e) => log('fatal: ' + e));
