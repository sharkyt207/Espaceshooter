/**
 * GLContext - WebGL2 setup, capability probing, and the shader plumbing.
 *
 * Everything here is deliberately defensive. This renderer is the *optional*
 * path: if anything about it fails - no WebGL2, a driver that rejects a
 * shader, a context lost on a backgrounded phone - the game has to fall back
 * to the software raycaster rather than showing a black screen. So every entry
 * point returns null or false instead of throwing, and the caller decides.
 *
 * WebGL2 rather than WebGL1 is a real requirement, not a convenience:
 *
 *   - **Texture arrays.** Sixteen materials as sixteen layers means one bind
 *     and one draw call for the whole world. With WebGL1 the alternative is an
 *     atlas, and an atlas plus mipmaps means bleeding between neighbours
 *     exactly where the filtering is supposed to help.
 *   - **Non-power-of-two textures with mipmaps**, which the lightmap needs.
 *   - **`textureLod` and integer attributes**, which the world shader uses.
 *
 * WebGL2 has been on iOS since 15 and Android since forever, so the fallback
 * is for genuinely old hardware and for the case where a browser has
 * blacklisted the GPU.
 */

export interface GLCapabilities {
  /** Maximum anisotropy the driver will do, 1 when the extension is absent. */
  maxAnisotropy: number;
  /** Float render targets, needed for the bloom chain to keep highlights. */
  floatRenderTargets: boolean;
  maxTextureSize: number;
  /** Renderer string, for the debug overlay. */
  renderer: string;
}

export interface GLSetup {
  gl: WebGL2RenderingContext;
  caps: GLCapabilities;
  anisotropyExt: { TEXTURE_MAX_ANISOTROPY_EXT: number } | null;
}

/**
 * Create a context on the given canvas.
 *
 * `antialias` is off on purpose. MSAA on a phone costs bandwidth, which is the
 * scarce resource, and this scene has almost no long thin edges - the geometry
 * is axis-aligned boxes. The blur that actually matters is texture filtering,
 * which mipmaps and anisotropy handle.
 */
/**
 * Whether this run needs the drawing buffer to survive past the frame.
 *
 * True under automation (`navigator.webdriver` is set by every WebDriver-based
 * runner and by nothing else) or when `?glcapture=1` is passed explicitly.
 */
function isCapturing(): boolean {
  try {
    if (navigator.webdriver) return true;
  } catch {
    /* no navigator: not a browser, so nothing to capture. */
  }
  return /[?&]glcapture=1/.test(location.search);
}

export function createGL(canvas: HTMLCanvasElement): GLSetup | null {
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: true,
      stencil: false,
      // The frame is fully redrawn every time, so letting the driver drop the
      // previous contents saves a full-screen copy per frame on tiled GPUs.
      //
      // The exception is automated capture: without a preserved buffer, a
      // screenshot taken outside the frame callback reads an undefined
      // surface, which makes every visual test worthless - it hangs or
      // returns garbage. So it is preserved under a driven browser, and for
      // anyone who passes the flag by hand to grab a shot. Neither affects
      // what is drawn, only whether the surface survives the frame.
      preserveDrawingBuffer: isCapturing(),
      powerPreference: 'high-performance',
      // Rendering happens into an offscreen target and is resolved through a
      // post pass, so the default framebuffer never needs alpha blending.
      premultipliedAlpha: false,
      desynchronized: true,
    }) as WebGL2RenderingContext | null;
  } catch {
    return null;
  }
  if (!gl) return null;

  const anisotropyExt =
    (gl.getExtension('EXT_texture_filter_anisotropic') ??
      gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic')) as
      | { TEXTURE_MAX_ANISOTROPY_EXT: number; MAX_TEXTURE_MAX_ANISOTROPY_EXT: number }
      | null;

  const maxAnisotropy = anisotropyExt
    ? (gl.getParameter(anisotropyExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number)
    : 1;

  // Half-float is enough for bloom and is far more widely renderable than
  // full float on mobile.
  const floatRenderTargets = !!gl.getExtension('EXT_color_buffer_half_float') ||
    !!gl.getExtension('EXT_color_buffer_float');

  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = debugInfo
    ? String(gl.getParameter((debugInfo as { UNMASKED_RENDERER_WEBGL: number }).UNMASKED_RENDERER_WEBGL))
    : 'WebGL2';

  return {
    gl,
    anisotropyExt,
    caps: {
      maxAnisotropy,
      floatRenderTargets,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      renderer,
    },
  };
}

// ===========================================================================
// Shader plumbing
// ===========================================================================

function compile(gl: WebGL2RenderingContext, type: number, source: string, label: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    // Loud, because a silent shader failure looks like a renderer bug
    // somewhere else entirely and costs hours.
    console.error(`[gl] ${label} failed to compile:\n${gl.getShaderInfoLog(shader)}`);
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export interface Program {
  program: WebGLProgram;
  /** Uniform locations, looked up once. */
  u: Record<string, WebGLUniformLocation | null>;
}

/**
 * Build and link a program, resolving the named uniforms up front.
 *
 * Uniform lookup by name is a string hash on every call; doing it once at
 * startup and keeping the locations is the difference between a tidy API and a
 * measurable per-frame cost.
 */
export function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
  uniforms: string[],
  label: string,
): Program | null {
  const vs = compile(gl, gl.VERTEX_SHADER, vertexSource, `${label} vertex`);
  if (!vs) return null;
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource, `${label} fragment`);
  if (!fs) {
    gl.deleteShader(vs);
    return null;
  }

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  // The shaders are owned by the program once linked.
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(`[gl] ${label} failed to link:\n${gl.getProgramInfoLog(program)}`);
    gl.deleteProgram(program);
    return null;
  }

  const u: Record<string, WebGLUniformLocation | null> = {};
  for (const name of uniforms) u[name] = gl.getUniformLocation(program, name);
  return { program, u };
}

// ===========================================================================
// Matrices
// ===========================================================================

/**
 * Column-major 4x4, the layout WebGL wants.
 *
 * Written out rather than pulled from a library: this project has no runtime
 * dependencies, and the renderer needs exactly three of these.
 */
export type Mat4 = Float32Array;

export function mat4(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function perspective(out: Mat4, fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

/**
 * View matrix from the game's camera convention.
 *
 * The world is x/y on the ground plane with z up, in tile units. The camera
 * looks along +x at angle 0, matching the simulation's `Math.cos(angle)` /
 * `Math.sin(angle)` heading - which means gameplay and rendering agree about
 * which way "forward" is without a conversion anyone has to remember.
 */
export function viewMatrix(
  out: Mat4,
  x: number,
  y: number,
  z: number,
  yaw: number,
  pitch: number,
  roll: number,
): Mat4 {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);

  // Camera basis: forward is the heading, right is 90 degrees clockwise on the
  // ground plane, up completes the set. Roll rotates right/up about forward.
  const fx = cy * cp;
  const fy = sy * cp;
  const fz = sp;

  let rx = -sy;
  let ry = cy;
  let rz = 0;

  // up = forward x right
  let ux = fy * rz - fz * ry;
  let uy = fz * rx - fx * rz;
  let uz = fx * ry - fy * rx;

  if (roll !== 0) {
    const rx2 = rx * cr + ux * sr;
    const ry2 = ry * cr + uy * sr;
    const rz2 = rz * cr + uz * sr;
    ux = ux * cr - rx * sr;
    uy = uy * cr - ry * sr;
    uz = uz * cr - rz * sr;
    rx = rx2;
    ry = ry2;
    rz = rz2;
  }

  // View is the inverse of the camera transform: rows are the basis vectors.
  out[0] = rx; out[4] = ry; out[8] = rz; out[12] = -(rx * x + ry * y + rz * z);
  out[1] = ux; out[5] = uy; out[9] = uz; out[13] = -(ux * x + uy * y + uz * z);
  out[2] = -fx; out[6] = -fy; out[10] = -fz; out[14] = fx * x + fy * y + fz * z;
  out[3] = 0; out[7] = 0; out[11] = 0; out[15] = 1;
  return out;
}

export function multiply(out: Mat4, a: Mat4, b: Mat4): Mat4 {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4];
    const b1 = b[c * 4 + 1];
    const b2 = b[c * 4 + 2];
    const b3 = b[c * 4 + 3];
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}
