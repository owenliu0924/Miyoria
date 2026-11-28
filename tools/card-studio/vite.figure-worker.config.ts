import { defineConfig } from "vite";

// Her figure's engine as a worker (`src/figure-worker.ts`): one classic script the Core serves
// beside the bundle, which starts it with the page's canvas. Classic, not a module: Cubism Core
// is a classic script that sets a global, and `importScripts` is how a worker runs one.
export default defineConfig({
  build: {
    outDir: "dist/figure",
    emptyOutDir: false,
    target: "es2022",
    minify: "esbuild",
    sourcemap: false,
    copyPublicDir: false,
    rollupOptions: {
      input: "src/figure-worker.ts",
      output: { format: "iife", entryFileNames: "figure-worker.js", inlineDynamicImports: true },
    },
  },
});
