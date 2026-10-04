// ESM + CJS builds with tsc only. The CJS build covers the library; the CLI
// (src/bin.ts, src/cli.ts) ships as ESM.
import { execFileSync } from "node:child_process";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
rmSync("dist", { recursive: true, force: true });
for (const project of ["tsconfig.json", "tsconfig.cjs.json"])
  execFileSync(process.execPath, [tsc, "-p", project], { stdio: "inherit" });
writeFileSync("dist/cjs/package.json", '{ "type": "commonjs" }\n');
chmodSync("dist/esm/bin.js", 0o755);
