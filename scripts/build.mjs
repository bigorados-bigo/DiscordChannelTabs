#!/usr/bin/env node
import { build } from "esbuild";
import { mkdir, cp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "..");
const dist = resolve(root, "dist");

const args = new Set(process.argv.slice(2));
const watch = args.has("--watch");

async function clean() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
}

async function copyStatic() {
  await Promise.all([
    cp(resolve(root, "manifest.json"), resolve(dist, "manifest.json"), { recursive: false }),
    cp(resolve(root, "src", "content", "tabBar.css"), resolve(dist, "tabBar.css"), { recursive: false })
  ]);
}

async function run() {
  await clean();

  const ctx = await build({
    entryPoints: {
      content: resolve(root, "src", "content", "index.ts"),
      storageBridge: resolve(root, "src", "content", "storage-bridge.ts")
    },
    bundle: true,
    format: "esm",
    outdir: dist,
    entryNames: "[name]",
    sourcemap: true,
    target: "es2021",
    logLevel: "info",
    minify: false,
    treeShaking: true,
    define: {
      __DEV__: "true"
    }
  });

  await copyStatic();

  if (watch) {
    console.log("[build] Watching for changes...");
    const chokidar = await import("chokidar");
    const watcher = chokidar.watch(resolve(root, "src"), { ignoreInitial: true });
    watcher.on("all", async () => {
      try {
        await ctx.rebuild();
        await copyStatic();
        console.log("[build] Rebuilt");
      } catch (error) {
        console.error("[build] Rebuild failed", error);
      }
    });
  }
}

run().catch((error) => {
  console.error("[build] Error", error);
  process.exit(1);
});
