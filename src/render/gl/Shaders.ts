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

uniform mat4 uViewProj;

out vec2 vUv;
out float vLayer;
out float vFaceShade;
out vec3 vWorld;

void main() {
  vUv = aUv;
  vLayer = aLayer;
  vFaceShade = aFaceShade;
  vWorld = aPos;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

export const WORLD_FS = /* glsl */ `#version 300 es
${COMMON}

in vec2 vUv;
in float vLayer;
in float vFaceShade;
in vec3 vWorld;

uniform sampler2DArray uAtlas;
/** Baked lighting, one texel per tile, sampled bilinearly. */
uniform sampler2D uLightmap;
uniform vec2 uMapSize;

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
  }

  // --- transient flash ---------------------------------------------------
  float flash = uFlash > 0.0 ? uFlash / (1.0 + dist * dist * 0.09) : 0.0;

  float light = (baked + torch + flash) * uExposure * vFaceShade;

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
  vec3 scene = texture(uScene, vUv).rgb;
  vec3 bloom = texture(uBloom, vUv).rgb;
  vec3 color = scene + bloom * uBloomStrength;

  color = tonemap(color * uExposure);

  // Grade: lift the shadows slightly towards blue and pull the highlights
  // towards warm. A neutral image reads as untreated footage; this is the
  // cheapest thing that makes it look shot rather than rendered.
  float lum = dot(color, vec3(0.299, 0.587, 0.114));
  color = mix(color, color * vec3(0.94, 0.98, 1.10), (1.0 - lum) * 0.35);
  color = mix(color, color * vec3(1.06, 1.01, 0.92), lum * 0.30);

  // Vignette.
  vec2 centred = vUv - 0.5;
  float vig = 1.0 - dot(centred, centred) * uVignette;
  color *= clamp(vig, 0.0, 1.0);

  // Grain, strongest in the mid-tones where a sensor is actually noisiest.
  float grain = (hash21(vUv * 1024.0 + uTime) - 0.5);
  color += grain * uGrain * (0.35 + (1.0 - abs(lum - 0.5) * 2.0) * 0.65);

  // Full-screen state overlays - damage red, exhaustion dark.
  color = mix(color, uOverlay.rgb, uOverlay.a);

  fragColor = vec4(color, 1.0);
}
`;
