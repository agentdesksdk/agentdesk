import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/rescue/",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4182,
  },
  preview: {
    host: "127.0.0.1",
    port: 4183,
  },
});
