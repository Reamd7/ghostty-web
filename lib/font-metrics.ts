/**
 * Shared font metrics — single source of truth for renderer geometry.
 *
 * Both CanvasRenderer and WebGLRenderer must derive identical cell
 * geometry from identical options: selection/link hit testing and the
 * pixel-diff verification loop (demo/webgl-check.html) depend on it.
 * Extracted verbatim from CanvasRenderer.measureFont; the canvas
 * renderer now delegates here.
 */

export interface FontMetrics {
  width: number; // Character cell width in CSS pixels
  height: number; // Character cell height in CSS pixels
  baseline: number; // Distance from top to text baseline
}

export interface FontSpec {
  fontSize: number;
  fontFamily: string;
  /** CSS font weight for regular text; undefined = normal */
  fontWeight?: number;
  /** Cell height multiplier; undefined = legacy "+2px" padding */
  lineHeight?: number;
}

export function measureFontMetrics(spec: FontSpec): FontMetrics {
  // Use an offscreen canvas for measurement
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;

  // Set font (use actual pixel size and the regular weight for accurate
  // measurement — cell width must be measured at the weight we draw with).
  ctx.font =
    spec.fontWeight !== undefined
      ? `${spec.fontWeight} ${spec.fontSize}px ${spec.fontFamily}`
      : `${spec.fontSize}px ${spec.fontFamily}`;

  // Measure width using 'M' (typically widest character)
  const widthMetrics = ctx.measureText('M');
  const width = Math.ceil(widthMetrics.width);

  // Line-box metrics must come from the FONT-wide bounding box, not the
  // 'M' glyph's actual bounding box: CJK and box-drawing glyphs are much
  // taller than 'M', and baselines derived from 'M' clip their tops at
  // the canvas edge (row 0 renders with its upper pixels cut off).
  const fontAscent =
    widthMetrics.fontBoundingBoxAscent ||
    widthMetrics.actualBoundingBoxAscent ||
    spec.fontSize * 0.8;
  const fontDescent =
    widthMetrics.fontBoundingBoxDescent ||
    widthMetrics.actualBoundingBoxDescent ||
    spec.fontSize * 0.2;

  if (spec.lineHeight !== undefined) {
    // Explicit line height: scale the font box, baseline follows the
    // scaled font ascent so no glyph in the font can cross the cell top.
    const height = Math.ceil((fontAscent + fontDescent) * spec.lineHeight);
    const baseline = Math.ceil(fontAscent * spec.lineHeight);
    return { width, height, baseline };
  }

  // Legacy default: 'M'-glyph box + 2px padding (unchanged behavior).
  const ascent = widthMetrics.actualBoundingBoxAscent || spec.fontSize * 0.8;
  const descent = widthMetrics.actualBoundingBoxDescent || spec.fontSize * 0.2;

  // Add 2px padding to height to account for glyphs that overflow (like 'f', 'd', 'g', 'p')
  // and anti-aliasing pixels
  const height = Math.ceil(ascent + descent) + 2;
  const baseline = Math.ceil(ascent) + 1; // Offset baseline by half the padding

  return { width, height, baseline };
}
