require("ts-node/register");

const { defineWorkspace } = require("vitest/config");
const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = __dirname;
const SCAN_ROOTS = ["apps", "packages"];
const VITE_CONFIG_FILES = [
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mts",
  "vite.config.mjs",
  "vite.config.cts",
  "vite.config.cjs",
];
const DEFAULT_INCLUDES = [
  "tests/**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs}",
  "src/**/__tests__/**/*.{ts,tsx,js,jsx,mts,mjs}",
  "src/**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs}",
];
const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/coverage/**",
];

function toPosix(p) {
  return p.split("\\").join("/");
}

function relFromRoot(abs) {
  const rel = path.relative(ROOT_DIR, abs);
  return toPosix(path.isAbsolute(rel) ? abs : rel);
}

function readPackageName(pkgDir) {
  const pkgJson = path.join(pkgDir, "package.json");
  if (fs.existsSync(pkgJson)) {
    try {
      const meta = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
      if (typeof meta.name === "string" && meta.name.length > 0) {
        return meta.name;
      }
    } catch (_err) {
      /* noop */
    }
  }
  return pkgDir.split(/[\\/]/).pop() || pkgDir;
}

function findViteConfig(dir) {
  for (const name of VITE_CONFIG_FILES) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function discoverProjects() {
  const seen = new Set();
  const items = [];

  for (const scanRoot of SCAN_ROOTS) {
    const absScan = path.join(ROOT_DIR, scanRoot);
    if (!fs.existsSync(absScan) || !fs.statSync(absScan).isDirectory()) continue;

    for (const entry of fs.readdirSync(absScan)) {
      const pkgDir = path.join(absScan, entry);
      if (!fs.statSync(pkgDir).isDirectory()) continue;

      const viteConfig = findViteConfig(pkgDir);
      if (!viteConfig) continue;
      if (seen.has(pkgDir)) continue;
      seen.add(pkgDir);

      const relConfig = toPosix(relFromRoot(viteConfig));
      const relDir = toPosix(relFromRoot(pkgDir));
      const name = readPackageName(pkgDir);

      items.push({
        extends: relConfig.startsWith(".") ? relConfig : `./${relConfig}`,
        test: {
          name,
          include: DEFAULT_INCLUDES.map((g) => `${relDir}/${g}`),
          exclude: DEFAULT_EXCLUDES.map((g) => `${relDir}/${g}`),
        },
      });
    }
  }

  items.sort((a, b) => a.test.name.localeCompare(b.test.name));
  return items;
}

const projects = discoverProjects();

module.exports = defineWorkspace([
  {
    test: {
      transformMode: {
        ssr: [/\.[cm]?[tj]sx?$/],
      },
      globals: true,
      reporters: ["default"],
      threads: true,
      maxWorkers: process.env.CI ? "50%" : "100%",
    },
  },
  ...projects,
]);
