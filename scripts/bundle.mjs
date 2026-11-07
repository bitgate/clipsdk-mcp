import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const check = process.argv.includes("--check");
const outfile = "dist/index.js";

const result = await build({
  entryPoints: ["src/index.ts"],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  minify: true,
  keepNames: true,
  write: !check,
  logLevel: "warning",
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
});

if (check) {
  const fresh = result.outputFiles[0].text;
  const committed = await readFile(outfile, "utf8").catch(() => "");

  if (fresh !== committed) {
    console.error(`${outfile} is out of date: run npm run bundle and commit it.`);
    process.exit(1);
  }

  console.error(`${outfile} is up to date.`);
}
