import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ["var(--font-display)", "ui-serif", "Georgia", "serif"],
        body: ["var(--font-body)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "Menlo", "monospace"],
      },
      colors: {
        // accent — single warm signal per design.md §3.
        accent: {
          DEFAULT: "#f4c879",
          warm: "#f9b870",
          deep: "#c98a3b",
        },
      },
    },
  },
  plugins: [],
};

export default config;
