import { resolve } from "node:path";
import { defineConfig } from "vite";

// Multi-page build:
//   index.html        → /            (redirects to /screen/)
//   screen/index.html → /screen/     (the game host: canvas race + lobby)
//   controller/...    → /controller/ (the phone gamepad)
// Output goes to dist/, which the Worker serves via the [assets] binding.
//
// `vite build --mode devtools` (npm run dev) compiles in the track editor and
// debug overlays; a normal build leaves them out entirely. `--mode studio-dev`
// (npm run deploy:dev) is the same dev build, served under /drift-party/ on
// the katballe-studio-dev site.
export default defineConfig(({ mode }) => ({
  appType: "mpa",
  base: mode === "studio-dev" ? "/drift-party/" : "/",
  define: { __DEV_TOOLS__: JSON.stringify(mode === "devtools" || mode === "studio-dev") },
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
}));
