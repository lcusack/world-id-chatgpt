import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = resolve(root, "public");

await mkdir(publicDir, { recursive: true });
await rm(resolve(publicDir, "verify.js.map"), { force: true });
await rm(resolve(publicDir, "intent.js.map"), { force: true });

await build({
  entryPoints: {
    verify: resolve(root, "web/verify.js"),
    intent: resolve(root, "web/intent.js"),
  },
  outdir: publicDir,
  bundle: true,
  format: "esm",
  minify: true,
  sourcemap: false,
  target: ["es2022"],
});

await copyFile(
  resolve(root, "node_modules/@worldcoin/idkit-core/dist/idkit_wasm_bg.wasm"),
  resolve(publicDir, "idkit_wasm_bg.wasm"),
);
