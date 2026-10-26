import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "preact"
  },
  build: {
    outDir: resolve(rootDir, "media", "webview", "dashboard"),
    emptyOutDir: true,
    sourcemap: false,
    manifest: "dashboard-manifest.json",
    target: "es2020",
    rollupOptions: {
      input: resolve(rootDir, "webview-src", "dashboard", "main.tsx"),
      output: {
        entryFileNames: "dashboard.js",
        inlineDynamicImports: false,
        chunkFileNames: "chunks/[name]-[hash].js",
        manualChunks(id) {
          const file = id.replace(/\\/g, "/");
          if (file.includes("node_modules")) {
            if (/\/(?:@codemirror|@lezer|codemirror)\//.test(file)) return "editor-vendor";
            if (file.includes("/@xterm/")) return "terminal-vendor";
            return "vendor";
          }
          if (file.includes("vite/preload-helper") || (file.startsWith(rootDir.replace(/\\/g, "/")) && !/\/(?:main|workspaceCodeEditor|workspaceTerminal)\.tsx$/.test(file))) return "dashboard-core";
        }
      }
    }
  }
});
