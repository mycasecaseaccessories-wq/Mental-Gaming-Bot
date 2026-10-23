import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(
  "pnpm",
  [
    "--filter",
    "@workspace/api-server",
    "exec",
    "esbuild",
    "../../scripts/api-vercel-entry.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--outfile=../../api/[...path].js",
    "--packages=bundle",
    "--log-level=info",
  ],
  { cwd: repositoryRoot, stdio: "inherit" },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
