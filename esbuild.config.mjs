import esbuild from "esbuild";

// Lokální port Jevu. Builduje worker (logika triage + browser decision engine)
// a manifest. @paperclipai/plugin-sdk je externí (dodává runtime bridge).
// Žádná UI vrstva není v tomto lokálním portu zdrojově přítomna.
// Cíl: čistě lokální model, žádná odchozí volání mimo localhost.

const watch = process.argv.includes("--watch");

const workerCtx = await esbuild.context({
  entryPoints: ["src/worker.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/worker.js",
  external: ["@paperclipai/plugin-sdk"],
  target: "node20",
  sourcemap: true,
});

const manifestCtx = await esbuild.context({
  entryPoints: ["src/manifest.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/manifest.js",
  external: ["@paperclipai/plugin-sdk"],
  target: "node20",
  sourcemap: true,
});

if (watch) {
  await Promise.all([workerCtx.watch(), manifestCtx.watch()]);
  console.log("Watching for changes...");
} else {
  await Promise.all([workerCtx.rebuild(), manifestCtx.rebuild()]);
  await Promise.all([workerCtx.dispose(), manifestCtx.dispose()]);
  console.log("Build complete.");
}
