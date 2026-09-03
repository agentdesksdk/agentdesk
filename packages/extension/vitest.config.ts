import { defineConfig } from "vitest/config";

// One jsdom window stands for the DOM the page and the isolated content
// script share. The page's origin is fixed so an origin check has
// something real to compare against.
export default defineConfig({
  test: {
    environment: "jsdom",
    environmentOptions: { jsdom: { url: "https://shop.example/orders/10428" } },
    include: ["tests/**/*.test.ts"],
  },
});
