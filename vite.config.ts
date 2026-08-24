/// <reference types="vitest/config" />
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// Dev API server sits on 5750 (prod runs on 8010 so the live site keeps
// serving while you develop). Vite dev 5751, preview 6750 — family scheme.
const API = "http://127.0.0.1:5750"

export default defineConfig({
  root: "client",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    port: 5751,
    strictPort: true,
    proxy: {
      "/api": API,
      "/healthz": API,
    },
  },
  preview: { port: 6750, strictPort: true },
  test: {
    environment: "node",
    include: [
      "../server/**/*.test.ts",
      "../shared/**/*.test.ts",
      "../scripts/**/*.test.ts",
      "../client/**/*.test.ts",
    ],
  },
})
