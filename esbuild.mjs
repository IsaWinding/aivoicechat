import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: ["vscode", "@cursor/sdk"],
  format: "cjs",
  platform: "node",
  sourcemap: !production,
  sourcesContent: false,
  minify: production,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[watch] extension build started");
} else {
  await esbuild.build(options);
  if (process.argv.includes("--smoke")) {
    await esbuild.build({
      ...options,
      entryPoints: ["scripts/smoke.ts"],
      outfile: "out/smoke.js",
      external: ["@cursor/sdk"],
    });
  }
  if (process.argv.includes("--live")) {
    await esbuild.build({
      ...options,
      entryPoints: ["scripts/live-conversation.ts"],
      outfile: "out/live-conversation.js",
      external: ["@cursor/sdk"],
    });
  }
  if (process.argv.includes("--spoken")) {
    await esbuild.build({ ...options, entryPoints: ["scripts/live-spoken.ts"], outfile: "out/live-spoken.js", external: ["@cursor/sdk"] });
  }
}
