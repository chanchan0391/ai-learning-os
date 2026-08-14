import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const previewSecurityHeaders = {
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

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
    headers: previewSecurityHeaders,
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
  test: {
    include: ["{src,server}/**/*.test.{ts,tsx}"],
  },
});
