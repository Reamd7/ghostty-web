/**
 * Instanced rectangle pass — backgrounds, selection, cursor, overlays.
 *
 * Attribute layout mirrors xterm.js addon-webgl RectangleRenderer (MIT):
 * position(vec2) + size(vec2) + color(vec4) = 8 floats per rectangle,
 * one shared unit quad drawn as TRIANGLE_STRIP via drawElementsInstanced.
 * Background cells are merged run-length into single wide rectangles
 * before reaching this pass.
 */

import { GLContext } from './context';

const VERT_SHADER = `#version 300 es
layout (location = 0) in vec2 a_position;
layout (location = 1) in vec2 a_size;
layout (location = 2) in vec4 a_color;
layout (location = 3) in vec2 a_unitquad;

uniform mat4 u_projection;

out vec4 v_color;

void main() {
  vec2 zeroToOne = a_position + (a_unitquad * a_size);
  gl_Position = u_projection * vec4(zeroToOne, 0.0, 1.0);
  v_color = a_color;
}`;

const FRAG_SHADER = `#version 300 es
precision mediump float;

in vec4 v_color;
out vec4 outColor;

void main() {
  outColor = v_color;
}`;

const FLOATS_PER_RECT = 8; // pos.xy + size.xy + color.rgba
const INITIAL_CAPACITY = 64; // rectangles

/** Growable CPU-side staging array (no per-frame allocation after warmup). */
export class RectBuffer {
  public data = new Float32Array(INITIAL_CAPACITY * FLOATS_PER_RECT);
  public count = 0; // rectangle count

  reset(): void {
    this.count = 0;
  }

  add(x: number, y: number, w: number, h: number, r: number, g: number, b: number, a: number): void {
    if (this.count * FLOATS_PER_RECT + FLOATS_PER_RECT > this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    const o = this.count * FLOATS_PER_RECT;
    this.data[o] = x;
    this.data[o + 1] = y;
    this.data[o + 2] = w;
    this.data[o + 3] = h;
    this.data[o + 4] = r;
    this.data[o + 5] = g;
    this.data[o + 6] = b;
    this.data[o + 7] = a;
    this.count++;
  }
}

export class RectPass {
  private readonly ctx: GLContext;
  private readonly gl: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private instanceBuffer!: WebGLBuffer;
  private projectionLoc!: WebGLUniformLocation;
  private readonly buffer = new RectBuffer();
  /** Split buffers: rects painted under glyphs (backgrounds) vs over glyphs (cursor/scrollbar). */
  private readonly overlay = new RectBuffer();

  constructor(ctx: GLContext) {
    this.ctx = ctx;
    this.gl = ctx.gl;
    this.buildResources();
    // Context loss invalidates every GL object; rebuild from scratch on
    // restore (CPU state — the rect lists — is per-frame and survives).
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
    this.projectionLoc = this.ctx.uniformLocation(this.program, 'u_projection');

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    // Unit quad: four corners, drawn as a triangle strip via element indices.
    const unitQuad = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    const quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, unitQuad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 0, 0);

    const quadIndices = new Uint8Array([0, 1, 2, 3]);
    const idxBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIndices, gl.STATIC_DRAW);

    // Instanced rect attributes: position(0), size(1), color(2).
    this.instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    const stride = FLOATS_PER_RECT * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 2 * 4);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 4 * 4);
    gl.vertexAttribDivisor(2, 1);

    gl.bindVertexArray(null);
  }

  /** Rects painted before the glyph pass (cell/selection backgrounds). */
  get backgrounds(): RectBuffer {
    return this.buffer;
  }

  /** Rects painted after the glyph pass (cursor, scrollbar, link underlines). */
  get overlays(): RectBuffer {
    return this.overlay;
  }

  private draw(list: RectBuffer): void {
    if (list.count === 0) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniformMatrix4fv(this.projectionLoc, false, this.ctx.projectionMatrix());
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    const view = list.count * FLOATS_PER_RECT === list.data.length
      ? list.data
      : list.data.subarray(0, list.count * FLOATS_PER_RECT);
    gl.bufferData(gl.ARRAY_BUFFER, view, gl.DYNAMIC_DRAW);
    gl.drawElementsInstanced(gl.TRIANGLE_STRIP, 4, gl.UNSIGNED_BYTE, 0, list.count);
  }

  drawBackgrounds(): void {
    this.draw(this.buffer);
  }

  drawOverlays(): void {
    this.draw(this.overlay);
  }

  /** Reset both lists; called at frame start. */
  beginFrame(): void {
    this.buffer.reset();
    this.overlay.reset();
  }
}
