import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(root, "src/app/(user)/canvas/[id]/canvas-client-page.tsx"), "utf8");

const checks = [
    ["extract clipboard image files", /function\s+getClipboardImageFiles\s*\(/],
    ["skip editable paste targets", /function\s+isEditablePasteTarget\s*\(/],
    ["listen for native paste events", /addEventListener\(\s*"paste"/],
    ["clean up native paste listener", /removeEventListener\(\s*"paste"/],
    ["create pasted images as uploaded canvas nodes", /createUploadedFileNode\(file,\s*batchUploadPosition\(position,\s*index\)\)/],
    ["show batch paste success", /已从剪切板添加 \$\{files\.length\} 张图片/],
];

const missing = checks.filter(([, pattern]) => !pattern.test(source)).map(([label]) => label);

if (missing.length) {
    console.error(`Canvas paste image verification failed:\n- ${missing.join("\n- ")}`);
    process.exit(1);
}

console.log("Canvas paste image verification passed.");
