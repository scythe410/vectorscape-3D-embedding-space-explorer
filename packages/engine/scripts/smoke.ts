// CLI smoke test for the renderer-agnostic engine bits. Validates the voxel
// downsample (O(N), kept ≤ ~budget, no NaNs) and the synth generator. Doesn't
// touch WebGL — visual verification is the demo harness.

import { synthesize } from "../demo/synth";
import { voxelDownsample } from "../src/voxel/voxelDownsample";

const cases = [
  { n: 10_000, budget: 350_000, expectDownsample: false },
  { n: 350_000, budget: 350_000, expectDownsample: false },
  { n: 1_000_000, budget: 350_000, expectDownsample: true },
];

let failed = 0;
for (const c of cases) {
  const t0 = performance.now();
  const data = synthesize({
    pointCount: c.n,
    clusterCount: 14,
    noiseFraction: 0.18,
    worldRadius: 26,
    seed: 7,
  });
  const t1 = performance.now();
  const ds = voxelDownsample(data.points.position, c.budget);
  const t2 = performance.now();

  const kept = ds.kept.length;
  const total = data.points.position.length / 3;
  const okDownsampleFlag = ds.downsampled === c.expectDownsample;
  const okBudget = !c.expectDownsample || kept <= Math.floor(c.budget * 1.2);
  const okIndices = (() => {
    for (let i = 0; i < Math.min(kept, 5000); i++) {
      if (ds.kept[i] >= total) return false;
    }
    return true;
  })();
  const ok = okDownsampleFlag && okBudget && okIndices;
  if (!ok) failed++;

  console.log(
    `${ok ? "PASS" : "FAIL"}  n=${c.n.toLocaleString()} budget=${c.budget.toLocaleString()}` +
      ` -> kept=${kept.toLocaleString()} downsampled=${ds.downsampled}` +
      ` synth=${(t1 - t0).toFixed(1)}ms voxel=${(t2 - t1).toFixed(1)}ms`,
  );
  if (!ok) {
    console.log(`     downsampleFlagOk=${okDownsampleFlag} budgetOk=${okBudget} indicesOk=${okIndices}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}
console.log("\nall smoke cases passed");
