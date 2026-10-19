/**
 * PoC (p5.js#9303): reference-only Astro build.
 *
 * Astro 6 has no config option to exclude routes from a static build, so this
 * wrapper temporarily moves every non-reference entry out of src/pages before
 * running `astro build`, and restores them afterwards (also on failure). Only
 * src/pages/reference/** plus the shared _utils modules (imported by layouts
 * and components) stay in place, so the build emits /reference/** and nothing
 * else.
 *
 * Run with: npm run build:reference-only
 * Respects SKIP_BUILD_COMPRESS and REFERENCE_SKIP_LOWERCASE.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..", "..");
const pagesDir = path.join(root, "src", "pages");
const stashDir = path.join(root, ".reference-only-pages-stash");

// Entries in src/pages that the reference build needs
const keep = new Set(["reference", "_utils.ts", "_utils-node.ts"]);

// Move everything from the stash back into src/pages. Used both for normal
// restoration and to recover from a previous run that was killed (e.g. by a
// reboot) after stashing but before restoring.
const restoreStash = async () => {
  let stashed: string[];
  try {
    stashed = await fs.readdir(stashDir);
  } catch {
    return 0; // no stash dir, nothing to restore
  }
  for (const entry of stashed) {
    await fs.rename(path.join(stashDir, entry), path.join(pagesDir, entry));
  }
  // Non-recursive on purpose: if anything is somehow still in the stash,
  // fail loudly rather than delete it.
  await fs.rmdir(stashDir);
  return stashed.length;
};

const main = async () => {
  const recovered = await restoreStash();
  if (recovered > 0) {
    console.log(
      `Recovered ${recovered} page entries left in the stash by an interrupted run.`,
    );
  }
  await fs.mkdir(stashDir, { recursive: true });
  const entries = await fs.readdir(pagesDir);
  const moved: string[] = [];
  try {
    for (const entry of entries) {
      if (keep.has(entry)) continue;
      await fs.rename(path.join(pagesDir, entry), path.join(stashDir, entry));
      moved.push(entry);
    }
    console.log(`Moved ${moved.length} non-reference page entries aside.`);
    execSync("npx astro build", {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, REFERENCE_ONLY: "1" },
    });
  } finally {
    await restoreStash();
    console.log("Restored non-reference pages.");
  }
};

main();
