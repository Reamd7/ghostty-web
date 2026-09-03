/**
 * WebGL2 context wrapper — acquisition, shader plumbing, context loss.
 *
 * Modeled on the lifecycle observed in xterm.js addon-webgl (MIT):
 * - context lost is preventDefault-ed so the context can be restored;
 * - restoration re-runs registered rebuild handlers (shaders, buffers,
 *   textures) while CPU-side caches survive;
 * - any GL failure throws a recognizable error so the owning renderer can
 *   fall back to the canvas renderer (auto chain, plan M5).
 */

/** Thrown when a WebGL2 context cannot be acquired at all. */
export class GLUnavailableError extends Error {
  constructor(message = 'WebGL2 context unavailable') {
    super(message);
    this.name = 'GLUnavailableError';
  }
}

/** Thrown when shader compilation/program linking fails or GL is lost. */
export class GLSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GLSetupError';
  }
}

export interface GLContextOptions {
  /** Additional getContext attributes (DPR-aware callers keep defaults). */
  contextAttributes?: WebGLContextAttributes;
}

const DEFAULT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  // The verification loop (demo/webgl-check.html) reads the framebuffer
  // via toDataURL after the compositor may have detached it; preserving
  // the drawing buffer keeps that read correct. The cost is minor for a
  // terminal's single full-screen blit.
  preserveDrawingBuffer: true,
  antialias: false,
  depth: false,
  stencil: false,
};

export class GLContext {
  public readonly gl: WebGL2RenderingContext;
  private readonly canvas: HTMLCanvasElement;
  private lost = false;
  private readonly restoreHandlers: Array<() => void> = [];
  private readonly lossHandlers: Array<() => void> = [];

  constructor(canvas: HTMLCanvasElement, options: GLContextOptions = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      ...DEFAULT_ATTRIBUTES,
      ...options.contextAttributes,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new GLUnavailableError();
    this.gl = gl;

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault(); // required for restoration to be possible
      this.lost = true;
      for (const h of this.lossHandlers) h();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      for (const h of this.restoreHandlers) h();
    });
  }

  get isLost(): boolean {
    return this.lost;
  }

  /** Register a handler to run when the context is restored (rebuild GPU resources). */
  onRestore(handler: () => void): void {
    this.restoreHandlers.push(handler);
  }

  /** Register a handler to run when the context is lost (drop GPU resource handles). */
  onLoss(handler: () => void): void {
    this.lossHandlers.push(handler);
  }

  private shader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(type);
    if (!sh) throw new GLSetupError('createShader returned null');
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) ?? '(no log)';
      gl.deleteShader(sh);
      throw new GLSetupError(`shader compile failed: ${log}`);
    }
    return sh;
  }

  /** Compile + link a program. Throws GLSetupError with logs on failure. */
  createProgram(vsSource: string, fsSource: string): WebGLProgram {
    const gl = this.gl;
    if (this.lost) throw new GLSetupError('context is lost');
    const vs = this.shader(gl.VERTEX_SHADER, vsSource);
    const fs = this.shader(gl.FRAGMENT_SHADER, fsSource);
    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      throw new GLSetupError('createProgram returned null');
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? '(no log)';
      gl.deleteProgram(program);
      throw new GLSetupError(`program link failed: ${log}`);
    }
    return program;
  }

  /** Uniform location accessor that fails loudly (setup bugs must not pass silently). */
  uniformLocation(program: WebGLProgram, name: string): WebGLUniformLocation {
    const loc = this.gl.getUniformLocation(program, name);
    if (!loc) throw new GLSetupError(`uniform not found: ${name}`);
    return loc;
  }

  /**
   * Orthographic projection mapping CSS-pixel coordinates ([0,w]×[h,0],
   * y-down like the 2D canvas) to clip space. DPR scaling happens via the
   * viewport, so renderer math stays in CSS pixels on both render paths.
   */
  projectionMatrix(): Float32Array {
    const w = Math.max(1, this.canvas.width);
    const h = Math.max(1, this.canvas.height);
    // Column-major 4×4: scale (2/w, -2/h), translate (-1, 1).
    return new Float32Array([
      2 / w, 0, 0, 0,
      0, -2 / h, 0, 0,
      0, 0, 1, 0,
      -1, 1, 0, 1,
    ]);
  }

  dispose(): void {
    // Programs/buffers/textures are owned by the passes; the context
    // wrapper only drops listeners implicitly (canvas-owned).
    this.restoreHandlers.length = 0;
    this.lossHandlers.length = 0;
  }
}
