import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const dist = resolve(root, "dist");
await rm(dist, { recursive: true, force: true });
await Promise.all([
  mkdir(resolve(dist, "extension"), { recursive: true }),
  mkdir(resolve(dist, "dashboard"), { recursive: true }),
  mkdir(resolve(dist, "collector"), { recursive: true }),
]);

await Promise.all([
  build({
    entryPoints: {
      background: resolve(root, "apps/extension/src/background.ts"),
      popup: resolve(root, "apps/extension/src/popup.ts"),
      options: resolve(root, "apps/extension/src/options.ts"),
    },
    outdir: resolve(dist, "extension"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    sourcemap: true,
  }),
  build({
    entryPoints: [resolve(root, "apps/dashboard/src/app.ts")],
    outfile: resolve(dist, "dashboard/app.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    sourcemap: true,
  }),
  build({
    entryPoints: {
      server: resolve(root, "apps/collector/src/server.ts"),
      cli: resolve(root, "apps/collector/src/cli.ts"),
    },
    outdir: resolve(dist, "collector"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    sourcemap: true,
  }),
  cp(resolve(root, "apps/extension/manifest.json"), resolve(dist, "extension/manifest.json")),
  cp(resolve(root, "apps/extension/popup.html"), resolve(dist, "extension/popup.html")),
  cp(resolve(root, "apps/extension/popup.css"), resolve(dist, "extension/popup.css")),
  cp(resolve(root, "apps/extension/options.html"), resolve(dist, "extension/options.html")),
  cp(resolve(root, "apps/extension/options.css"), resolve(dist, "extension/options.css")),
  cp(resolve(root, "apps/dashboard/index.html"), resolve(dist, "dashboard/index.html")),
  cp(resolve(root, "apps/dashboard/styles.css"), resolve(dist, "dashboard/styles.css")),
]);

console.log("Built collector, dashboard, and unpacked extension in dist/.");
