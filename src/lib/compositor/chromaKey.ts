/**
 * Chroma key (green / blue screen), OBS-style.
 *
 * Each pixel's distance to the key colour is measured in the CbCr plane
 * (brightness-independent, so shadows on the screen still key out), lightly
 * smoothed over a 5-tap cross to calm compression noise, and mapped to
 * alpha with smoothstep(similarity, similarity + smoothness). Spill
 * suppression pulls the key channel down toward the other two
 * (`g = mix(g, min(g, max(r, b)), spill)` for green; analogous for blue/red).
 *
 * One shared WebGL2 context does the work; `process` returns that context's
 * canvas, which the next call overwrites — draw it right away. Without
 * WebGL2 the same maths runs on the CPU via getImageData (slow; meant for
 * export on machines without a GPU context).
 */

export interface ChromaKeyParams {
  /** '#rrggbb' */
  color: string
  /** 0..1 — CbCr distance below which pixels are fully transparent. */
  similarity: number
  /** 0..1 — width of the soft edge above `similarity`. */
  smoothness: number
  /** 0..1 — strength of key-colour spill removal. */
  spill: number
}

export type ChromaSource =
  | HTMLVideoElement
  | HTMLImageElement
  | HTMLCanvasElement
  | OffscreenCanvas
  | ImageBitmap
  | VideoFrame
  | (CanvasImageSource & { width?: number; height?: number })

export interface ChromaKeyProcessor {
  /** Keyed, premultiplied frame at width×height, or null (context lost / failed). */
  process(
    src: ChromaSource,
    params: ChromaKeyParams,
    width: number,
    height: number,
  ): HTMLCanvasElement | OffscreenCanvas | null
  dispose(): void
  /** True when WebGL2 does the keying, false on the CPU fallback. */
  readonly gpu: boolean
}

// ── Pure maths (unit-tested; mirrored by the shader) ────────────────────────

export type RGB = readonly [number, number, number]

/** '#rrggbb' / '#rgb' → 0..255 channels; invalid input → pure green. */
export function parseHexColor(hex: string): RGB {
  let h = hex.trim().replace(/^#/, '')
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.replace(/./g, (c) => c + c)
  if (!/^[0-9a-f]{6}$/i.test(h)) return [0, 255, 0]
  const n = parseInt(h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function toHexColor(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/** BT.601 full-range Cb, Cr in 0..1 for channels in 0..1. */
export function rgbToCbCr(r: number, g: number, b: number): [number, number] {
  return [
    -0.168736 * r - 0.331264 * g + 0.5 * b + 0.5,
    0.5 * r - 0.418688 * g - 0.081312 * b + 0.5,
  ]
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** 0 = none, 1 = red, 2 = green, 3 = blue: the key colour's dominant channel. */
export function spillChannel(key: RGB): 0 | 1 | 2 | 3 {
  const [r, g, b] = key
  const max = Math.max(r, g, b)
  if (max - Math.min(r, g, b) < 16) return 0
  if (g === max) return 2
  if (b === max) return 3
  return 1
}

/** Alpha factor (0..1) for a smoothed CbCr distance. */
export function keyAlpha(dist: number, similarity: number, smoothness: number): number {
  return smoothstep(similarity, similarity + Math.max(smoothness, 1e-4), dist)
}

/** Spill suppression on 0..1 channels. */
export function suppressSpill(
  r: number,
  g: number,
  b: number,
  channel: 0 | 1 | 2 | 3,
  spill: number,
): [number, number, number] {
  const mix = (x: number, y: number) => x + (y - x) * spill
  if (channel === 2) return [r, mix(g, Math.min(g, Math.max(r, b))), b]
  if (channel === 3) return [r, g, mix(b, Math.min(b, Math.max(r, g)))]
  if (channel === 1) return [mix(r, Math.min(r, Math.max(g, b))), g, b]
  return [r, g, b]
}

/**
 * Key an RGBA (straight alpha) buffer in place — the CPU path, identical to
 * the shader: 5-tap cross-smoothed distance (centre weight 4), clamp-to-edge.
 */
export function keyImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  params: ChromaKeyParams,
): void {
  const key = parseHexColor(params.color)
  const [kcb, kcr] = rgbToCbCr(key[0] / 255, key[1] / 255, key[2] / 255)
  const channel = spillChannel(key)
  const n = width * height
  const dist = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const [cb, cr] = rgbToCbCr(
      (data[o] ?? 0) / 255,
      (data[o + 1] ?? 0) / 255,
      (data[o + 2] ?? 0) / 255,
    )
    dist[i] = Math.hypot(cb - kcb, cr - kcr)
  }
  const at = (x: number, y: number) =>
    dist[
      Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))
    ] ?? 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d =
        (4 * at(x, y) + at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) / 8
      const a = keyAlpha(d, params.similarity, params.smoothness)
      const o = (y * width + x) * 4
      const [r, g, b] = suppressSpill(
        (data[o] ?? 0) / 255,
        (data[o + 1] ?? 0) / 255,
        (data[o + 2] ?? 0) / 255,
        channel,
        params.spill,
      )
      data[o] = r * 255
      data[o + 1] = g * 255
      data[o + 2] = b * 255
      data[o + 3] = (data[o + 3] ?? 255) * a
    }
  }
}

/**
 * Dominant saturated colour along the frame's border (outer 10 %), the usual
 * place to find the screen. Hue-bucketed (30° buckets); green/blue win ties.
 * Falls back to pure green when nothing saturated is found.
 */
export function suggestKeyColorFromPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): string {
  const band = Math.max(1, Math.round(Math.min(width, height) * 0.1))
  const BUCKETS = 12
  const sums = Array.from({ length: BUCKETS }, () => ({ n: 0, r: 0, g: 0, b: 0 }))
  for (let y = 0; y < height; y++) {
    const edgeRow = y < band || y >= height - band
    for (let x = 0; x < width; x++) {
      if (!edgeRow && x >= band && x < width - band) continue
      const o = (y * width + x) * 4
      const r = data[o] ?? 0
      const g = data[o + 1] ?? 0
      const b = data[o + 2] ?? 0
      if ((data[o + 3] ?? 255) < 128) continue
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      if (max < 48 || (max - min) / max < 0.3) continue
      const c = max - min
      let hue: number
      if (max === r) hue = ((g - b) / c + 6) % 6
      else if (max === g) hue = (b - r) / c + 2
      else hue = (r - g) / c + 4
      const bucket = sums[Math.floor((hue / 6) * BUCKETS) % BUCKETS]
      if (!bucket) continue
      bucket.n++
      bucket.r += r
      bucket.g += g
      bucket.b += b
    }
  }
  // Green (90–150°) and blue (210–270°) buckets get a small preference.
  const bias = (i: number) => (i === 3 || i === 4 || i === 7 || i === 8 ? 1.25 : 1)
  let best = -1
  let bestScore = 0
  sums.forEach((s, i) => {
    const score = s.n * bias(i)
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  })
  const win = sums[best]
  if (!win || win.n === 0) return '#00ff00'
  return toHexColor(win.r / win.n, win.g / win.n, win.b / win.n)
}

// ── Canvas helpers ──────────────────────────────────────────────────────────

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    return c
  }
  return new OffscreenCanvas(w, h)
}

function ctx2d(
  c: AnyCanvas,
): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null {
  return c.getContext('2d', { willReadFrequently: true })
}

/** Intrinsic pixel size of any drawable source. */
export function sourceSize(src: ChromaSource): { width: number; height: number } {
  if (typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement) {
    return { width: src.videoWidth, height: src.videoHeight }
  }
  if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) {
    return { width: src.naturalWidth, height: src.naturalHeight }
  }
  if (typeof VideoFrame !== 'undefined' && src instanceof VideoFrame) {
    return { width: src.displayWidth, height: src.displayHeight }
  }
  const s = src as { width?: unknown; height?: unknown }
  const num = (v: unknown) => (typeof v === 'number' ? v : 0)
  return { width: num(s.width), height: num(s.height) }
}

/** Pick a key colour from a frame by sampling its borders. */
export function suggestKeyColor(
  image: ChromaSource,
  width: number,
  height: number,
): string {
  const w = Math.max(1, Math.min(96, Math.round(width)))
  const h = Math.max(1, Math.round((w * height) / Math.max(1, width)))
  const c = makeCanvas(w, h)
  const ctx = ctx2d(c)
  if (!ctx) return '#00ff00'
  try {
    ctx.drawImage(image, 0, 0, w, h)
    return suggestKeyColorFromPixels(ctx.getImageData(0, 0, w, h).data, w, h)
  } catch {
    return '#00ff00'
  }
}

/** Eyedropper: average colour of the 3×3 source pixels around (u, v) ∈ [0,1]². */
export function colorAt(image: ChromaSource, u: number, v: number): string | null {
  const { width, height } = sourceSize(image)
  if (width <= 0 || height <= 0) return null
  const px = Math.min(width - 1, Math.max(0, Math.floor(u * width)))
  const py = Math.min(height - 1, Math.max(0, Math.floor(v * height)))
  const x0 = Math.max(0, px - 1)
  const y0 = Math.max(0, py - 1)
  const sw = Math.min(width, px + 2) - x0
  const sh = Math.min(height, py + 2) - y0
  const c = makeCanvas(sw, sh)
  const ctx = ctx2d(c)
  if (!ctx) return null
  try {
    ctx.drawImage(image, x0, y0, sw, sh, 0, 0, sw, sh)
    const d = ctx.getImageData(0, 0, sw, sh).data
    let r = 0
    let g = 0
    let b = 0
    const n = sw * sh
    for (let i = 0; i < n; i++) {
      r += d[i * 4] ?? 0
      g += d[i * 4 + 1] ?? 0
      b += d[i * 4 + 2] ?? 0
    }
    return toHexColor(r / n, g / n, b / n)
  } catch {
    return null
  }
}

// ── WebGL2 ──────────────────────────────────────────────────────────────────

const VERT = `#version 300 es
out vec2 v_uv;
void main() {
  // Full-screen triangle from gl_VertexID; uv.y flipped so row 0 = top.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  v_uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  gl_Position = vec4(p, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform vec2 u_key;      // key CbCr
uniform vec2 u_texel;    // 1 / source size
uniform float u_similarity;
uniform float u_smoothness;
uniform float u_spill;
uniform int u_channel;   // 0 none, 1 r, 2 g, 3 b

vec2 cbcr(vec3 c) {
  return vec2(dot(c, vec3(-0.168736, -0.331264, 0.5)) + 0.5,
              dot(c, vec3(0.5, -0.418688, -0.081312)) + 0.5);
}
float dist(vec2 uv) { return distance(cbcr(texture(u_tex, uv).rgb), u_key); }

void main() {
  vec4 c = texture(u_tex, v_uv);
  float d = (4.0 * distance(cbcr(c.rgb), u_key)
    + dist(v_uv + vec2(-u_texel.x, 0.0)) + dist(v_uv + vec2(u_texel.x, 0.0))
    + dist(v_uv + vec2(0.0, -u_texel.y)) + dist(v_uv + vec2(0.0, u_texel.y))) / 8.0;
  float a = smoothstep(u_similarity, u_similarity + max(u_smoothness, 1e-4), d);
  vec3 rgb = c.rgb;
  if (u_channel == 2) rgb.g = mix(rgb.g, min(rgb.g, max(rgb.r, rgb.b)), u_spill);
  else if (u_channel == 3) rgb.b = mix(rgb.b, min(rgb.b, max(rgb.r, rgb.g)), u_spill);
  else if (u_channel == 1) rgb.r = mix(rgb.r, min(rgb.r, max(rgb.g, rgb.b)), u_spill);
  float alpha = c.a * a;
  outColor = vec4(rgb * alpha, alpha);
}`

interface GlState {
  program: WebGLProgram
  texture: WebGLTexture
  vao: WebGLVertexArrayObject
  loc: Record<
    'tex' | 'key' | 'texel' | 'similarity' | 'smoothness' | 'spill' | 'channel',
    WebGLUniformLocation | null
  >
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)
  if (!sh) throw new Error('createShader failed')
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? ''
    gl.deleteShader(sh)
    throw new Error(`Chroma key shader failed to compile: ${log}`)
  }
  return sh
}

function initGl(gl: WebGL2RenderingContext): GlState {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT)
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
  const program = gl.createProgram()
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(
      `Chroma key program failed to link: ${gl.getProgramInfoLog(program) ?? ''}`,
    )
  }
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  const vao = gl.createVertexArray()
  const u = (name: string) => gl.getUniformLocation(program, name)
  return {
    program,
    texture,
    vao,
    loc: {
      tex: u('u_tex'),
      key: u('u_key'),
      texel: u('u_texel'),
      similarity: u('u_similarity'),
      smoothness: u('u_smoothness'),
      spill: u('u_spill'),
      channel: u('u_channel'),
    },
  }
}

function createGpuProcessor(): ChromaKeyProcessor | null {
  const canvas = makeCanvas(1, 1)
  let gl: WebGL2RenderingContext | null
  try {
    gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      antialias: false,
      depth: false,
      stencil: false,
    })
  } catch {
    gl = null
  }
  if (!gl) return null
  let state: GlState | null
  try {
    state = initGl(gl)
  } catch {
    return null
  }
  let lost = false
  let disposed = false
  const onLost = (e: Event) => {
    e.preventDefault() // allows restoration
    lost = true
    state = null
  }
  const onRestored = () => {
    lost = false
    try {
      if (gl) state = initGl(gl)
    } catch {
      state = null
    }
  }
  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)

  return {
    gpu: true,
    process(src, params, width, height) {
      if (disposed || lost || !gl || !state || gl.isContextLost()) return null
      const w = Math.max(1, Math.round(width))
      const h = Math.max(1, Math.round(height))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      const s = state
      const size = sourceSize(src)
      const key = parseHexColor(params.color)
      const [kcb, kcr] = rgbToCbCr(key[0] / 255, key[1] / 255, key[2] / 255)
      try {
        gl.viewport(0, 0, w, h)
        gl.useProgram(s.program)
        gl.bindVertexArray(s.vao)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, s.texture)
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          src as TexImageSource,
        )
        gl.uniform1i(s.loc.tex, 0)
        gl.uniform2f(s.loc.key, kcb, kcr)
        gl.uniform2f(
          s.loc.texel,
          1 / Math.max(1, size.width || w),
          1 / Math.max(1, size.height || h),
        )
        gl.uniform1f(s.loc.similarity, params.similarity)
        gl.uniform1f(s.loc.smoothness, params.smoothness)
        gl.uniform1f(s.loc.spill, params.spill)
        gl.uniform1i(s.loc.channel, spillChannel(key))
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      } catch {
        // e.g. a source that isn't ready (video with no frame) or is tainted.
        return null
      }
      return canvas
    },
    dispose() {
      if (disposed) return
      disposed = true
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      if (gl && state && !gl.isContextLost()) {
        gl.deleteTexture(state.texture)
        gl.deleteProgram(state.program)
        gl.deleteVertexArray(state.vao)
        gl.getExtension('WEBGL_lose_context')?.loseContext()
      }
      state = null
      gl = null
    },
  }
}

function createCpuProcessor(): ChromaKeyProcessor {
  let canvas: AnyCanvas | null = null
  let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null
  return {
    gpu: false,
    process(src, params, width, height) {
      const w = Math.max(1, Math.round(width))
      const h = Math.max(1, Math.round(height))
      if (!canvas) {
        canvas = makeCanvas(w, h)
        ctx = ctx2d(canvas)
      }
      if (!ctx) return null
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      try {
        ctx.clearRect(0, 0, w, h)
        ctx.drawImage(src, 0, 0, w, h)
        const img = ctx.getImageData(0, 0, w, h)
        keyImageData(img.data, w, h, params)
        ctx.putImageData(img, 0, 0)
      } catch {
        return null
      }
      return canvas
    },
    dispose() {
      if (canvas) canvas.width = canvas.height = 0
      canvas = null
      ctx = null
    },
  }
}

/**
 * Create a chroma-key processor: WebGL2 when available, otherwise the CPU
 * path. Keep one per renderer (preview / export) and reuse it for all layers.
 */
export function createChromaKeyProcessor(
  opts: { forceCpu?: boolean } = {},
): ChromaKeyProcessor {
  return (opts.forceCpu ? null : createGpuProcessor()) ?? createCpuProcessor()
}
