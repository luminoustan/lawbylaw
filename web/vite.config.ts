import { defineConfig } from "vitest/config"
import solid from "vite-plugin-solid"

export default defineConfig({
  plugins: [solid()],
  build: { target: "es2020", sourcemap: false, chunkSizeWarningLimit: 400 },
  server: { port: 5173, proxy: { "/api": "http://localhost:8000" } },
  test: { environment: "jsdom", include: ["src/**/*.test.ts"] },
})
