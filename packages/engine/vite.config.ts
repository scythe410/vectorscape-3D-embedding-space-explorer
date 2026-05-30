import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "VectorScapeEngine",
      fileName: (format) => (format === "es" ? "engine.js" : "engine.cjs"),
      formats: ["es", "cjs"],
    },
    rollupOptions: {
      external: ["react", "react/jsx-runtime", "three"],
      output: {
        globals: {
          react: "React",
          three: "THREE",
        },
      },
    },
    sourcemap: true,
  },
});
