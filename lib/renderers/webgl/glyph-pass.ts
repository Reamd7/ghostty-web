/**
 * Instanced glyph pass — 8 bytes per cell (beamterm layout, plan §0).
 *
 * Instance attributes (two uvec2, integer attributes):
 *   a_pos  = (cellX, cellY | wide << 16)
 *   a_data = (glyphId:16 | underline:1 | strike:1 | faint:1 | emoji:1 (bits 16-19),
 *             fgR (bits 24-31),
 *             fgG (bits 0-7) | fgB (bits 8-15))
 *
 * Backgrounds live in the rect pass below this pass, so instance data
 * carries no bg color. The vertex shader snaps the cell origin and far
 * edge to device pixels (highp + floor(x+0.5)) — the ANGLE seam
 * workaround noted in beamterm's shaders. Underline/strikethrough are
 * drawn by the fragment shader over the cell-local uv, so they cost no
 * atlas variants and no extra geometry.
 */

import { GLContext } from './context';
import { FontMetrics } from '../../font-metrics';

export const GLYPH_FLAG_UNDERLINE = 1 << 0;
export const GLYPH_FLAG_STRIKE = 1 << 1;
export const GLYPH_FLAG_FAINT = 1 << 2;
export const GLYPH_FLAG_EMOJI = 1 << 3;

const VERT_SHADER = `#version 300 es
precision highp float;
precision highp int;

layout (location = 0) in vec2 a_unitquad;
layout (location = 1) in uvec2 a_pos;
layout (location = 2) in uvec2 a_data;

uniform mat4 u_projection;
uniform vec2 u_cell_size;
uniform float u_gutter_l;
uniform float u_gutter_r;
uniform float u_gutter_y;

flat out uint v_glyph_index;
flat out vec3 v_fg_color;
flat out uint v_flags;
out vec2 v_cell_uv;
out vec2 v_glyph_uv; // pixel offsets within the glyph area (excludes pad)

void main() {
  v_glyph_index = a_data.x & 0xFFFFu;
  v_flags = (a_data.x >> 16u) & 0xFu;
  v_fg_color = vec3(
    float((a_data.x >> 24u) & 0xFFu) / 255.0,
    float(a_data.y & 0xFFu) / 255.0,
    float((a_data.y >> 8u) & 0xFFu) / 255.0
  );

  // Gutters extend the quad beyond the cell so italic descenders and
  // heavy-stroke overhang that canvas fillText would draw across the
  // cell border survive (the canvas renderer never clips glyphs).
  float wide = float((a_pos.y >> 16u) & 1u);
  vec2 glyphSize = vec2(u_cell_size.x * (1.0 + wide), u_cell_size.y);
  vec2 drawSize = glyphSize + vec2(u_gutter_l + u_gutter_r, u_gutter_y * 2.0);
  vec2 origin = vec2(float(a_pos.x), float(a_pos.y & 0xFFFFu)) * u_cell_size - vec2(u_gutter_l, u_gutter_y);
  vec2 snapped = floor(origin + 0.5);
  vec2 pos = snapped + a_unitquad * (floor(origin + drawSize + 0.5) - snapped);

  // Cell-local normalized uv for decorations (underline/strike): map from
  // the gutter-extended quad back onto the cell box so decoration anchors
  // don't shift when gutters change.
  v_glyph_uv = a_unitquad * drawSize - vec2(u_gutter_l, u_gutter_y);
  v_cell_uv = clamp(v_glyph_uv / glyphSize, 0.0, 1.0);
  gl_Position = u_projection * vec4(pos, 0.0, 1.0);
}`;

const FRAG_SHADER = `#version 300 es
precision mediump float;
precision mediump int;

uniform mediump sampler2DArray u_atlas;
uniform uint u_slots_per_row;
uniform uint u_slots_per_layer;
uniform vec2 u_slot_size;
uniform float u_underline_pos;
uniform float u_strike_pos;
uniform float u_line_thickness; // in cell-uv units
flat in uint v_glyph_index;
flat in vec3 v_fg_color;
flat in uint v_flags;
in vec2 v_cell_uv;
in vec2 v_glyph_uv;

out vec4 outColor;

float horizontal_line(float y, float center) {
  return 1.0 - clamp(abs(y - center) / u_line_thickness, 0.0, 1.0);
}

void main() {
  uint layer = v_glyph_index / u_slots_per_layer;
  uint inLayer = v_glyph_index % u_slots_per_layer;
  vec2 slotOrigin = vec2(
    float(inLayer % u_slots_per_row) * u_slot_size.x,
    float(inLayer / u_slots_per_row) * u_slot_size.y
  );
  vec2 inSlot = vec2(0.5) + v_glyph_uv;
  vec3 texcoord = vec3(
    (slotOrigin.x + inSlot.x) / 512.0,
    (slotOrigin.y + inSlot.y) / 512.0,
    float(layer)
  );
  vec4 texel = texture(u_atlas, texcoord);

  float faint = float((v_flags >> 2u) & 1u);
  float modulate = mix(1.0, 0.5, faint);

  float emoji = float((v_flags >> 3u) & 1u);
  if (emoji > 0.5) {
    outColor = vec4(texel.rgb, texel.a * modulate);
    return;
  }

  float underline = float(v_flags & 1u);
  float strike = float((v_flags >> 1u) & 1u);
  float line = max(
    underline * horizontal_line(v_cell_uv.y, u_underline_pos),
    strike * horizontal_line(v_cell_uv.y, u_strike_pos)
  );

  float a = max(texel.a, line) * modulate;
  outColor = vec4(v_fg_color * a, a);
}`;

const UINTS_PER_CELL = 4; // a_pos.xy + a_data.xy

/**
 * Pack one glyph instance into the staging array. Exported for unit tests:
 * the bit layout is a contract between here and the shader.
 */
export function packInstance(
  target: Uint32Array,
  index: number, // cell index (instance number)
  cellX: number,
  cellY: number,
  wide: boolean,
  glyphId: number,
  flags: number,
  fgR: number,
  fgG: number,
  fgB: number
): void {
  const o = index * UINTS_PER_CELL;
  target[o] = cellX >>> 0;
  target[o + 1] = ((cellY & 0xffff) | (wide ? 0x10000 : 0)) >>> 0;
  target[o + 2] = ((glyphId & 0xffff) | ((flags & 0xf) << 16) | ((fgR & 0xff) << 24)) >>> 0;
  target[o + 3] = ((fgG & 0xff) | ((fgB & 0xff) << 8)) >>> 0;
}

export class GlyphPass {
  private readonly ctx: GLContext;
  private readonly gl: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private instanceBuffer!: WebGLBuffer;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};

  /** Persistent staging instance array; renderer writes dirty rows in place. */
  public instances = new Uint32Array(1024 * UINTS_PER_CELL);
  /** Number of valid instances (cells) in [0, instances). */
  public count = 0;

  constructor(ctx: GLContext) {
    this.ctx = ctx;
    this.gl = ctx.gl;
    this.buildResources();
    ctx.onLoss(() => {
      this.program = undefined as unknown as WebGLProgram;
      this.vao = undefined as unknown as WebGLVertexArrayObject;
      this.instanceBuffer = undefined as unknown as WebGLBuffer;
    });
    ctx.onRestore(() => this.buildResources());
  }

  private buildResources(): void {
    const gl = this.gl;
    this.program = this.ctx.createProgram(VERT_SHADER, FRAG_SHADER);
    for (const name of [
      'u_projection', 'u_cell_size', 'u_gutter_l', 'u_gutter_r', 'u_gutter_y', 'u_atlas', 'u_slots_per_row',
      'u_slots_per_layer', 'u_slot_size',
      'u_underline_pos', 'u_strike_pos', 'u_line_thickness',
    ]) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    const quad = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    const quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const quadIdx = new Uint8Array([0, 1, 2, 3]);
    const idxBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIdx, gl.STATIC_DRAW);

    this.instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    const stride = UINTS_PER_CELL * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 2, gl.UNSIGNED_INT, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 2, gl.UNSIGNED_INT, stride, 8);
    gl.vertexAttribDivisor(2, 1);

    gl.bindVertexArray(null);
  }

  ensureCapacity(cells: number): void {
    if (cells * UINTS_PER_CELL <= this.instances.length) return;
    let size = this.instances.length;
    while (size < cells * UINTS_PER_CELL) size *= 2;
    const next = new Uint32Array(size);
    next.set(this.instances);
    this.instances = next;
  }

  /** Upload [0, count) instances and draw. Uniforms reflect atlas + metrics. */
  draw(atlas: {
    slotsPerRow: number;
    slotsPerLayer: number;
    slotW: number;
    slotH: number;
    bind: (unit: number) => void;
  }, metrics: FontMetrics): void {
    if (this.count === 0) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    atlas.bind(0);
    gl.uniform1i(this.uniforms['u_atlas']!, 0);
    gl.uniformMatrix4fv(this.uniforms['u_projection']!, false, this.ctx.projectionMatrix());
    gl.uniform2f(this.uniforms['u_cell_size']!, metrics.width, metrics.height);
    gl.uniform1f(this.uniforms['u_gutter_l']!, 1.0);
    gl.uniform1f(this.uniforms['u_gutter_r']!, 2.0);
    gl.uniform1f(this.uniforms['u_gutter_y']!, 1.0);
    gl.uniform1ui(this.uniforms['u_slots_per_row']!, atlas.slotsPerRow);
    gl.uniform1ui(this.uniforms['u_slots_per_layer']!, atlas.slotsPerLayer);
    gl.uniform2f(this.uniforms['u_slot_size']!, atlas.slotW, atlas.slotH);
    // Canvas renderer draws underline at baseline+2 and strike at height/2
    // with lineWidth 1 — mirror those positions in cell-uv space.
    gl.uniform1f(this.uniforms['u_underline_pos']!, (metrics.baseline + 2) / metrics.height);
    gl.uniform1f(this.uniforms['u_strike_pos']!, 0.5);
    gl.uniform1f(this.uniforms['u_line_thickness']!, 1.0 / metrics.height);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.instances.subarray(0, this.count * UINTS_PER_CELL), gl.DYNAMIC_DRAW);
    gl.drawElementsInstanced(gl.TRIANGLE_STRIP, 4, gl.UNSIGNED_BYTE, 0, this.count);
    gl.bindVertexArray(null);
  }
}
