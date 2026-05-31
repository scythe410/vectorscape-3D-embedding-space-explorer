// Soft additive glowing-point shader. One pass, no per-frame CPU writes.
//
// Per-point attributes:
//   position    vec3   (built-in)
//   aColor      vec3   linear RGB in [0, 1]
//   aSize       float  world-space size (modulated by perspective in vertex)
//   aProbability float HDBSCAN-style membership in [0, 1]; 1.0 if not provided
//
// Uniforms:
//   uTime          driven from useFrame — animates a faint pulse for cores
//   uPixelRatio    devicePixelRatio so points stay crisp on retina
//   uFogColor      sampled from scene.fog (we mirror it explicitly because
//                  ShaderMaterial doesn't get THREE.Fog auto-injection)
//   uFogDensity    FogExp2 density
//   uMinBrightness floor on probability modulation so outliers don't fully vanish

export const POINTS_VERTEX = /* glsl */ `
  precision highp float;

  attribute vec3  aColor;
  attribute float aSize;
  attribute float aProbability;

  uniform float uPixelRatio;
  uniform float uSizeScale;

  varying vec3  vColor;
  varying float vProbability;
  varying float vFogDepth;

  void main() {
    vColor        = aColor;
    vProbability  = aProbability;

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vFogDepth = -mvPosition.z;

    // Perspective-correct point size. The 300.0 constant matches the spike's
    // visual scale — tune for art, not for correctness.
    gl_PointSize = aSize * uSizeScale * uPixelRatio * (300.0 / vFogDepth);
    gl_PointSize = clamp(gl_PointSize, 1.0, 64.0);
    gl_Position  = projectionMatrix * mvPosition;
  }
`;

export const POINTS_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform vec3  uFogColor;
  uniform float uFogDensity;
  uniform float uMinBrightness;
  // Star-sprite shape. uCoreSharpness in [0, 1] — 0 is all halo, 1 is a hard
  // pin-prick. uHaloStrength scales the soft outer glow. Together they let
  // points stay crisp even when each sprite covers 40+ pixels (otherwise a
  // single smoothstep falloff reads as defocused bokeh at large sizes).
  uniform float uCoreSharpness;
  uniform float uHaloStrength;

  varying vec3  vColor;
  varying float vProbability;
  varying float vFogDepth;

  void main() {
    vec2  uv = gl_PointCoord - 0.5;
    float r  = length(uv);
    if (r > 0.5) discard;

    // Hard-edged core that scales as a *shape*, not a pixel-spread gradient.
    // corePeak is where the core's solid portion ends; the smoothstep up to
    // 0.5 antialiases the disc edge. With uCoreSharpness=1 the core is a
    // tight bright dot regardless of how many pixels gl_PointSize covers.
    float corePeak = mix(0.0, 0.45, uCoreSharpness);
    float core = smoothstep(0.5, corePeak, r);

    // Soft halo for the additive glow. Squared so it concentrates near the
    // center and falls off cleanly, which keeps cluster cores readable when
    // dozens of halos overlap.
    float halo = smoothstep(0.5, 0.0, r);
    halo = halo * halo;

    // Probability only drives alpha (so outliers read as dust, members read
    // as solid). Color stays full-intensity; the data layer puts HDR (>1.0)
    // into cluster cores so bloom can actually bite.
    float prob  = clamp(vProbability, 0.0, 1.0);
    float shape = clamp(core + halo * uHaloStrength, 0.0, 1.0);
    float alpha = shape * mix(uMinBrightness, 1.0, prob);

    // FogExp2 attenuates alpha only — additive blending should fade out into
    // the background, not lerp toward the fog color (that washes color out).
    float fogFactor = exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
    fogFactor = clamp(fogFactor, 0.0, 1.0);

    gl_FragColor = vec4(vColor, alpha * fogFactor);
  }
`;
