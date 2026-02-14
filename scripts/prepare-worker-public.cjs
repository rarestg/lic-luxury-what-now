#!/usr/bin/env node
/*
Build apps/worker/public from local UI + minimal data artifacts.

Usage:
  node scripts/prepare-worker-public.cjs            # includes static data files (dev/offline)
  node scripts/prepare-worker-public.cjs --no-data  # skips data files (production, UI uses /api/bootstrap)
*/

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "apps", "worker", "public");

const noData = process.argv.includes("--no-data");

const UI_FILES = [
  ["tool/index.html", "index.html"],
  ["tool/config.js", "config.js"],
];

const UI_DIRS = [
  ["tool/styles", "styles"],
  ["tool/src", "src"],
];

const DATA_FILES = [
  ["data/listings.json", "data/listings.json"],
  ["data/hash-graph/listing-graph.json", "data/hash-graph/listing-graph.json"],
];

function copyFile(srcRel, dstRel) {
  const src = path.join(ROOT, srcRel);
  const dst = path.join(PUBLIC_DIR, dstRel);
  if (!fs.existsSync(src)) throw new Error(`Missing source file: ${srcRel}`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyOptional(srcRel, dstRel) {
  const src = path.join(ROOT, srcRel);
  if (!fs.existsSync(src)) return false;
  copyFile(srcRel, dstRel);
  return true;
}

function copyDir(srcRel, dstRel) {
  const src = path.join(ROOT, srcRel);
  const dst = path.join(PUBLIC_DIR, dstRel);
  if (!fs.existsSync(src)) throw new Error(`Missing source directory: ${srcRel}`);
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}

function main() {
  fs.rmSync(PUBLIC_DIR, { recursive: true, force: true });
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });

  for (const [src, dst] of UI_FILES) copyFile(src, dst);
  for (const [src, dst] of UI_DIRS) copyDir(src, dst);

  if (noData) {
    console.log("--no-data: skipping static data files (UI will use /api/bootstrap).");
  } else {
    for (const [src, dst] of DATA_FILES) copyFile(src, dst);
  }

  const copiedLocalConfig = copyOptional("tool/config.local.js", "config.local.js");
  if (!copiedLocalConfig) {
    fs.writeFileSync(
      path.join(PUBLIC_DIR, "config.local.js"),
      "window.LIC_CONFIG = Object.assign({}, window.LIC_CONFIG || {});\n",
      "utf8",
    );
  }

  const fileCount = UI_FILES.length + UI_DIRS.length + (noData ? 0 : DATA_FILES.length);
  console.log(`Prepared ${PUBLIC_DIR}`);
  console.log(
    `Copied ${fileCount} files${copiedLocalConfig ? " + config.local.js" : " + empty config.local.js"}.`,
  );
}

main();
