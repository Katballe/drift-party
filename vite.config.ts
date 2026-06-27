import { resolve } from "node:path";
import { defineConfig } from "vite";

// Multi-page build:
//   index.html        → /            (redirects to /screen/)
//   screen/index.html → /screen/     (the game host: canvas race + lobby)
//   controller/...    → /controller/ (the phone gamepad)
// Output goes to dist/, which the Worker serves via the [assets] binding.
export default defineConfig({
  appType: "mpa",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        screen: resolve(__dirname, "screen/index.html"),
        controller: resolve(__dirname, "controller/index.html"),
      },
    },
  },
});
