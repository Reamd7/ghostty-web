/**
 * Canvas Renderer for Terminal Display
 *
 * High-performance canvas-based renderer that draws the terminal using
 * Ghostty's WASM terminal emulator. Features:
 * - Font metrics measurement with DPI scaling
 * - Full color support (256-color palette + RGB)
 * - All text styles (bold, italic, underline, strikethrough, etc.)
 * - Multiple cursor styles (block, underline, bar)
 * - Dirty-line rendering driven by on-demand frames: one viewport
 *   extraction per frame, no per-row copies
 */

import type { ITheme } from './interfaces';
import { getTerminalPerfCounters } from './perf-counters';
import { measureFontMetrics } from './font-metrics';
export type { FontMetrics } from './font-metrics';
import { CellFlags, DirtyState } from './types';

// Interface for objects that can be rendered
export interface IRenderable {
  getLine(y: number): GhosttyCell[] | null;
  getCursor(): { x: number; y: number; visible: boolean };
  getDimensions(): { cols: number; rows: number };
  isRowDirty(y: number): boolean;
  /** Returns true if a full redraw is needed (e.g., screen change) */
  needsFullRedraw?(): boolean;
  /**
   * Render-frame fast path. beginFrame() performs at most one WASM update()
   * and caches it for the whole synchronous transaction; every update()/
   * getCursor()/needsFullRedraw() call between begin/end shares that call.
   */
  beginFrame?(): number; // DirtyState
  endFrame?(): void;
  /**
   * In-frame shared viewport pool (read rows as pool[y * cols + x]). Valid
   * only until the next viewport extraction. Returns null on extraction
   * failure — the renderer then aborts without clearing dirty state.
   */
  getViewportPool?(): GhosttyCell[] | null;
  clearDirty(): void;
  /**
   * Get the full grapheme string for a cell at (row, col).
   * For cells with grapheme_len > 0, this returns all codepoints combined.
   * For simple cells, returns the single character.
   */
  getGraphemeString?(row: number, col: number): string;
}

export interface IScrollbackProvider {
  getScrollbackLine(offset: number): GhosttyCell[] | null;
  getScrollbackLength(): number;
}

// ============================================================================
// Type Definitions
// ============================================================================

export interface RendererOptions {
  fontSize?: number; // Default: 15
  fontFamily?: string; // Default: 'monospace'
  /**
   * CSS font weight for regular text (e.g. 300 for the crisp light look
   * terminals like Orca use). Default: normal (400, current behavior).
   */
  fontWeight?: number;
  /** CSS font weight for SGR-bold text. Default: bold (700, current behavior). */
  fontWeightBold?: number;
  /**
   * Cell height multiplier applied to (ascent + descent). Overrides the
   * legacy "+2px" padding when set (e.g. 1.2 for Orca-like breathing room).
   */
  lineHeight?: number;
  cursorStyle?: 'block' | 'underline' | 'bar'; // Default: 'block'
  cursorBlink?: boolean; // Default: false
  theme?: ITheme;
  devicePixelRatio?: number; // Default: window.devicePixelRatio
}

import type { FontMetrics } from './font-metrics';
// ============================================================================
// Default Theme
// ============================================================================

export const DEFAULT_THEME: Required<ITheme> = {
  foreground: '#d4d4d4',
  background: '#1e1e1e',
  cursor: '#ffffff',
  cursorAccent: '#1e1e1e',
  // Selection colors: solid colors that replace cell bg/fg when selected
  // Using Ghostty's approach: selection bg = default fg, selection fg = default bg
  selectionBackground: '#d4d4d4',
  selectionForeground: '#1e1e1e',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

type LinkRange = { startX: number; startY: number; endX: number; endY: number };

/** Field-wise null-safe link-range equality (replaces JSON.stringify compares). */
function linkRangesEqual(a: LinkRange | null, b: LinkRange | null): boolean {
  if (a === b) return true; // both null, or the identical object
  if (!a || !b) return false;
  return a.startX === b.startX && a.startY === b.startY && a.endX === b.endX && a.endY === b.endY;
}

/**
 * Whether any cell in cells[offset .. offset+count) carries either hyperlink
 * id. Reads the shared pool or a scrollback row in place — no row slice.
 */
function rowContainsHyperlink(
  cells: GhosttyCell[],
  offset: number,
  count: number,
  currentId: number,
  previousId: number
): boolean {
  const end = Math.min(offset + count, cells.length);
  for (let i = offset; i < end; i++) {
    const id = cells[i].hyperlink_id;
    if (id === currentId || id === previousId) return true;
  }
  return false;
}

// ============================================================================
// CanvasRenderer Class
// ============================================================================

export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private fontSize: number;
  private fontFamily: string;
  private fontWeight?: number;
  private fontWeightBold?: number;
  private lineHeightMultiplier?: number;
  private cursorStyle: 'block' | 'underline' | 'bar';
  private cursorBlink: boolean;
  private theme: Required<ITheme>;
  private devicePixelRatio: number;
  private metrics: FontMetrics;
  private palette: string[];

  // Cursor blinking state
  private cursorVisible: boolean = true;
  private cursorBlinkInterval?: number;
  private lastCursorPosition: { x: number; y: number } = { x: 0, y: 0 };

  // Viewport tracking (for scrolling)
  private lastViewportY: number = 0;

  // Current buffer being rendered (for grapheme lookups)
  private currentBuffer: IRenderable | null = null;

  // Selection manager (for rendering selection)
  private selectionManager?: SelectionManager;
  // Cached selection coordinates for current render pass (viewport-relative)
  private currentSelectionCoords: {
    startCol: number;
    startRow: number;
    endCol: number;
    endRow: number;
  } | null = null;

  // Link rendering state
  private hoveredHyperlinkId: number = 0;
  private previousHoveredHyperlinkId: number = 0;

  // Regex link hover tracking (for links without hyperlink_id)
  private hoveredLinkRange: { startX: number; startY: number; endX: number; endY: number } | null =
    null;
  private previousHoveredLinkRange: {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null = null;

  /**
   * Repaint request hook for state changes that originate inside the
   * renderer (cursor blink toggle, blink-stop cursor restore). Wired by
   * Terminal to its on-demand render scheduler.
   */
  public onRenderRequest: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      throw new Error('Failed to get 2D rendering context');
    }
    this.ctx = ctx;

    // Apply options
    this.fontSize = options.fontSize ?? 15;
    this.fontFamily = options.fontFamily ?? 'monospace';
    this.fontWeight = options.fontWeight;
    this.fontWeightBold = options.fontWeightBold;
    this.lineHeightMultiplier =
      typeof options.lineHeight === 'number' && options.lineHeight > 0
        ? options.lineHeight
        : undefined;
    this.cursorStyle = options.cursorStyle ?? 'block';
    this.cursorBlink = options.cursorBlink ?? false;
    this.theme = { ...DEFAULT_THEME, ...options.theme };
    this.devicePixelRatio = options.devicePixelRatio ?? window.devicePixelRatio ?? 1;
    // Build color palette (16 ANSI colors)
    this.palette = [
      this.theme.black,
      this.theme.red,
      this.theme.green,
      this.theme.yellow,
      this.theme.blue,
      this.theme.magenta,
      this.theme.cyan,
      this.theme.white,
      this.theme.brightBlack,
      this.theme.brightRed,
      this.theme.brightGreen,
      this.theme.brightYellow,
      this.theme.brightBlue,
      this.theme.brightMagenta,
      this.theme.brightCyan,
      this.theme.brightWhite,
    ];

    // Measure font metrics
    this.metrics = this.measureFont();

    // Setup cursor blinking if enabled
    if (this.cursorBlink) {
      this.startCursorBlink();
    }
  }

  // ==========================================================================
  // Font Metrics Measurement
  // ==========================================================================

  private measureFont(): FontMetrics {
    // Delegates to the shared implementation so Canvas and WebGL renderers
    // derive identical geometry from identical options.
    return measureFontMetrics({
      fontSize: this.fontSize,
      fontFamily: this.fontFamily,
      fontWeight: this.fontWeight,
      lineHeight: this.lineHeightMultiplier,
    });
  }

  /**
   * Remeasure font metrics (call after font loads or changes)
   */
  public remeasureFont(): void {
    this.metrics = this.measureFont();
  }

  // ==========================================================================
  // Color Conversion
  // ==========================================================================

  private rgbToCSS(r: number, g: number, b: number): string {
    return `rgb(${r}, ${g}, ${b})`;
  }

  // ==========================================================================
  // Canvas Sizing
  // ==========================================================================

  /**
   * Resize canvas to fit terminal dimensions
   */
  public resize(cols: number, rows: number): void {
    const cssWidth = cols * this.metrics.width;
    const cssHeight = rows * this.metrics.height;

    // Set CSS size (what user sees)
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    // Set actual canvas size (scaled for DPI)
    this.canvas.width = cssWidth * this.devicePixelRatio;
    this.canvas.height = cssHeight * this.devicePixelRatio;

    // Scale context to match DPI (setting canvas.width/height resets the context)
    this.ctx.scale(this.devicePixelRatio, this.devicePixelRatio);

    // Set text rendering properties for crisp text
    this.ctx.textBaseline = 'alphabetic';
    this.ctx.textAlign = 'left';

    // Fill background after resize
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, cssWidth, cssHeight);
  }

  // ==========================================================================
  // Main Rendering
  // ==========================================================================

  /**
   * Render the terminal buffer to canvas
   */
  public render(
    buffer: IRenderable,
    forceAll: boolean = false,
    viewportY: number = 0,
    scrollbackProvider?: IScrollbackProvider,
    scrollbarOpacity: number = 1
  ): void {
    // Store buffer reference for grapheme lookups in renderCell
    this.currentBuffer = buffer;

    // One WASM update() per transaction: beginFrame() caches the dirty state
    // shared by every update()/getCursor()/needsFullRedraw() call inside.
    buffer.beginFrame?.();
    try {
      this.renderFrame(buffer, forceAll, viewportY, scrollbackProvider, scrollbarOpacity);
    } finally {
      buffer.endFrame?.();
    }
  }

  /**
   * One render frame.
   *
   * Screen rows are read from a single shared viewport pool (fetched lazily,
   * at most once per frame) instead of per-row getLine() copies. Scrollback
   * rows still come from the scrollback provider — they are not part of the
   * active-screen pool.
   *
   * If the viewport pool cannot be fetched, the frame aborts WITHOUT
   * clearing dirty state so the next frame retries instead of silently
   * dropping the update.
   */
  private renderFrame(
    buffer: IRenderable,
    forceAll: boolean,
    viewportY: number,
    scrollbackProvider: IScrollbackProvider | undefined,
    scrollbarOpacity: number
  ): void {
    const frameDirty = buffer.beginFrame?.();
    const cursor = buffer.getCursor();
    const dims = buffer.getDimensions();
    const scrollbackLength = scrollbackProvider ? scrollbackProvider.getScrollbackLength() : 0;
    const floorViewportY = Math.floor(viewportY);

    // Lazily-fetched shared viewport pool. `failed` is sticky for the frame:
    // once extraction fails, every subsequent consumer aborts the frame.
    let pool: GhosttyCell[] | null = null;
    let poolReady = false;
    let poolFailed = false;
    let poolFetched = false;
    const ensurePool = (): boolean => {
      if (!poolFetched) {
        poolFetched = true;
        if (buffer.getViewportPool) {
          pool = buffer.getViewportPool();
          poolReady = pool !== null;
          poolFailed = pool === null;
        }
      }
      return !poolFailed;
    };

    /** Paint screen row `y` from the shared pool (legacy getLine() fallback for buffers without pool support). Returns false on pool failure. */
    const drawScreenRow = (y: number): boolean => {
      if (!ensurePool()) return false;
      if (poolReady && pool) {
        this.renderRowCells(pool, y * dims.cols, y, dims.cols);
      } else {
        const line = buffer.getLine(y);
        if (line) this.renderRowCells(line, 0, y, dims.cols);
      }
      return true;
    };

    // Check if buffer needs full redraw (e.g., screen change between normal/alternate)
    if (buffer.needsFullRedraw?.()) {
      forceAll = true;
    }

    // Resize canvas if dimensions changed
    const needsResize =
      this.canvas.width !== dims.cols * this.metrics.width * this.devicePixelRatio ||
      this.canvas.height !== dims.rows * this.metrics.height * this.devicePixelRatio;

    if (needsResize) {
      this.resize(dims.cols, dims.rows);
      forceAll = true; // Force full render after resize
    }

    // Force re-render when viewport changes (scrolling)
    if (viewportY !== this.lastViewportY) {
      forceAll = true;
      this.lastViewportY = viewportY;
    }

    // Check if cursor position changed or if blinking (need to redraw cursor line)
    const cursorMoved =
      cursor.x !== this.lastCursorPosition.x || cursor.y !== this.lastCursorPosition.y;
    if (cursorMoved || this.cursorBlink) {
      // Mark cursor lines as needing redraw
      if (!forceAll && !buffer.isRowDirty(cursor.y)) {
        // Need to redraw cursor line
        if (!drawScreenRow(cursor.y)) return;
      }
      if (cursorMoved && this.lastCursorPosition.y !== cursor.y) {
        // Also redraw old cursor line if cursor moved to different line
        if (!forceAll && !buffer.isRowDirty(this.lastCursorPosition.y)) {
          if (!drawScreenRow(this.lastCursorPosition.y)) return;
        }
      }
    }

    // Check if we need to redraw selection-related lines
    const hasSelection = this.selectionManager && this.selectionManager.hasSelection();
    const selectionRows = new Set<number>();

    // Cache selection coordinates for use during cell rendering
    // This is used by isInSelection() to determine if a cell needs selection colors
    this.currentSelectionCoords = hasSelection ? this.selectionManager!.getSelectionCoords() : null;

    // Mark current selection rows for redraw (includes programmatic selections)
    if (this.currentSelectionCoords) {
      const coords = this.currentSelectionCoords;
      for (let row = coords.startRow; row <= coords.endRow; row++) {
        selectionRows.add(row);
      }
    }

    // Always mark dirty selection rows for redraw (to clear old overlay).
    // Kept until the frame actually paints so an aborted frame retries.
    let hasPendingDirtySelectionRows = false;
    if (this.selectionManager) {
      const dirtyRows = this.selectionManager.getDirtySelectionRows();
      if (dirtyRows.size > 0) {
        hasPendingDirtySelectionRows = true;
        for (const row of dirtyRows) {
          selectionRows.add(row);
        }
      }
    }

    // Track rows with hyperlinks that need redraw when hover changes
    const hyperlinkRows = new Set<number>();
    const hyperlinkChanged = this.hoveredHyperlinkId !== this.previousHoveredHyperlinkId;
    const linkRangeChanged = !linkRangesEqual(this.hoveredLinkRange, this.previousHoveredLinkRange);

    if (hyperlinkChanged) {
      // Find rows containing the old or new hovered hyperlink
      // Must check the correct buffer based on viewportY (scrollback vs screen)
      if (!ensurePool()) return;
      for (let y = 0; y < dims.rows; y++) {
        // Same logic as rendering: fetch from scrollback or screen
        if (viewportY > 0 && y < viewportY && scrollbackProvider) {
          // This row is from scrollback
          const scrollbackOffset = scrollbackLength - floorViewportY + y;
          const line = scrollbackProvider.getScrollbackLine(scrollbackOffset);
          if (
            line &&
            rowContainsHyperlink(
              line,
              0,
              line.length,
              this.hoveredHyperlinkId,
              this.previousHoveredHyperlinkId
            )
          ) {
            hyperlinkRows.add(y);
          }
        } else {
          // This row is from visible screen
          const screenRow = viewportY > 0 ? y - floorViewportY : y;
          if (poolReady && pool) {
            const base = screenRow * dims.cols;
            if (
              rowContainsHyperlink(
                pool,
                base,
                dims.cols,
                this.hoveredHyperlinkId,
                this.previousHoveredHyperlinkId
              )
            ) {
              hyperlinkRows.add(y);
            }
          } else {
            const line = buffer.getLine(screenRow);
            if (
              line &&
              rowContainsHyperlink(
                line,
                0,
                line.length,
                this.hoveredHyperlinkId,
                this.previousHoveredHyperlinkId
              )
            ) {
              hyperlinkRows.add(y);
            }
          }
        }
      }
    }

    // Track rows affected by link range changes (for regex URLs): rows from
    // both the old and new ranges must repaint so the underline moves.
    if (linkRangeChanged) {
      if (this.previousHoveredLinkRange) {
        for (
          let y = this.previousHoveredLinkRange.startY;
          y <= this.previousHoveredLinkRange.endY;
          y++
        ) {
          hyperlinkRows.add(y);
        }
      }
      if (this.hoveredLinkRange) {
        for (let y = this.hoveredLinkRange.startY; y <= this.hoveredLinkRange.endY; y++) {
          hyperlinkRows.add(y);
        }
      }
    }
    // Nothing dirty, nothing moved, nothing to overlay: skip the frame
    // entirely (no viewport fetch, no per-row dirty queries, no clearDirty).
    if (
      frameDirty === DirtyState.NONE &&
      !forceAll &&
      !cursorMoved &&
      !this.cursorBlink &&
      selectionRows.size === 0 &&
      hyperlinkRows.size === 0 &&
      !(scrollbackProvider && scrollbarOpacity > 0)
    ) {
      return;
    }

    // Determine which rows need rendering.
    // We also include adjacent rows (above and below) for each dirty row to handle
    // glyph overflow - tall glyphs like Devanagari vowel signs can extend into
    // adjacent rows' visual space.
    const rowsToRender = new Set<number>();
    for (let y = 0; y < dims.rows; y++) {
      // When scrolled, always force render all lines since we're showing scrollback
      const needsRender =
        viewportY > 0
          ? true
          : frameDirty === DirtyState.NONE
            ? selectionRows.has(y) || hyperlinkRows.has(y)
            : forceAll || buffer.isRowDirty(y) || selectionRows.has(y) || hyperlinkRows.has(y);

      if (needsRender) {
        rowsToRender.add(y);
        // Include adjacent rows to handle glyph overflow
        if (y > 0) rowsToRender.add(y - 1);
        if (y < dims.rows - 1) rowsToRender.add(y + 1);
      }
    }

    // Render each line
    for (let y = 0; y < dims.rows; y++) {
      if (!rowsToRender.has(y)) {
        continue;
      }

      // Fetch line from scrollback or visible screen
      if (viewportY > 0 && y < viewportY && scrollbackProvider) {
        // This row is from scrollback (upper part of viewport).
        // Get from end of scrollback buffer (floor handles fractional smooth scroll)
        const scrollbackOffset = scrollbackLength - floorViewportY + y;
        const line = scrollbackProvider.getScrollbackLine(scrollbackOffset);
        if (line) {
          this.renderRowCells(line, 0, y, dims.cols);
        }
      } else if (viewportY > 0) {
        // This row is from visible screen (lower part of viewport)
        if (!drawScreenRow(y - floorViewportY)) return;
      } else {
        // At bottom - fetch from visible screen
        if (!drawScreenRow(y)) return;
      }
    }

    // Selection highlighting is now integrated into renderCellBackground/renderCellText
    // No separate overlay pass needed - this fixes z-order issues with complex glyphs

    // Link underlines are drawn during cell rendering (see renderCell)

    // Render cursor (only if we're at the bottom, not scrolled)
    if (viewportY === 0 && cursor.visible && this.cursorVisible) {
      if (!ensurePool()) return;
      this.renderCursor(buffer, poolReady && pool ? pool : null, cursor.x, cursor.y, dims.cols);
    }

    // Render scrollbar if scrolled or scrollback exists (with opacity for fade effect)
    if (scrollbackProvider && scrollbarOpacity > 0) {
      this.renderScrollbar(viewportY, scrollbackLength, dims.rows, scrollbarOpacity);
    }

    // Update last cursor position
    this.lastCursorPosition = { x: cursor.x, y: cursor.y };

    // Previous-hover state is only committed after the rows it affects have
    // been painted, so an aborted frame rescans them on the next attempt.
    if (hyperlinkChanged) {
      this.previousHoveredHyperlinkId = this.hoveredHyperlinkId;
    }
    if (linkRangeChanged) {
      this.previousHoveredLinkRange = this.hoveredLinkRange;
    }
    if (hasPendingDirtySelectionRows) {
      this.selectionManager?.clearDirtySelectionRows();
    }

    // ALWAYS clear dirty flags after rendering, regardless of forceAll.
    // This is critical - if we don't clear after a full redraw, the dirty
    // state persists and the next frame might not detect new changes properly.
    buffer.clearDirty();
  }

  /**
   * Render a row of cells using two-pass approach:
   * 1. First pass: Draw all cell backgrounds
   * 2. Second pass: Draw all cell text and decorations
   *
   * This two-pass approach is necessary for proper rendering of complex scripts
   * like Devanagari where diacritics (like the vowel sign ि) can extend LEFT of
   * the base character into the previous cell's visual area. If we draw
   * backgrounds and text in a single pass (cell by cell), the background of
   * cell N would cover any left-extending portions of graphemes from cell N-1.
   *
   * The row is addressed as cells[offset + x] so callers can paint straight
   * out of the shared viewport pool (or a scrollback row array) without
   * creating a per-row slice.
   */
  private renderRowCells(cells: GhosttyCell[], offset: number, y: number, cols: number): void {
    const lineY = y * this.metrics.height;
    const lineWidth = cols * this.metrics.width;

    // Clear line background then fill with theme color.
    // We clear just the cell area - glyph overflow is handled by also
    // redrawing adjacent rows (see renderFrame()).
    // clearRect is needed because fillRect composites rather than replaces,
    // so transparent/translucent backgrounds wouldn't clear previous content.
    this.ctx.clearRect(0, lineY, lineWidth, this.metrics.height);
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, lineY, lineWidth, this.metrics.height);

    const end = Math.min(offset + cols, cells.length);

    // PASS 1: Draw all cell backgrounds first
    // This ensures all backgrounds are painted before any text, allowing text
    // to "bleed" across cell boundaries without being covered by adjacent backgrounds
    for (let i = offset; i < end; i++) {
      const cell = cells[i];
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.renderCellBackground(cell, i - offset, y);
    }

    // PASS 2: Draw all cell text and decorations
    // Now text can safely extend beyond cell boundaries (for complex scripts)
    for (let i = offset; i < end; i++) {
      const cell = cells[i];
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.renderCellText(cell, i - offset, y);
    }

    const c = getTerminalPerfCounters();
    if (c) c.renderedRows++;
  }
  /**
   * Render a cell's background only (Pass 1 of two-pass rendering)
   * Selection highlighting is integrated here to avoid z-order issues with
   * complex glyphs (like Devanagari) that extend outside their cell bounds.
   */
  private renderCellBackground(cell: GhosttyCell, x: number, y: number): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Check if this cell is selected
    const isSelected = this.isInSelection(x, y);

    if (isSelected) {
      // Draw selection background (solid color, not overlay)
      this.ctx.fillStyle = this.theme.selectionBackground;
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
      return; // Selection background replaces cell background
    }

    // Extract background color and handle inverse
    let bg_r = cell.bg_r,
      bg_g = cell.bg_g,
      bg_b = cell.bg_b;

    if (cell.flags & CellFlags.INVERSE) {
      // When inverted, background becomes foreground
      bg_r = cell.fg_r;
      bg_g = cell.fg_g;
      bg_b = cell.fg_b;
    }

    // Only draw cell background if it's different from the default (black)
    // This lets the theme background (drawn earlier) show through for default cells
    const isDefaultBg = bg_r === 0 && bg_g === 0 && bg_b === 0;
    if (!isDefaultBg) {
      this.ctx.fillStyle = this.rgbToCSS(bg_r, bg_g, bg_b);
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
    }
  }

  /**
   * Render a cell's text and decorations (Pass 2 of two-pass rendering)
   * Selection foreground color is applied here to match the selection background.
   */
  private renderCellText(cell: GhosttyCell, x: number, y: number, colorOverride?: string): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Skip rendering if invisible
    if (cell.flags & CellFlags.INVISIBLE) {
      return;
    }

    // Check if this cell is selected
    const isSelected = this.isInSelection(x, y);

    // Set text color - use override, selection foreground, or normal color
    if (colorOverride) {
      this.ctx.fillStyle = colorOverride;
    } else if (isSelected) {
      this.ctx.fillStyle = this.theme.selectionForeground;
    } else {
      // Extract colors and handle inverse
      let fg_r = cell.fg_r,
        fg_g = cell.fg_g,
        fg_b = cell.fg_b;

      if (cell.flags & CellFlags.INVERSE) {
        // When inverted, foreground becomes background
        fg_r = cell.bg_r;
        fg_g = cell.bg_g;
        fg_b = cell.bg_b;
      }

      this.ctx.fillStyle = this.rgbToCSS(fg_r, fg_g, fg_b);
    }

    // Apply faint effect
    if (cell.flags & CellFlags.FAINT) {
      this.ctx.globalAlpha = 0.5;
    }

    // Set text style; weights follow the configured options and fall back to
    // the legacy 'bold' keyword / default weight when unset.
    let fontStyle = '';
    if (cell.flags & CellFlags.ITALIC) fontStyle += 'italic ';
    if (cell.flags & CellFlags.BOLD) fontStyle += `${this.fontWeightBold ?? 'bold'} `;
    else if (this.fontWeight !== undefined) fontStyle += `${this.fontWeight} `;
    this.ctx.font = `${fontStyle}${this.fontSize}px ${this.fontFamily}`;
    // Draw text
    const textX = cellX;
    const textY = cellY + this.metrics.baseline;

    // Get the character to render - use grapheme lookup for complex scripts
    let char: string;
    if (cell.grapheme_len > 0 && this.currentBuffer?.getGraphemeString) {
      // Cell has additional codepoints - get full grapheme cluster
      char = this.currentBuffer.getGraphemeString(y, x);
    } else {
      // Simple cell - single codepoint. Guard invalid and surrogate codepoints
      // (they would throw fromCodePoint or draw mojibake).
      const cp = cell.codepoint;
      char =
        cp == null || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)
          ? ' '
          : String.fromCodePoint(cp);
    }
    // Block elements render as exact cell geometry (fonts rarely ship correct
    // glyphs/vertical metrics for U+2580..U+259F, breaking TUI rules and bars).
    if (!this.renderBlockChar(cell.codepoint || 32, cellX, cellY, cellWidth)) {
      this.ctx.fillText(char, textX, textY);
    }

    // Reset alpha
    if (cell.flags & CellFlags.FAINT) {
      this.ctx.globalAlpha = 1.0;
    }

    // Draw underline
    if (cell.flags & CellFlags.UNDERLINE) {
      const underlineY = cellY + this.metrics.baseline + 2;
      this.ctx.strokeStyle = this.ctx.fillStyle;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, underlineY);
      this.ctx.lineTo(cellX + cellWidth, underlineY);
      this.ctx.stroke();
    }

    // Draw strikethrough
    if (cell.flags & CellFlags.STRIKETHROUGH) {
      const strikeY = cellY + this.metrics.height / 2;
      this.ctx.strokeStyle = this.ctx.fillStyle;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, strikeY);
      this.ctx.lineTo(cellX + cellWidth, strikeY);
      this.ctx.stroke();
    }

    // Draw hyperlink underline (for OSC8 hyperlinks)
    if (cell.hyperlink_id > 0) {
      const isHovered = cell.hyperlink_id === this.hoveredHyperlinkId;

      // Only show underline when hovered (cleaner look)
      if (isHovered) {
        const underlineY = cellY + this.metrics.baseline + 2;
        this.ctx.strokeStyle = '#4A90E2'; // Blue underline on hover
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(cellX, underlineY);
        this.ctx.lineTo(cellX + cellWidth, underlineY);
        this.ctx.stroke();
      }
    }

    // Draw regex link underline (for plain text URLs)
    if (this.hoveredLinkRange) {
      const range = this.hoveredLinkRange;
      // Check if this cell is within the hovered link range
      const isInRange =
        (y === range.startY && x >= range.startX && (y < range.endY || x <= range.endX)) ||
        (y > range.startY && y < range.endY) ||
        (y === range.endY && x <= range.endX && (y > range.startY || x >= range.startX));

      if (isInRange) {
        const underlineY = cellY + this.metrics.baseline + 2;
        this.ctx.strokeStyle = '#4A90E2'; // Blue underline on hover
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(cellX, underlineY);
        this.ctx.lineTo(cellX + cellWidth, underlineY);
        this.ctx.stroke();
      }
    }
  }

  /**
   * Render Unicode block elements (U+2580..U+259F, minus the shade trio) as
   * exact cell geometry. Ported from OpenChamber's ghostty-web 0.4.0 dist
   * patch so rebuilds keep identical block rendering. Returns false for
   * non-block codepoints so the caller falls back to fillText.
   */
  private renderBlockChar(
    codepoint: number,
    cellX: number,
    cellY: number,
    cellWidth: number
  ): boolean {
    const cellHeight = this.metrics.height;
    const halfW = cellWidth / 2;
    const halfH = cellHeight / 2;
    const ctx = this.ctx;
    switch (codepoint) {
      case 0x2580:
        ctx.fillRect(cellX, cellY, cellWidth, halfH);
        return true;
      case 0x2581:
        ctx.fillRect(cellX, cellY + (cellHeight * 7) / 8, cellWidth, cellHeight / 8);
        return true;
      case 0x2582:
        ctx.fillRect(cellX, cellY + (cellHeight * 3) / 4, cellWidth, cellHeight / 4);
        return true;
      case 0x2583:
        ctx.fillRect(cellX, cellY + (cellHeight * 5) / 8, cellWidth, (cellHeight * 3) / 8);
        return true;
      case 0x2584:
        ctx.fillRect(cellX, cellY + halfH, cellWidth, halfH);
        return true;
      case 0x2585:
        ctx.fillRect(cellX, cellY + (cellHeight * 3) / 8, cellWidth, (cellHeight * 5) / 8);
        return true;
      case 0x2586:
        ctx.fillRect(cellX, cellY + cellHeight / 4, cellWidth, (cellHeight * 3) / 4);
        return true;
      case 0x2587:
        ctx.fillRect(cellX, cellY + cellHeight / 8, cellWidth, (cellHeight * 7) / 8);
        return true;
      case 0x2588:
        ctx.fillRect(cellX, cellY, cellWidth, cellHeight);
        return true;
      case 0x2589:
        ctx.fillRect(cellX, cellY, (cellWidth * 7) / 8, cellHeight);
        return true;
      case 0x258a:
        ctx.fillRect(cellX, cellY, (cellWidth * 3) / 4, cellHeight);
        return true;
      case 0x258b:
        ctx.fillRect(cellX, cellY, (cellWidth * 5) / 8, cellHeight);
        return true;
      case 0x258c:
        ctx.fillRect(cellX, cellY, halfW, cellHeight);
        return true;
      case 0x258d:
        ctx.fillRect(cellX, cellY, (cellWidth * 3) / 8, cellHeight);
        return true;
      case 0x258e:
        ctx.fillRect(cellX, cellY, cellWidth / 4, cellHeight);
        return true;
      case 0x258f:
        ctx.fillRect(cellX, cellY, cellWidth / 8, cellHeight);
        return true;
      case 0x2590:
        ctx.fillRect(cellX + halfW, cellY, halfW, cellHeight);
        return true;
      case 0x2594:
        ctx.fillRect(cellX, cellY, cellWidth, cellHeight / 8);
        return true;
      case 0x2595:
        ctx.fillRect(cellX + (cellWidth * 7) / 8, cellY, cellWidth / 8, cellHeight);
        return true;
      case 0x2596:
        ctx.fillRect(cellX, cellY + halfH, halfW, halfH);
        return true;
      case 0x2597:
        ctx.fillRect(cellX + halfW, cellY + halfH, halfW, halfH);
        return true;
      case 0x2598:
        ctx.fillRect(cellX, cellY, halfW, halfH);
        return true;
      case 0x2599:
        ctx.fillRect(cellX, cellY, halfW, cellHeight);
        ctx.fillRect(cellX + halfW, cellY + halfH, halfW, halfH);
        return true;
      case 0x259a:
        ctx.fillRect(cellX, cellY, halfW, halfH);
        ctx.fillRect(cellX + halfW, cellY + halfH, halfW, halfH);
        return true;
      case 0x259b:
        ctx.fillRect(cellX, cellY, cellWidth, halfH);
        ctx.fillRect(cellX, cellY + halfH, halfW, halfH);
        return true;
      case 0x259c:
        ctx.fillRect(cellX, cellY, cellWidth, halfH);
        ctx.fillRect(cellX + halfW, cellY + halfH, halfW, halfH);
        return true;
      case 0x259d:
        ctx.fillRect(cellX + halfW, cellY, halfW, halfH);
        return true;
      case 0x259e:
        ctx.fillRect(cellX + halfW, cellY, halfW, halfH);
        ctx.fillRect(cellX, cellY + halfH, halfW, halfH);
        return true;
      case 0x259f:
        ctx.fillRect(cellX + halfW, cellY, halfW, cellHeight);
        ctx.fillRect(cellX, cellY + halfH, halfW, halfH);
        return true;
      default:
        return false;
    }
  }

  /**
   * Render cursor. The block style re-draws the character under the cursor
   * with the accent color; that cell is read from the frame's shared viewport
   * pool when available (no per-row getLine() copy), falling back to
   * getLine() only for buffers without pool support.
   */
  private renderCursor(
    buffer: IRenderable,
    pool: GhosttyCell[] | null,
    x: number,
    y: number,
    cols: number
  ): void {
    const cursorX = x * this.metrics.width;
    const cursorY = y * this.metrics.height;

    this.ctx.fillStyle = this.theme.cursor;

    switch (this.cursorStyle) {
      case 'block':
        // Full cell block
        this.ctx.fillRect(cursorX, cursorY, this.metrics.width, this.metrics.height);
        // Re-draw character under cursor with cursorAccent color
        {
          const cell = pool ? pool[y * cols + x] : buffer.getLine(y)?.[x];
          if (cell) {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(cursorX, cursorY, this.metrics.width, this.metrics.height);
            this.ctx.clip();
            this.renderCellText(cell, x, y, this.theme.cursorAccent);
            this.ctx.restore();
          }
        }
        break;

      case 'underline':
        // Underline at bottom of cell
        const underlineHeight = Math.max(2, Math.floor(this.metrics.height * 0.15));
        this.ctx.fillRect(
          cursorX,
          cursorY + this.metrics.height - underlineHeight,
          this.metrics.width,
          underlineHeight
        );
        break;

      case 'bar':
        // Vertical bar at left of cell
        const barWidth = Math.max(2, Math.floor(this.metrics.width * 0.15));
        this.ctx.fillRect(cursorX, cursorY, barWidth, this.metrics.height);
        break;
    }
  }

  // ==========================================================================
  // Cursor Blinking
  // ==========================================================================

  private startCursorBlink(): void {
    // xterm.js uses ~530ms blink interval
    this.cursorBlinkInterval = window.setInterval(() => this.toggleCursorBlink(), 530);
  }

  private stopCursorBlink(): void {
    if (this.cursorBlinkInterval !== undefined) {
      clearInterval(this.cursorBlinkInterval);
      this.cursorBlinkInterval = undefined;
    }
    // Restore visibility; the caller (Terminal option change) schedules the
    // repaint that uncovers the cursor cell.
    this.cursorVisible = true;
  }

  /**
   * Toggle cursor visibility and request a cursor-row repaint. Public
   * visibility is not required; tests drive it to verify blink scheduling.
   */
  toggleCursorBlink(): void {
    this.cursorVisible = !this.cursorVisible;
    this.onRenderRequest?.();
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Update theme colors
   */
  public setTheme(theme: ITheme): void {
    this.theme = { ...DEFAULT_THEME, ...theme };

    // Rebuild palette
    this.palette = [
      this.theme.black,
      this.theme.red,
      this.theme.green,
      this.theme.yellow,
      this.theme.blue,
      this.theme.magenta,
      this.theme.cyan,
      this.theme.white,
      this.theme.brightBlack,
      this.theme.brightRed,
      this.theme.brightGreen,
      this.theme.brightYellow,
      this.theme.brightBlue,
      this.theme.brightMagenta,
      this.theme.brightCyan,
      this.theme.brightWhite,
    ];
  }

  /**
   * Update font size
   */
  public setFontSize(size: number): void {
    this.fontSize = size;
    this.metrics = this.measureFont();
  }

  /**
   * Update font family
   */
  public setFontFamily(family: string): void {
    this.fontFamily = family;
    this.metrics = this.measureFont();
  }

  /**
   * Update cursor style
   */
  public setCursorStyle(style: 'block' | 'underline' | 'bar'): void {
    this.cursorStyle = style;
  }

  /**
   * Enable/disable cursor blinking
   */
  public setCursorBlink(enabled: boolean): void {
    if (enabled && !this.cursorBlink) {
      this.cursorBlink = true;
      this.startCursorBlink();
    } else if (!enabled && this.cursorBlink) {
      this.cursorBlink = false;
      this.stopCursorBlink();
    }
  }

  /**
   * Get current font metrics
   */

  /**
   * Render scrollbar (Phase 2)
   * Shows scroll position and allows click/drag interaction
   * @param opacity Opacity level (0-1) for fade in/out effect
   */
  private renderScrollbar(
    viewportY: number,
    scrollbackLength: number,
    visibleRows: number,
    opacity: number = 1
  ): void {
    const ctx = this.ctx;
    const canvasHeight = this.canvas.height / this.devicePixelRatio;
    const canvasWidth = this.canvas.width / this.devicePixelRatio;

    // Scrollbar dimensions
    const scrollbarWidth = 8;
    const scrollbarX = canvasWidth - scrollbarWidth - 4;
    const scrollbarPadding = 4;
    const scrollbarTrackHeight = canvasHeight - scrollbarPadding * 2;

    // Always clear the scrollbar area first (fixes ghosting when fading out)
    ctx.clearRect(scrollbarX - 2, 0, scrollbarWidth + 6, canvasHeight);
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(scrollbarX - 2, 0, scrollbarWidth + 6, canvasHeight);

    // Don't draw scrollbar if fully transparent or no scrollback
    if (opacity <= 0 || scrollbackLength === 0) return;

    // Calculate scrollbar thumb size and position
    const totalLines = scrollbackLength + visibleRows;
    const thumbHeight = Math.max(20, (visibleRows / totalLines) * scrollbarTrackHeight);

    // Position: 0 = at bottom, scrollbackLength = at top
    const scrollPosition = viewportY / scrollbackLength; // 0 to 1
    const thumbY = scrollbarPadding + (scrollbarTrackHeight - thumbHeight) * (1 - scrollPosition);

    // Draw scrollbar track (subtle background) with opacity
    ctx.fillStyle = `rgba(128, 128, 128, ${0.1 * opacity})`;
    ctx.fillRect(scrollbarX, scrollbarPadding, scrollbarWidth, scrollbarTrackHeight);

    // Draw scrollbar thumb with opacity
    const isScrolled = viewportY > 0;
    const baseOpacity = isScrolled ? 0.5 : 0.3;
    ctx.fillStyle = `rgba(128, 128, 128, ${baseOpacity * opacity})`;
    ctx.fillRect(scrollbarX, thumbY, scrollbarWidth, thumbHeight);
  }
  public getMetrics(): FontMetrics {
    return { ...this.metrics };
  }

  /**
   * Get canvas element (needed by SelectionManager)
   */
  public getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Set selection manager (for rendering selection)
   */
  public setSelectionManager(manager: SelectionManager): void {
    this.selectionManager = manager;
  }

  /**
   * Check if a cell at (x, y) is within the current selection.
   * Uses cached selection coordinates for performance.
   */
  private isInSelection(x: number, y: number): boolean {
    const sel = this.currentSelectionCoords;
    if (!sel) return false;

    const { startCol, startRow, endCol, endRow } = sel;

    // Single line selection
    if (startRow === endRow) {
      return y === startRow && x >= startCol && x <= endCol;
    }

    // Multi-line selection
    if (y === startRow) {
      // First line: from startCol to end of line
      return x >= startCol;
    } else if (y === endRow) {
      // Last line: from start of line to endCol
      return x <= endCol;
    } else if (y > startRow && y < endRow) {
      // Middle lines: entire line is selected
      return true;
    }

    return false;
  }

  /**
   * Set the currently hovered hyperlink ID for rendering underlines
   */
  public setHoveredHyperlinkId(hyperlinkId: number): void {
    this.hoveredHyperlinkId = hyperlinkId;
  }

  /**
   * Set the currently hovered link range for rendering underlines (for regex-detected URLs)
   * Pass null to clear the hover state
   */
  public setHoveredLinkRange(
    range: {
      startX: number;
      startY: number;
      endX: number;
      endY: number;
    } | null
  ): void {
    this.hoveredLinkRange = range;
  }

  /**
   * Get character cell width (for coordinate conversion)
   */
  public get charWidth(): number {
    return this.metrics.width;
  }

  /**
   * Get character cell height (for coordinate conversion)
   */
  public get charHeight(): number {
    return this.metrics.height;
  }

  /**
   * Clear entire canvas
   */
  public clear(): void {
    // clearRect first because fillRect composites rather than replaces,
    // so transparent/translucent backgrounds wouldn't clear previous content.
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Cleanup resources
   */
  public dispose(): void {
    this.stopCursorBlink();
  }
}
