import { defineConfig } from "vite";
import { resolve } from "node:path";

// Two-mode config:
//   - default (no `--mode lib`): Vite dev server / SPA build for the demo harness.
//   - --mode lib: emits the engine as a dual ESM/CJS library; react/three are external.
export default defineConfig(({ mode }) => {
  if (mode === "lib") {
    return {
      build: {
        lib: {
          entry: resolve(__dirname, "src/index.ts"),
          name: "VectorScapeEngine",
          fileName: (format) => (format === "es" ? "engine.js" : "engine.cjs"),
          formats: ["es", "cjs"],
        },
        rollupOptions: {
          external: [
            "react",
            "react/jsx-runtime",
            "react-dom",
            "three",
            "@react-three/fiber",
            "@react-three/drei",
            "@react-three/postprocessing",
          ],
          output: {
            globals: {
              react: "React",
              three: "THREE",
            },
          },
        },
        sourcemap: true,
      },
    };
  }

  // Demo dev/build.
  return {
    root: resolve(__dirname, "demo"),
    server: { port: 5173, open: false },
    build: {
      outDir: resolve(__dirname, "dist-demo"),
      emptyOutDir: true,
    },
  };
});
