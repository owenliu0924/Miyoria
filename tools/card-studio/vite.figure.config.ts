import { defineConfig } from "vite";

// Her figure for the room's page (`src/figure.ts`): one ES module the Core serves to a member's
// browser (`/api/member/room/figure/...`), Live2D's Web Framework bundled in. Cubism Core is not:
// the Core serves `vendor/live2dcubismcore.min.js` beside it, and the bundle loads it.
export default defineConfig({
  build: {
    outDir: "dist/figure",
    emptyOutDir: true,
    target: "es2022",
    minify: "esbuild",
    sourcemap: false,
    copyPublicDir: false,
    // Not library mode, which leaves an ES module unminified: one entry that keeps its exports.
    rollupOptions: {
      input: "src/figure.ts",
      preserveEntrySignatures: "exports-only",
      output: { format: "es", entryFileNames: "figure.js", inlineDynamicImports: true },
    },
  },
});
