import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 8088,
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
  test: {
    include: ["{src,server}/**/*.test.{ts,tsx}"],
  },
});
