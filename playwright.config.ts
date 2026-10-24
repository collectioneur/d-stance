import { defineConfig } from "@playwright/test";

/**
 * E2E runs against the Vite dev server in headless Chromium with real
 * WebGPU (Metal on macOS). Without `--enable-unsafe-webgpu` headless gets no
 * adapter; `--enable-gpu` keeps it off SwiftShader so perf numbers mean something.
 */
const PORT = 5174;

export default defineConfig({
  testDir: "e2e",
  // Perf / golden-image tools run on demand: PW_TOOLS=1 npx playwright test tools
  testIgnore: process.env.PW_TOOLS ? [] : ["**/tools/**"],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      args: ["--enable-unsafe-webgpu", "--enable-gpu", "--ignore-gpu-blocklist"],
    },
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
