import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [htmlSource, cssSource, calculatorSource, appSource] = await Promise.all([
  readFile(resolve(root, "index.html"), "utf8"),
  readFile(resolve(root, "src/styles.css"), "utf8"),
  readFile(resolve(root, "src/calculator.js"), "utf8"),
  readFile(resolve(root, "src/app.js"), "utf8")
]);

const calculator = calculatorSource.replace(/^export\s+/gm, "");
const app = appSource.replace(/^import\s+\{[^}]+\}\s+from\s+["'][^"']+["'];?\s*$/m, "");
const script = `${calculator}\n\n${app}`.replace(/<\/script/gi, "<\\/script");
const css = cssSource.replace(/<\/style/gi, "<\\/style");

const output = htmlSource
  .replace(/\s*<link rel="stylesheet" href="\.\/src\/styles\.css">/, `\n  <style>\n${css}\n  </style>`)
  .replace(/\s*<script type="module" src="\.\/src\/app\.js"><\/script>/, `\n  <script type="module">\n${script}\n  </script>`);

if (output === htmlSource || output.includes("./src/")) {
  throw new Error("Build failed: source asset references remain in the generated HTML.");
}

const outputPath = resolve(root, "dist/index.html");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, output, "utf8");
console.log(`Built ${outputPath}`);
