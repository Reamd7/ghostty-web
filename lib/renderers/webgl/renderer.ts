/**
 * WebGL2 renderer — implements the same public contract as CanvasRenderer.
 *
 * M1 scope (plan §M1): the rect pipeline — cell backgrounds with
 * run-length merging, selection, inverse handling, Unicode block-element
 * geometry, cursor, scrollbar — validated pixel-exact against the canvas
 * renderer by the demo/webgl-check.html loop (scene s1_bg must pass;
 * glyph scenes land with M2/M3).
 *
 * Frame shape mirrors the canvas renderer: beginFrame() (single WASM
 * crossing), shared viewport pool, per-row cell walk, clearDirty() after
 * a completed frame, aborted frames keep dirty state for retry.
 */

import { DEFAULT_THEME, IRenderable, IScrollbackProvider, RendererOptions } from '../../renderer';
import { FontMetrics, measureFontMetrics } from '../../font-metrics';
import type { ITheme } from '../../interfaces';
import type { SelectionManager } from '../../selection-manager';
import { CellFlags, GhosttyCell } from '../../types';
import { GLContext } from './context';
import { RectPass } from './rect-pass';

type LinkRange = { startX: number; startY: number; endX: number; endY: number };

/** #rrggbb → [r,g,b] floats 0..1 */
function hexToRgbFloat(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/**
 * Unicode block elements (U+2580..U+259F) render as exact cell geometry
 * instead of font glyphs. Ported one-to-one from CanvasRenderer's
 * renderBlockChar so both renderers paint identical rectangles.
 * Returns rect list in cell-relative pixels, or null for non-blocks.
 */
export function blockCharRects(
  codepoint: number,
  cellW: number,
  cellH: number
): Array<[number, number, number, number]> | null {
  const halfW = cellW / 2;
  const halfH = cellH / 2;
  const e = cellW / 8;
  switch (codepoint) {
    case 0x2580: return [[0, 0, cellW, halfH]];
    case 0x2581: return [[0, cellH - cellH / 8, cellW, cellH / 8]];
    case 0x2582: return [[0, cellH - cellH / 4, cellW, cellH / 4]];
    case 0x2583: return [[0, cellH - (cellH * 3) / 8, cellW, (cellH * 3) / 8]];
    case 0x2584: return [[0, halfH, cellW, halfH]];
    case 0x2585: return [[0, cellH - (cellH * 3) / 8, cellW, (cellH * 5) / 8]];
    case 0x2586: return [[0, cellH / 4, cellW, (cellH * 3) / 4]];
    case 0x2587: return [[0, cellH / 8, cellW, (cellH * 7) / 8]];
    case 0x2588: return [[0, 0, cellW, cellH]];
    case 0x2589: return [[0, 0, cellW - e, cellH]];
    case 0x258a: return [[0, 0, cellW - 2 * e, cellH]];
    case 0x258b: return [[0, 0, cellW - 3 * e, cellH]];
    case 0x258c: return [[0, 0, halfW, cellH]];
    case 0x258d: return [[0, 0, cellW - 5 * e, cellH]];
    case 0x258e: return [[0, 0, cellW - 6 * e, cellH]];
    case 0x258f: return [[0, 0, cellW - 7 * e, cellH]];
    case 0x2590: return [[halfW, 0, halfW, cellH]];
    case 0x2594: return [[0, 0, cellW, cellH / 8]];
    case 0x2595: return [[cellW - cellW / 8, 0, cellW / 8, cellH]];
    case 0x2596: return [[0, halfH, halfW, halfH]];
    case 0x2597: return [[halfW, halfH, halfW, halfH]];
    case 0x2598: return [[0, 0, halfW, halfH]];
    case 0x2599: return [[0, 0, halfW, cellH], [halfW, halfH, halfW, halfH]];
    case 0x259a: return [[0, 0, halfW, halfH], [halfW, halfH, halfW, halfH]];
    case 0x259b: return [[0, 0, cellW, halfH], [0, halfH, halfW, halfH]];
    case 0x259c: return [[0, 0, cellW, halfH], [halfW, halfH, halfW, halfH]];
    case 0x259d: return [[halfW, 0, halfW, halfH]];
    case 0x259e: return [[halfW, 0, halfW, halfH], [0, halfH, halfW, halfH]];
    case 0x259f: return [[halfW, 0, halfW, cellH], [0, halfH, halfW, halfH]];
    default: return null;
  }
}

export class WebGLRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: GLContext;
  private gl: WebGL2RenderingContext;
  private rectPass: RectPass;

  private fontSize: number;
  private fontFamily: string;
  private fontWeight?: number;
  private lineHeightMultiplier?: number;
  private cursorStyle: 'block' | 'underline' | 'bar';
  private cursorBlink: boolean;
  private theme: Required<ITheme>;
  private devicePixelRatio: number;
  private metrics: FontMetrics;

  private cursorVisible = true;
  private cursorBlinkInterval?: number;
  private lastViewportY = 0;

  private selectionManager?: SelectionManager;
  private currentSelectionCoords: {
    startCol: number;
    startRow: number;
    endCol: number;
    endRow: number;
  } | null = null;

  private hoveredHyperlinkId = 0;
  private hoveredLinkRange: LinkRange | null = null;

  public onRenderRequest: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    this.ctx = new GLContext(canvas);
    this.gl = this.ctx.gl;
    this.rectPass = new RectPass(this.ctx);

    this.fontSize = options.fontSize ?? 15;
    this.fontFamily = options.fontFamily ?? 'monospace';
    this.fontWeight = options.fontWeight;
    this.lineHeightMultiplier =
      typeof options.lineHeight === 'number' && options.lineHeight > 0
        ? options.lineHeight
        : undefined;
    this.cursorStyle = options.cursorStyle ?? 'block';
    this.cursorBlink = options.cursorBlink ?? false;
    this.theme = { ...DEFAULT_THEME, ...options.theme };
    this.devicePixelRatio = options.devicePixelRatio ?? window.devicePixelRatio ?? 1;

    this.metrics = measureFontMetrics({
      fontSize: this.fontSize,
      fontFamily: this.fontFamily,
      fontWeight: this.fontWeight,
      lineHeight: this.lineHeightMultiplier,
    });

    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);

    if (this.cursorBlink) this.startCursorBlink();
  }

  // ==========================================================================
  // Sizing
  // ==========================================================================

  public resize(cols: number, rows: number): void {
    const cssWidth = cols * this.metrics.width;
    const cssHeight = rows * this.metrics.height;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.canvas.width = Math.round(cssWidth * this.devicePixelRatio);
    this.canvas.height = Math.round(cssHeight * this.devicePixelRatio);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  // ==========================================================================
  // Frame
  // ==========================================================================

  public render(
    buffer: IRenderable,
    forceAll: boolean = false,
    viewportY: number = 0,
    scrollbackProvider?: IScrollbackProvider,
    scrollbarOpacity: number = 1
  ): void {
    buffer.beginFrame?.();
    try {
      this.renderFrame(buffer, forceAll, viewportY, scrollbackProvider, scrollbarOpacity);
    } finally {
      buffer.endFrame?.();
    }
  }

  private renderFrame(
    buffer: IRenderable,
    forceAll: boolean,
    viewportY: number,
    scrollbackProvider: IScrollbackProvider | undefined,
    scrollbarOpacity: number
  ): void {
    if (this.ctx.isLost) return; // rects rebuild on restore; next frame paints

    const cursor = buffer.getCursor();
    const dims = buffer.getDimensions();
    const scrollbackLength = scrollbackProvider ? scrollbackProvider.getScrollbackLength() : 0;
    const floorViewportY = Math.floor(viewportY);

    if (buffer.needsFullRedraw?.()) forceAll = true;

    const needsResize =
      this.canvas.width !== Math.round(dims.cols * this.metrics.width * this.devicePixelRatio) ||
      this.canvas.height !== Math.round(dims.rows * this.metrics.height * this.devicePixelRatio);
    if (needsResize) {
      this.resize(dims.cols, dims.rows);
      forceAll = true;
    }
    if (viewportY !== this.lastViewportY) {
      forceAll = true;
      this.lastViewportY = viewportY;
    }

    // M1 paints every frame from scratch (full-frame rect rebuild); dirty
    // tracking arrives with the glyph instance buffer in M3.
    forceAll = true;

    const pool = buffer.getViewportPool ? buffer.getViewportPool() : null;
    if (pool === null && viewportY === 0) return; // extraction failed: keep dirty, retry next frame

    this.currentSelectionCoords =
      this.selectionManager && this.selectionManager.hasSelection()
        ? this.selectionManager.getSelectionCoords()
        : null;

    this.rectPass.beginFrame();
    const bg = hexToRgbFloat(this.theme.background);
    this.gl.clearColor(bg[0], bg[1], bg[2], 1);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);

    const cols = dims.cols;
    for (let y = 0; y < dims.rows; y++) {
      let cells: GhosttyCell[] | null = null;
      let offset = 0;
      if (viewportY > 0 && y < viewportY && scrollbackProvider) {
        const line = scrollbackProvider.getScrollbackLine(scrollbackLength - floorViewportY + y);
        if (line) { cells = line; offset = 0; }
      } else if (viewportY > 0) {
        cells = pool;
        offset = (y - floorViewportY) * cols;
      } else {
        cells = pool;
        offset = y * cols;
      }
      if (!cells) continue;
      this.buildRowRects(cells, offset, y, cols);
    }

    this.rectPass.drawBackgrounds();

    // M3 draws glyphs here.

    this.buildCursorOverlay(cursor, pool, cols, viewportY);
    if (scrollbackProvider && scrollbarOpacity > 0) {
      this.buildScrollbar(viewportY, scrollbackLength, dims.rows, scrollbarOpacity);
    }
    this.rectPass.drawOverlays();

    this.selectionManager?.clearDirtySelectionRows();
    buffer.clearDirty();
  }

  /**
   * One row → merged background rects + block-element geometry rects.
   * Mirrors CanvasRenderer's two-pass contract: all backgrounds precede
   * all glyphs, so complex scripts can bleed across cell borders.
   */
  private buildRowRects(cells: GhosttyCell[], offset: number, y: number, cols: number): void {
    const cw = this.metrics.width;
    const ch = this.metrics.height;
    const rowY = y * ch;
    const end = Math.min(offset + cols, cells.length);

    // Run-length background pass.
    let runStart = -1;
    let runR = 0;
    let runG = 0;
    let runB = 0;
    const flushRun = (runEndX: number) => {
      if (runStart >= 0 && runEndX > runStart) {
        this.rectPass.backgrounds.add(
          runStart * cw, rowY, (runEndX - runStart) * cw, ch,
          runR / 255, runG / 255, runB / 255, 1
        );
      }
      runStart = -1;
    };

    for (let i = offset; i < end; i++) {
      const cell = cells[i];
      const x = i - offset;

      if (cell.width === 0) continue; // wide-char spacer keeps the base cell's background

      let r: number, g: number, b: number;
      const selected = this.isInSelection(x, y);
      if (selected) {
        [r, g, b] = this.selBg;
      } else {
        if (cell.flags & CellFlags.INVERSE) {
          r = cell.fg_r; g = cell.fg_g; b = cell.fg_b;
        } else {
          r = cell.bg_r; g = cell.bg_g; b = cell.bg_b;
        }
      }
      const isDefault = !selected && r === 0 && g === 0 && b === 0;

      if (isDefault) {
        flushRun(x);
      } else if (runStart >= 0 && r === runR && g === runG && b === runB) {
        // extend run
      } else {
        flushRun(x);
        runStart = x;
        runR = r; runG = g; runB = b;
      }
    }
    flushRun(cols);

    // Block elements: exact geometry in the resolved foreground color.
    for (let i = offset; i < end; i++) {
      const cell = cells[i];
      if (cell.width === 0 || (cell.flags & CellFlags.INVISIBLE)) continue;
      const x = i - offset;
      const rects = blockCharRects(cell.codepoint || 32, cw * cell.width, ch);
      if (!rects) continue;
      let [r, g, b] = this.isInSelection(x, y)
        ? this.selFg
        : cell.flags & CellFlags.INVERSE
          ? [cell.bg_r / 255, cell.bg_g / 255, cell.bg_b / 255]
          : [cell.fg_r / 255, cell.fg_g / 255, cell.fg_b / 255];
      for (const [rx, ry, rw, rh] of rects) {
        this.rectPass.backgrounds.add(
          x * cw + rx, rowY + ry, Math.max(0.5, rw), Math.max(0.5, rh),
          r, g, b, 1
        );
      }
    }
  }

  private buildCursorOverlay(
    cursor: { x: number; y: number; visible: boolean },
    pool: GhosttyCell[] | null,
    cols: number,
    viewportY: number
  ): void {
    if (viewportY !== 0 || !cursor.visible || !this.cursorVisible) return;
    const cw = this.metrics.width;
    const ch = this.metrics.height;
    const x = Math.min(cursor.x, cols - 1) * cw;
    const y = cursor.y * ch;
    const [r, g, b] = this.cursorColor;
    const o = this.rectPass.overlays;
    switch (this.cursorStyle) {
      case 'block':
        o.add(x, y, cw, ch, r, g, b, 1);
        break;
      case 'underline': {
        const h = Math.max(2, Math.floor(ch * 0.15));
        o.add(x, y + ch - h, cw, h, r, g, b, 1);
        break;
      }
      case 'bar': {
        const w = Math.max(2, Math.floor(cw * 0.15));
        o.add(x, y, w, ch, r, g, b, 1);
        break;
      }
    }
    void pool; // M3 re-draws the glyph under a block cursor with accent color
  }

  private buildScrollbar(
    viewportY: number,
    scrollbackLength: number,
    visibleRows: number,
    opacity: number
  ): void {
    if (opacity <= 0 || scrollbackLength === 0) return;
    const cssW = this.canvas.width / this.devicePixelRatio;
    const cssH = this.canvas.height / this.devicePixelRatio;
    const barW = 8;
    const barX = cssW - barW - 4;
    const pad = 4;
    const trackH = cssH - pad * 2;
    const total = scrollbackLength + visibleRows;
    const thumbH = Math.max(20, (visibleRows / total) * trackH);
    const pos = viewportY / scrollbackLength;
    const thumbY = pad + (trackH - thumbH) * (1 - pos);
    const gray = 128 / 255;
    const o = this.rectPass.overlays;
    o.add(barX, pad, barW, trackH, gray, gray, gray, 0.1 * opacity);
    const base = viewportY > 0 ? 0.5 : 0.3;
    o.add(barX, thumbY, barW, thumbH, gray, gray, gray, base * opacity);
  }

  // ==========================================================================
  // Selection / theme caches
  // ==========================================================================

  private selBg: [number, number, number] = [0.8, 0.8, 0.8];
  private selFg: [number, number, number] = [0.12, 0.12, 0.12];
  private cursorColor: [number, number, number] = [1, 1, 1];

  private isInSelection(x: number, y: number): boolean {
    const sel = this.currentSelectionCoords;
    if (!sel) return false;
    const { startCol, startRow, endCol, endRow } = sel;
    if (startRow === endRow) return y === startRow && x >= startCol && x <= endCol;
    if (y === startRow) return x >= startCol;
    if (y === endRow) return x <= endCol;
    if (y > startRow && y < endRow) return true;
    return false;
  }

  // ==========================================================================
  // Public API (contract parity with CanvasRenderer)
  // ==========================================================================

  public setTheme(theme: ITheme): void {
    this.theme = { ...DEFAULT_THEME, ...theme };
    this.selBg = hexToRgbFloat(this.theme.selectionBackground);
    this.selFg = hexToRgbFloat(this.theme.selectionForeground);
    this.cursorColor = hexToRgbFloat(this.theme.cursor);
  }

  public setFontSize(size: number): void {
    this.fontSize = size;
    this.remeasureFont();
  }

  public setFontFamily(family: string): void {
    this.fontFamily = family;
    this.remeasureFont();
  }

  public setCursorStyle(style: 'block' | 'underline' | 'bar'): void {
    this.cursorStyle = style;
  }

  public setCursorBlink(enabled: boolean): void {
    if (enabled && !this.cursorBlink) {
      this.cursorBlink = true;
      this.startCursorBlink();
    } else if (!enabled && this.cursorBlink) {
      this.cursorBlink = false;
      this.stopCursorBlink();
    }
  }

  public remeasureFont(): void {
    this.metrics = measureFontMetrics({
      fontSize: this.fontSize,
      fontFamily: this.fontFamily,
      fontWeight: this.fontWeight,
      lineHeight: this.lineHeightMultiplier,
    });
  }

  public getMetrics(): FontMetrics {
    return { ...this.metrics };
  }

  public getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  public setSelectionManager(manager: SelectionManager): void {
    this.selectionManager = manager;
  }

  public setHoveredHyperlinkId(hyperlinkId: number): void {
    this.hoveredHyperlinkId = hyperlinkId;
  }

  public setHoveredLinkRange(range: LinkRange | null): void {
    this.hoveredLinkRange = range;
  }

  public get charWidth(): number {
    return this.metrics.width;
  }

  public get charHeight(): number {
    return this.metrics.height;
  }

  public clear(): void {
    const bg = hexToRgbFloat(this.theme.background);
    this.gl.clearColor(bg[0], bg[1], bg[2], 1);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  public dispose(): void {
    this.stopCursorBlink();
    this.ctx.dispose();
  }

  // ==========================================================================
  // Cursor blinking (same timing contract as CanvasRenderer)
  // ==========================================================================

  private startCursorBlink(): void {
    this.cursorBlinkInterval = window.setInterval(() => this.toggleCursorBlink(), 530);
  }

  private stopCursorBlink(): void {
    if (this.cursorBlinkInterval !== undefined) {
      clearInterval(this.cursorBlinkInterval);
      this.cursorBlinkInterval = undefined;
    }
    this.cursorVisible = true;
  }

  toggleCursorBlink(): void {
    this.cursorVisible = !this.cursorVisible;
    this.onRenderRequest?.();
  }
}
