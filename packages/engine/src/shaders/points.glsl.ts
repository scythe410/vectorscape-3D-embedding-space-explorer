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
    gl_PointSize = aSize * uPixelRatio * (300.0 / vFogDepth);
    gl_Position  = projectionMatrix * mvPosition;
  }
`;

export const POINTS_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform vec3  uFogColor;
  uniform float uFogDensity;
  uniform float uMinBrightness;

  varying vec3  vColor;
  varying float vProbability;
  varying float vFogDepth;

  void main() {
    // Radial soft falloff in the sprite. discard outside the disc so the
    // additive blend doesn't square-stamp.
    vec2  uv = gl_PointCoord - 0.5;
    float r  = length(uv);
    if (r > 0.5) discard;

    // Gaussian-ish profile. ^3 keeps the highlight punchy.
    float soft = smoothstep(0.5, 0.0, r);
    soft = soft * soft * soft;

    // Probability shapes the look: confident cluster cores glow; outliers
    // fade to a faint dust. Brightness floors at uMinBrightness so we still
    // see structure outside the cores.
    float prob = clamp(vProbability, 0.0, 1.0);
    float bright = mix(uMinBrightness, 1.0, prob);
    // Alpha drops faster than brightness so low-probability points read as
    // visual fog — present, but not asserting.
    float alpha  = soft * mix(uMinBrightness * 0.4, 1.0, prob * prob);

    // FogExp2 by hand so additive blending still respects depth.
    float fogFactor = exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
    fogFactor = clamp(fogFactor, 0.0, 1.0);

    vec3 lit  = vColor * bright * (0.9 + 0.1 * sin(uTime * 0.6 + vProbability * 6.0));
    vec3 outc = mix(uFogColor, lit, fogFactor);

    gl_FragColor = vec4(outc, alpha * fogFactor);
  }
`;
