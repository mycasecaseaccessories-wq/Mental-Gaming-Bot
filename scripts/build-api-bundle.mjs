import { build } from "esbuild";

await build({
  entryPoints: ["api/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "api/index.mjs",
  sourcemap: false,
  packages: "bundle",
  logLevel: "info",
});
