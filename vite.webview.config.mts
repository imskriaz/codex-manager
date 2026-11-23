import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Dashboard modules live under /assets/ in browsers and a VS Code resource URI.
  base: "./",
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
            const language=file.match(/\/@codemirror\/lang-([a-z]+)\//)?.[1];if(language)return `editor-language-${language}`;
            const grammar=file.match(/\/@lezer\/([a-z]+)\//)?.[1];if(grammar&&!['common','highlight','lr'].includes(grammar))return `editor-language-${grammar}`;
            if (/\/(?:@codemirror|@lezer|codemirror)\//.test(file)) return "editor-vendor";
            if (file.includes("/@xterm/")) return "terminal-vendor";
            return "vendor";
          }
          if (file.includes("vite/preload-helper") || (file.startsWith(rootDir.replace(/\\/g, "/")) && !/\/(?:main|workspaceCodeEditor|workspaceTerminal|workspaceBrowser|settingsOverlay|apiWorkspace|taskBoard)\.tsx$/.test(file))) return "dashboard-core";
        }
      }
    }
  }
});
