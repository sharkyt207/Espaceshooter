/**
 * Shaders.
 *
 * The lighting model is the same one the software renderer uses - baked
 * lightmap, additive torch cone, muzzle flash, exponential-squared fog - so
 * the two renderers agree about how bright and how visible everything is.
 * That matters beyond looks: the AI's spotting model reads the same lightmap,
 * so a shadow has to be a shadow in both.
 *
 * What the GPU buys is that all of it becomes **per pixel** instead of per
 * column and per row, and that texture sampling gets mipmaps, trilinear
 * filtering and anisotropy for free. Those three are most of the difference
 * between the two images.
 */

const COMMON = /* glsl */ `
precision highp float;
precision highp sampler2DArray;
`;

// ===========================================================================
// World
// ===========================================================================

export const WORLD_VS = /* glsl */ `#version 300 es
${COMMON}

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUv;
layout(location = 2) in float aLayer;
layout(location = 3) in float aFaceShade;
layout(location = 4) in float aAxis;
layout(location = 5) in float aAo;

uniform mat4 uViewProj;

out vec2 vUv;
out float vLayer;
out float vFaceShade;
out vec3 vWorld;
out vec3 vNormal;
out vec3 vTangent;
out float vAo;

/**
 * The six face orientations, expanded from the index the mesh carries.
 *
 * Every face in this world is axis-aligned, so a normal and a tangent are two
 * lookups rather than two attributes - six floats per vertex saved across a
 * mesh of some seventy thousand of them.
 *
 * The tangent has to follow the same direction the texture's u axis runs, or
 * the normal map's bumps light from the wrong side. That is why each case is
 * written out to match how WorldMesh winds that particular face.
 */
void axisFrame(float axis, out vec3 n, out vec3 t) {
  int a = int(axis + 0.5);
  if (a == 0)      { n = vec3(0.0, 0.0, 1.0);  t = vec3(1.0, 0.0, 0.0); }
  else if (a == 1) { n = vec3(0.0, 0.0, -1.0); t = vec3(1.0, 0.0, 0.0); }
  else if (a == 2) { n = vec3(-1.0, 0.0, 0.0); t = vec3(0.0, -1.0, 0.0); }
  else if (a == 3) { n = vec3(1.0, 0.0, 0.0);  t = vec3(0.0, 1.0, 0.0); }
  else if (a == 4) { n = vec3(0.0, -1.0, 0.0); t = vec3(1.0, 0.0, 0.0); }
  else             { n = vec3(0.0, 1.0, 0.0);  t = vec3(-1.0, 0.0, 0.0); }
}

void main() {
  vUv = aUv;
  vLayer = aLayer;
  vFaceShade = aFaceShade;
  vWorld = aPos;
  vAo = aAo;
  axisFrame(aAxis, vNormal, vTangent);
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

export const WORLD_FS = /* glsl */ `#version 300 es
${COMMON}

in vec2 vUv;
in float vLayer;
in float vFaceShade;
in vec3 vWorld;
in vec3 vNormal;
in vec3 vTangent;
in float vAo;

uniform sampler2DArray uAtlas;
/** Tangent-space normals, same layers and mip layout as the atlas. */
uniform sampler2DArray uNormals;
/** Baked lighting, one texel per tile, sampled bilinearly. */
uniform sampler2D uLightmap;
uniform vec2 uMapSize;

/** Direction the key light comes *from*, and how much of the light it is. */
uniform vec3 uSunDir;
uniform float uSunAmount;

/** Bands to quantise the lighting into. 0 leaves it continuous. */
uniform float uCelBands;
/** Floor under the lowest band, so shadows are dark rather than empty. */
uniform float uCelFloor;

uniform vec3 uCamPos;
uniform vec3 uCamForward;

uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uViewDistance;
uniform float uExposure;

/** Transient omnidirectional light at the camera: muzzle flash, lightning. */
uniform float uFlash;

/** Weapon light: intensity, range, cos(inner), cos(outer). */
uniform vec4 uTorch;

/** Alpha below this is discarded rather than blended. */
uniform float uAlphaCutoff;

out vec4 fragColor;

void main() {
  vec4 texel = texture(uAtlas, vec3(vUv, vLayer));
  if (texel.a < uAlphaCutoff) discard;

  // --- surface normal ----------------------------------------------------
  //
  // The tangent frame is rebuilt per fragment from the interpolated face
  // vectors. They are constant across a face, so nothing is lost by
  // interpolating them, and this keeps the vertex format down to one float for
  // the orientation.
  vec3 faceN = normalize(vNormal);
  vec3 faceT = normalize(vTangent);
  vec3 faceB = cross(faceN, faceT);
  vec3 tn = texture(uNormals, vec3(vUv, vLayer)).xyz * 2.0 - 1.0;
  vec3 N = normalize(faceT * tn.x + faceB * tn.y + faceN * tn.z);

  // --- baked light -------------------------------------------------------
  //
  // Sampled bilinearly across tile centres, which is the single most visible
  // difference from the software renderer: light varies smoothly over a floor
  // instead of stepping at every tile boundary.
  vec2 lightUv = (vWorld.xy + 0.5) / uMapSize;
  float baked = texture(uLightmap, lightUv).r;

  vec3 toFrag = vWorld - uCamPos;
  float dist = length(toFrag);
  vec3 dir = toFrag / max(dist, 0.0001);

  // --- torch -------------------------------------------------------------
  float torch = 0.0;
  if (uTorch.x > 0.0) {
    float cosAngle = dot(dir, uCamForward);
    // Smooth between the hot spot and the edge of the spill.
    float cone = smoothstep(uTorch.w, uTorch.z, cosAngle);
    float falloff = 1.0 - clamp(dist / uTorch.y, 0.0, 1.0);
    // Near ramp so the beam does not light the player's own feet.
    float near = clamp(dist, 0.0, 1.0);
    torch = uTorch.x * cone * falloff * falloff * near;
    // The beam comes from the camera, so -dir points back at the light.
    // Without this the torch flattens every surface it touches, which is the
    // opposite of what a hand light does: it is the one light in this scene
    // whose direction the player controls, and raking it across a brick wall
    // should show the courses.
    torch *= mix(0.35, 1.0, max(dot(N, -dir), 0.0));
  }

  // --- transient flash ---------------------------------------------------
  float flash = uFlash > 0.0 ? uFlash / (1.0 + dist * dist * 0.09) : 0.0;

  // --- directional key ---------------------------------------------------
  //
  // The baked lightmap is ambient: it says how much light reaches a tile, not
  // where from. Ambient light lands identically on every facing, so on its own
  // a normal map changes nothing at all - the bumps are there and invisible.
  // This is the term that makes them show.
  //
  // Wrapped rather than clamped at zero. A surface turned away from the sun is
  // still lit by the sky, and a hard terminator across a wall reads as a bug
  // rather than as shadow.
  float ndl = dot(N, uSunDir);
  float key = ndl * 0.5 + 0.5;
  // Centred on 1 so this adds shape without changing overall exposure - which
  // also keeps the two renderers comparable in brightness.
  float directional = 1.0 + uSunAmount * (key - 0.5) * 1.25;

  // Occlusion is a statement about ambient light, so it applies in full to the
  // baked term and only partly to the torch and the flash: a muzzle flash does
  // reach into a corner, it just does not fill it.
  float ambientOcclusion = vAo;
  float directOcclusion = mix(0.65, 1.0, vAo);

  float light =
    (baked * directional * ambientOcclusion + (torch + flash) * directOcclusion) *
    uExposure * vFaceShade;

  // --- cel banding --------------------------------------------------------
  //
  // Quantising here rather than in the composite is the whole trick. Light is
  // banded before it multiplies the texture, so the steps fall on the *form* -
  // the terminator wrapping around a crate, the edge of the torch cone - and
  // the material underneath keeps all of its detail. Posterising the finished
  // image instead bands the albedo too, and the result reads as a colour
  // reduction rather than as drawn shading.
  //
  // The band edges are softened by roughly one pixel's worth of gradient, so
  // they alias no worse than the geometry does.
  if (uCelBands > 0.0) {
    float scaled = light * uCelBands;
    float lower = floor(scaled);
    float frac = scaled - lower;
    float w = fwidth(scaled) * 0.5;
    light = (lower + smoothstep(0.5 - w, 0.5 + w, frac)) / uCelBands;
    light = uCelFloor + light * (1.0 - uCelFloor);
  }

  vec3 color = texel.rgb * light;

  // --- fog ---------------------------------------------------------------
  //
  // Exponential-squared, matching the software renderer's curve exactly so
  // both agree about how far you can see.
  float d = min(dist, uViewDistance) * uFogDensity;
  float fog = 1.0 - exp(-d * d * 1.15 - d * 0.35);
  color = mix(color, uFogColor, clamp(fog, 0.0, 1.0));

  fragColor = vec4(color, texel.a);
}
`;

// ===========================================================================
// Sky
// ===========================================================================

export const SKY_VS = /* glsl */ `#version 300 es
${COMMON}
layout(location = 0) in vec2 aPos;
out vec2 vNdc;
void main() {
  vNdc = aPos;
  gl_Position = vec4(aPos, 1.0, 1.0);
}
`;

export const SKY_FS = /* glsl */ `#version 300 es
${COMMON}
in vec2 vNdc;

uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform float uHorizonNdc;
uniform float uTime;
uniform float uYaw;

out vec4 fragColor;

/** Cheap value noise, enough for cloud banding. */
float hash(float n) { return fract(sin(n) * 43758.5453); }
float noise(float x) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash(i), hash(i + 1.0), f);
}

void main() {
  // Blend from horizon to zenith over whatever part of the screen is above
  // the horizon line, so the gradient stays anchored as the player looks up.
  float t = clamp((vNdc.y - uHorizonNdc) / max(0.001, 1.0 - uHorizonNdc), 0.0, 1.0);
  vec3 sky = mix(uSkyHorizon, uSkyTop, t);

  // Banding that parallaxes with the heading. Subtle - an overcast sky is
  // mostly featureless, and anything stronger reads as a texture error.
  float band = noise(uYaw * 3.0 + vNdc.x * 4.0 + uTime * 0.05) * 0.5
             + noise(uYaw * 7.0 + vNdc.x * 11.0 - uTime * 0.03) * 0.5;
  sky *= 1.0 + (band - 0.5) * 0.16 * (1.0 - t * 0.5);

  fragColor = vec4(sky, 1.0);
}
`;

// ===========================================================================
// Sprites
// ===========================================================================

export const SPRITE_VS = /* glsl */ `#version 300 es
${COMMON}

/** Unit quad corner, -0.5..0.5 in x, 0..1 in y. */
layout(location = 0) in vec2 aCorner;
/** Per-instance: world x, y, base z, height in tile units. */
layout(location = 1) in vec4 aInstance;
/** Per-instance: atlas rect (u0, v0, u1, v1). */
layout(location = 2) in vec4 aRect;
/** Per-instance: tint rgb + alpha. */
layout(location = 3) in vec4 aTint;
/** Per-instance: width in tile units. Kept separate from height because
    sprite frames are not square and the aspect is per frame. */
layout(location = 4) in float aWidth;

uniform mat4 uViewProj;
uniform vec3 uCamRight;

out vec2 vUv;
out vec4 vTint;
out vec3 vWorld;

void main() {
  // Billboards rotate about the world up axis only. Rotating about the view
  // axis as well would make figures lean as the player looks up, which reads
  // as a bug rather than as depth.
  vec3 pos = vec3(aInstance.xy, aInstance.z)
    + uCamRight * (aCorner.x * aWidth)
    + vec3(0.0, 0.0, aCorner.y * aInstance.w);

  vWorld = pos;
  vUv = mix(aRect.xy, aRect.zw, vec2(aCorner.x + 0.5, 1.0 - aCorner.y));
  vTint = aTint;
  gl_Position = uViewProj * vec4(pos, 1.0);
}
`;

export const SPRITE_FS = /* glsl */ `#version 300 es
${COMMON}

in vec2 vUv;
in vec4 vTint;
in vec3 vWorld;

uniform sampler2D uSprites;
uniform sampler2D uLightmap;
uniform vec2 uMapSize;
uniform vec3 uCamPos;
uniform vec3 uCamForward;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uViewDistance;
uniform float uExposure;
uniform float uFlash;
uniform vec4 uTorch;
/** 1 for lit sprites, 0 for additive effects that supply their own light. */
uniform float uLit;

out vec4 fragColor;

void main() {
  vec4 texel = texture(uSprites, vUv);
  if (texel.a < 0.04) discard;

  vec3 color = texel.rgb * vTint.rgb;

  if (uLit > 0.5) {
    vec2 lightUv = (vWorld.xy + 0.5) / uMapSize;
    float baked = texture(uLightmap, lightUv).r;

    vec3 toFrag = vWorld - uCamPos;
    float dist = length(toFrag);
    vec3 dir = toFrag / max(dist, 0.0001);

    float torch = 0.0;
    if (uTorch.x > 0.0) {
      float cone = smoothstep(uTorch.w, uTorch.z, dot(dir, uCamForward));
      float falloff = 1.0 - clamp(dist / uTorch.y, 0.0, 1.0);
      torch = uTorch.x * cone * falloff * falloff * clamp(dist, 0.0, 1.0);
    }
    float flash = uFlash > 0.0 ? uFlash / (1.0 + dist * dist * 0.09) : 0.0;

    color *= (baked + torch + flash) * uExposure;

    float d = min(dist, uViewDistance) * uFogDensity;
    float fog = 1.0 - exp(-d * d * 1.15 - d * 0.35);
    color = mix(color, uFogColor, clamp(fog, 0.0, 1.0));
  }

  fragColor = vec4(color, texel.a * vTint.a);
}
`;

// ===========================================================================
// Post processing
// ===========================================================================

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
${COMMON}
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

/** Keep only what is above the threshold, at half resolution. */
export const BRIGHT_FS = /* glsl */ `#version 300 es
${COMMON}
in vec2 vUv;
uniform sampler2D uSource;
uniform float uThreshold;
out vec4 fragColor;

void main() {
  vec3 c = texture(uSource, vUv).rgb;
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  // Soft knee: a hard threshold makes bloom pop in and out as a surface
  // crosses it, which is far more distracting than a slightly wider glow.
  float knee = uThreshold * 0.5;
  float soft = clamp((lum - uThreshold + knee) / max(knee * 2.0, 0.0001), 0.0, 1.0);
  float contribution = max(soft * soft * (lum - uThreshold + knee) * 0.5, lum - uThreshold);
  fragColor = vec4(c * max(contribution, 0.0) / max(lum, 0.0001), 1.0);
}
`;

/** Separable 9-tap Gaussian; `uDirection` is one texel in x or in y. */
export const BLUR_FS = /* glsl */ `#version 300 es
${COMMON}
in vec2 vUv;
uniform sampler2D uSource;
uniform vec2 uDirection;
out vec4 fragColor;

void main() {
  // Linear-sampled Gaussian: five taps give the reach of nine because each
  // sample sits between two texels and the hardware does the first blend.
  vec3 sum = texture(uSource, vUv).rgb * 0.227027;
  vec2 off1 = uDirection * 1.3846153846;
  vec2 off2 = uDirection * 3.2307692308;
  sum += texture(uSource, vUv + off1).rgb * 0.3162162162;
  sum += texture(uSource, vUv - off1).rgb * 0.3162162162;
  sum += texture(uSource, vUv + off2).rgb * 0.0702702703;
  sum += texture(uSource, vUv - off2).rgb * 0.0702702703;
  fragColor = vec4(sum, 1.0);
}
`;

/** Combine, tone map, grade, grain and vignette in one pass. */
export const COMPOSITE_FS = /* glsl */ `#version 300 es
${COMMON}
in vec2 vUv;

uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStrength;
uniform float uExposure;
uniform float uGrain;
uniform float uVignette;
uniform float uTime;
/** Screen tint and strength: red for damage, dark for exhaustion. */
uniform vec4 uOverlay;

// --- style grade ---------------------------------------------------------
uniform vec3 uShadowTint;
uniform float uShadowAmount;
uniform vec3 uHighlightTint;
uniform float uHighlightAmount;
uniform float uSaturation;
uniform float uContrast;
uniform float uAberration;
uniform float uScanlines;

/** Depth buffer of the scene, for finding silhouettes. */
uniform sampler2D uDepth;

/**
 * Distance in metres, recovered from the depth buffer.
 *
 * The buffer is very nearly a scaled reciprocal of distance, so almost all of
 * its precision sits near the camera. Converting back gives a value with a
 * physical meaning, which is what lets the edge test below use a threshold in
 * metres rather than in buffer units.
 */
float viewDepth(vec2 uv) {
  float z = texture(uDepth, uv).r * 2.0 - 1.0;
  const float near = 0.02;
  const float far = 288.0;
  return (2.0 * near * far) / (far + near - z * (far - near));
}
uniform float uOutline;
uniform float uOutlineWidth;
uniform vec3 uOutlineColor;
uniform float uHalftone;
uniform float uPosterize;
/** Scene target size in pixels, so screen-space effects can step by texel. */
uniform vec2 uResolution;

out vec4 fragColor;


float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

/**
 * ACES filmic curve, fitted.
 *
 * The point of a curve rather than a clamp: additive light - lamps plus torch
 * plus muzzle flash - regularly exceeds white, and clipping collapses all of
 * it to the same flat value. A shoulder keeps the structure in the highlight,
 * which is what makes a bright scene look photographed rather than blown out.
 */
vec3 tonemap(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec2 centred = vUv - 0.5;

  // --- chromatic aberration ----------------------------------------------
  //
  // A lens cannot bring every wavelength to focus at the same point, and the
  // error grows with distance from the axis - so this scales with the radius
  // and is nothing at all in the middle, where the player is aiming.
  //
  // The scene is sampled three times when it is enabled and once when it is
  // not. The branch is uniform across the draw, so it costs nothing on any
  // GPU that matters.
  vec3 scene;
  if (uAberration > 0.0) {
    float r2 = dot(centred, centred);
    vec2 offset = centred * r2 * uAberration * 0.06;
    scene = vec3(
      texture(uScene, vUv + offset).r,
      texture(uScene, vUv).g,
      texture(uScene, vUv - offset).b
    );
  } else {
    scene = texture(uScene, vUv).rgb;
  }

  vec3 bloom = texture(uBloom, vUv).rgb;
  vec3 color = scene + bloom * uBloomStrength;

  color = tonemap(color * uExposure);

  // --- grade ---------------------------------------------------------------
  //
  // Split-toning: the shadows and the highlights are pulled towards different
  // colours. This is the single cheapest thing that makes an image look shot
  // rather than rendered, because no real film or sensor is neutral at both
  // ends. Which way each end goes is what most distinguishes the three styles.
  float lum = dot(color, vec3(0.299, 0.587, 0.114));
  color = mix(color, color * uShadowTint, (1.0 - lum) * uShadowAmount);
  color = mix(color, color * uHighlightTint, lum * uHighlightAmount);

  // Saturation, against the luminance the eye actually weights.
  color = mix(vec3(dot(color, vec3(0.299, 0.587, 0.114))), color, uSaturation);

  // Contrast, pivoted on mid grey so it shapes the image without changing how
  // bright it is overall.
  color = (color - 0.5) * uContrast + 0.5;

  // Vignette.
  float vig = 1.0 - dot(centred, centred) * uVignette;
  color *= clamp(vig, 0.0, 1.0);

  // Scanlines. Tied to the fragment rather than to the texture coordinate so
  // the pattern stays fixed to the screen, which is what a display artefact
  // does - one locked to the world would swim as the player turns.
  if (uScanlines > 0.0) {
    float line = sin(gl_FragCoord.y * 3.14159) * 0.5 + 0.5;
    color *= 1.0 - line * uScanlines;
  }

  // Grain, strongest in the mid-tones where a sensor is actually noisiest.
  float grain = (hash21(vUv * 1024.0 + uTime) - 0.5);
  color += grain * uGrain * (0.35 + (1.0 - abs(lum - 0.5) * 2.0) * 0.65);

  // --- ink ----------------------------------------------------------------
  //
  // A silhouette is a place where depth jumps. Four taps in a cross, and the
  // line is drawn where the largest jump exceeds a threshold that scales with
  // the distance itself - without that scaling, a far wall's own slope reads
  // as an edge and the whole background fills in solid.
  if (uOutline > 0.0) {
    vec2 texel = uOutlineWidth / uResolution;

    // A silhouette is a break in the surface, and the trick is measuring that
    // without also flagging a floor seen at a grazing angle - which recedes
    // steeply and is not an edge anywhere.
    //
    // Neither obvious approach works. A first difference measures slope, so
    // the ground inks in solid. A second difference of *distance* is not zero
    // on a plane either, because distance is not linear across the screen -
    // that was the second attempt, and it drew the tile grid in perspective.
    //
    // Reciprocal distance is the quantity that *is* linear in screen space for
    // any plane, at any angle. So the centre sample of a flat surface sits
    // exactly halfway between its neighbours in 1/z, however steeply it
    // recedes, and only a genuine discontinuity breaks that.
    float zc = viewDepth(vUv);
    float invC = 1.0 / max(zc, 0.01);
    float invL = 1.0 / max(viewDepth(vUv - vec2(texel.x, 0.0)), 0.01);
    float invR = 1.0 / max(viewDepth(vUv + vec2(texel.x, 0.0)), 0.01);
    float invU = 1.0 / max(viewDepth(vUv - vec2(0.0, texel.y)), 0.01);
    float invD = 1.0 / max(viewDepth(vUv + vec2(0.0, texel.y)), 0.01);

    float d = abs(invL + invR - 2.0 * invC) + abs(invU + invD - 2.0 * invC);

    // Multiplying by the square of the distance converts that back into
    // metres: a step of one metre reads as roughly 1.0 whether it is three
    // metres away or forty. So the threshold is a real size - edges bigger
    // than about fifteen centimetres get inked - rather than a number tuned
    // against one particular scene.
    float metric = d * zc * zc;
    float edge = smoothstep(0.15, 0.45, metric);
    color = mix(color, uOutlineColor, edge * uOutline);
  }

  // --- halftone -----------------------------------------------------------
  //
  // Ben-day dots, and only in the shadows, which is where a printer actually
  // used them: the lit side of a panel is solid ink and the shaded side is a
  // screen of dots. Rotated off-axis so the grid does not line up with the
  // pixel rows and moire.
  if (uHalftone > 0.0) {
    float lum2 = dot(color, vec3(0.299, 0.587, 0.114));
    vec2 rotated = mat2(0.87, -0.5, 0.5, 0.87) * (vUv * uResolution);
    vec2 cell = fract(rotated / 5.0) - 0.5;
    // Dot radius grows as the pixel darkens - that is what carries the tone.
    float dot1 = smoothstep(0.42, 0.18, length(cell) - (1.0 - lum2) * 0.30);
    color = mix(color, color * 0.55, dot1 * uHalftone * (1.0 - smoothstep(0.25, 0.65, lum2)));
  }

  // --- posterise ----------------------------------------------------------
  if (uPosterize > 0.0) {
    color = floor(color * uPosterize + 0.5) / uPosterize;
  }

  // Full-screen state overlays - damage red, exhaustion dark.
  color = mix(color, uOverlay.rgb, uOverlay.a);

  fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;
