/**
 * Glyph atlas — texture-array slot allocator with on-demand rasterization.
 *
 * Design (plan §0, beamterm-adapted):
 * - One sampler2DArray (RGBA8). Slots are uniform: (2·cellW + 2·pad) ×
 *   (cellH + 2·pad) — wide glyphs and grapheme clusters rasterize into the
 *   same slot size, single addressing scheme.
 * - Cache key is (text, bold, italic) — NOT color: glyphs rasterize white
 *   and the shader multiplies by the per-cell fg. Color fonts (emoji)
 *   bake their palette and set the emoji flag.
 * - Underline/strikethrough are not atlas variants: they are shader lines
 *   driven by instance flag bits (beamterm design).
 * - LRU eviction recycles slots when every layer is full.
 */

import { FontMetrics } from '../../font-metrics';

const PAD = 1; // bleed guard
const LAYER_SIZE = 512; // texStorage3D per-layer footprint (non-POT fine in WebGL2)
const INITIAL_LAYERS = 4;
const MAX_LAYERS = 24;

/** Glyph slot handle stored in instance data (fits 16 bits). */
export interface GlyphEntry {
  /** Opaque id: slot index across all layers. */
  id: number;
  /** true if the rasterized pixels are colored (emoji/COLR fonts). */
  emoji: boolean;
}

interface CacheValue {
  entry: GlyphEntry;
  lastUsed: number;
}

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;

export interface AtlasSpec {
  metrics: FontMetrics;
  fontFamily: string;
  fontSize: number;
  fontWeight?: number;
  fontWeightBold?: number;
}

export class GlyphAtlas {
  public readonly slotW: number;
  public readonly slotH: number;
  public readonly slotsPerRow: number;
  public readonly slotsPerLayer: number;
  public layers = INITIAL_LAYERS;

  private readonly gl: WebGL2RenderingContext;
  private texture!: WebGLTexture;
  private readonly cache = new Map<string, CacheValue>();
  private readonly freeSlots: number[] = [];
  private nextSlot = 0;
  private clock = 0;
  private readonly spec: AtlasSpec;

  // Rasterization scratch (reused, willReadFrequently).
  private tmpCanvas: HTMLCanvasElement;
  private tmpCtx: CanvasRenderingContext2D;

  /** Bumped on any GPU-side invalidation (rebuild, spec change). */
  public layoutVersion = 0;

  constructor(gl: WebGL2RenderingContext, spec: AtlasSpec) {
    this.gl = gl;
    this.spec = spec;
    this.slotW = spec.metrics.width * 2 + PAD * 2;
    this.slotH = spec.metrics.height + PAD * 2;
    this.slotsPerRow = Math.floor(LAYER_SIZE / this.slotW);
    this.slotsPerLayer = this.slotsPerRow * Math.floor(LAYER_SIZE / this.slotH);

    this.tmpCanvas = document.createElement('canvas');
    this.tmpCanvas.width = this.slotW;
    this.tmpCanvas.height = this.slotH;
    this.tmpCtx = this.tmpCanvas.getContext('2d', { willReadFrequently: true })!;

    this.allocateTexture();
  }

  private allocateTexture(): void {
    const gl = this.gl;
    if (this.texture) gl.deleteTexture(this.texture);
    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, LAYER_SIZE, LAYER_SIZE, this.layers);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.layoutVersion++;
  }

  bind(unit: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
  }

  /**
   * Look up (rasterizing on miss) a glyph variant. `text` is the full
   * grapheme cluster string. Returns null when the variant cannot be
   * rasterized (e.g. zero-sized).
   */
  get(text: string, bold: boolean, italic: boolean): GlyphEntry | null {
    const key = (bold ? 'b' : '') + (italic ? 'i' : '') + text;
    const hit = this.cache.get(key);
    if (hit) {
      hit.lastUsed = ++this.clock;
      return hit.entry;
    }
    const entry = this.rasterize(text, bold, italic);
    if (!entry) return null;
    this.cache.set(key, { entry, lastUsed: ++this.clock });
    return entry;
  }

  private acquireSlot(): number {
    if (this.freeSlots.length > 0) return this.freeSlots.pop()!;
    if (this.nextSlot >= this.slotsPerLayer * this.layers) {
      if (this.evictOne()) return this.freeSlots.pop()!;
      if (this.layers < MAX_LAYERS) {
        this.layers += 4;
        // texStorage3D is immutable: reallocate and re-rasterize everything.
        this.allocateTexture();
        this.rebuildAll();
      } else if (this.evictOne(true)) {
        return this.freeSlots.pop()!;
      } else {
        return -1;
      }
    }
    return this.nextSlot++;
  }

  /** Evict the least-recently-used entry. `force` skips the grace window. */
  private evictOne(force = false): boolean {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [key, v] of this.cache) {
      if (v.lastUsed < oldest) {
        oldest = v.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey === null) return false;
    if (!force && this.clock - oldest < 64) return false; // grace: hot atlas
    const v = this.cache.get(oldestKey)!;
    this.freeSlots.push(v.entry.id);
    this.cache.delete(oldestKey);
    return true;
  }

  /** After reallocation every cached slot id is void: re-rasterize the keys. */
  private rebuildAll(): void {
    const keys = [...this.cache.keys()];
    this.cache.clear();
    this.freeSlots.length = 0;
    this.nextSlot = 0;
    for (const key of keys) {
      const bold = key.startsWith('b');
      const rest = bold ? key.slice(1) : key;
      const italic = rest.startsWith('i');
      const text = italic ? rest.slice(1) : rest;
      this.get(text, bold, italic);
    }
  }

  private rasterize(text: string, bold: boolean, italic: boolean): GlyphEntry | null {
    const id = this.acquireSlot();
    if (id < 0) return null;

    const ctx = this.tmpCtx;
    ctx.clearRect(0, 0, this.slotW, this.slotH);
    let font = '';
    if (italic) font += 'italic ';
    if (bold) font += `${this.spec.fontWeightBold ?? 'bold'} `;
    else if (this.spec.fontWeight !== undefined) font += `${this.spec.fontWeight} `;
    ctx.font = `${font}${this.spec.fontSize}px ${this.spec.fontFamily}`;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, PAD, PAD + this.spec.metrics.baseline);

    // Emoji / color-font detection: only inspect pixels for candidates —
    // monochrome rasterization of plain text never needs the scan.
    let emoji = false;
    if (EMOJI_RE.test(text)) {
      const img = ctx.getImageData(0, 0, this.slotW, this.slotH).data;
      for (let i = 0; i < img.length; i += 4) {
        if (img[i + 3] > 0 && (Math.abs(img[i] - img[i + 1]) > 8 || Math.abs(img[i + 1] - img[i + 2]) > 8)) {
          emoji = true;
          break;
        }
      }
    }

    const layer = Math.floor(id / this.slotsPerLayer);
    const inLayer = id % this.slotsPerLayer;
    const sx = (inLayer % this.slotsPerRow) * this.slotW;
    const sy = Math.floor(inLayer / this.slotsPerRow) * this.slotH;
    this.gl.bindTexture(this.gl.TEXTURE_2D_ARRAY, this.texture);
    this.gl.texSubImage3D(
      this.gl.TEXTURE_2D_ARRAY, 0, sx, sy, layer,
      this.slotW, this.slotH, 1,
      this.gl.RGBA, this.gl.UNSIGNED_BYTE, this.tmpCanvas
    );
    return { id, emoji };
  }

  /** Warm the ASCII printable range (addon-webgl warmUp pattern). */
  warmUp(): void {
    for (let c = 33; c <= 126; c++) this.get(String.fromCharCode(c), false, false);
  }

  /** Spec change (font/size): drop everything, new geometry. */
  clear(): void {
    this.cache.clear();
    this.freeSlots.length = 0;
    this.nextSlot = 0;
    this.allocateTexture();
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
    this.cache.clear();
  }
}
