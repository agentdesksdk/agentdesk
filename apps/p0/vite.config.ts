import { defineConfig } from "vite";

export default defineConfig({
  base: "/p0/",
  build: {
    rollupOptions: {
      // Two entries: the compatibility harness and the eval page, which
      // imports the eval's own catalog from scripts/evals rather than a copy.
      input: {
        index: "index.html",
        eval: "eval.html",
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4177,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
});
