import { resolve } from "node:path";
import { defineConfig } from "vite";

// Multi-page build:
//   index.html        → /            (redirects to /screen/)
//   screen/index.html → /screen/     (the game host: canvas race + lobby)
//   controller/...    → /controller/ (the phone gamepad)
// Output goes to dist/, which the Worker serves via the [assets] binding.
//
// `vite build --mode devtools` (npm run dev / deploy:dev) compiles in the track
// editor and debug overlays; a normal build leaves them out entirely. The dev
// build uses relative asset URLs so the same files work at a domain root
// (drift-party-dev.mkatballe.workers.dev/screen/) and under a path
// (katballe-studio-dev…/drift-party/screen/); the code finds its root at
// runtime (appRoot in src/shared/net.ts).
export default defineConfig(({ mode }) => ({
  appType: "mpa",
  base: mode === "devtools" ? "./" : "/",
  define: { __DEV_TOOLS__: JSON.stringify(mode === "devtools") },
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
