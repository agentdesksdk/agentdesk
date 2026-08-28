import { defineConfig } from "vite";

export default defineConfig({
  base: "/p0/",
  server: {
    host: "127.0.0.1",
    port: 4177,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
});
