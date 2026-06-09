import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface WorkspaceProject {
  extends: string;
  test: {
    include?: string[];
    exclude?: string[];
    name: string;
  };
}

export interface WorkspaceRoot {
  test: {
    transformMode: {
      web?: RegExp[];
      ssr?: RegExp[];
    };
    globals?: boolean;
    reporters?: Array<"default" | "verbose" | "json" | "html" | string>;
    threads?: boolean;
    maxWorkers?: number | string;
  };
  projects: WorkspaceProject[];
}

const ROOT_DIR = resolve(__dirname, "..");
const SCAN_ROOTS = ["apps", "packages"];
const VITE_CONFIG_FILES = [
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mts",
  "vite.config.mjs",
  "vite.config.cts",
  "vite.config.cjs",
];
const OUTPUT_FILE = join(ROOT_DIR, "vitest.workspace.ts");
const DEFAULT_TEST_INCLUDES = [
  "tests/**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs}",
  "src/**/__tests__/**/*.{ts,tsx,js,jsx,mts,mjs}",
  "src/**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs}",
];
const DEFAULT_TEST_EXCLUDES = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/coverage/**",
];

function findPackageName(pkgDir: string): string {
  const pkgJson = join(pkgDir, "package.json");
  if (existsSync(pkgJson)) {
    try {
      const json = JSON.parse(readFileSync(pkgJson, "utf8"));
      if (typeof json.name === "string" && json.name.length > 0) {
        return json.name;
      }
    } catch {
      // ignore parse error
    }
  }
  return pkgDir.split(/[\\/]/).pop() || pkgDir;
}

function findViteConfig(dir: string): string | null {
  for (const name of VITE_CONFIG_FILES) {
    const candidate = join(dir, name);
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function walkScanRoots(): Array<{ pkgDir: string; viteConfig: string; name: string }> {
  const results: Array<{ pkgDir: string; viteConfig: string; name: string }> = [];
  const seen = new Set<string>();

  for (const scanRoot of SCAN_ROOTS) {
    const absScan = join(ROOT_DIR, scanRoot);
    if (!existsSync(absScan) || !statSync(absScan).isDirectory()) {
      continue;
    }

    for (const entry of readdirSync(absScan)) {
      const pkgDir = join(absScan, entry);
      if (!statSync(pkgDir).isDirectory()) continue;

      const viteConfig = findViteConfig(pkgDir);
      if (!viteConfig) continue;
      if (seen.has(pkgDir)) continue;
      seen.add(pkgDir);

      results.push({
        pkgDir,
        viteConfig,
        name: findPackageName(pkgDir),
      });
    }
  }

  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

function relFromRoot(absPath: string): string {
  const rel = relative(ROOT_DIR, absPath);
  return toPosix(isAbsolute(rel) ? absPath : rel);
}

function buildWorkspaceConfig(): WorkspaceRoot {
  const projectsInfo = walkScanRoots();
  const projects: WorkspaceProject[] = projectsInfo.map(({ pkgDir, viteConfig, name }) => {
    const relConfig = toPosix(relFromRoot(viteConfig));
    const relDir = toPosix(relFromRoot(pkgDir));
    const include = DEFAULT_TEST_INCLUDES.map((g) => `${relDir}/${g}`);
    const exclude = DEFAULT_TEST_EXCLUDES.map((g) => `${relDir}/${g}`);
    return {
      extends: relConfig.startsWith(".") ? relConfig : `./${relConfig}`,
      test: {
        include,
        exclude,
        name,
      },
    };
  });

  return {
    test: {
      transformMode: {
        ssr: [/\.[cm]?[tj]sx?$/],
      },
      globals: true,
      reporters: ["default"],
      threads: true,
      maxWorkers: process.env.CI ? "50%" : "100%",
    },
    projects,
  };
}

function serializeConfig(cfg: WorkspaceRoot): string {
  const lines: string[] = [];
  lines.push('import { defineWorkspace } from "vitest/config";');
  lines.push("");
  lines.push("export default defineWorkspace([");
  lines.push("  {");
  lines.push("    test: {");
  lines.push("      transformMode: {");
  lines.push("        ssr: [/\\.[cm]?[tj]sx?$/],");
  lines.push("      },");
  lines.push("      globals: true,");
  lines.push('      reporters: ["default"],');
  lines.push("      threads: true,");
  lines.push(`      maxWorkers: process.env.CI ? "50%" : "100%",`);
  lines.push("    },");
  lines.push("  },");
  for (const project of cfg.projects) {
    lines.push("  {");
    lines.push(`    extends: "${project.extends}",`);
    lines.push("    test: {");
    lines.push("      name: " + JSON.stringify(project.test.name) + ",");
    if (project.test.include) {
      lines.push("      include: " + JSON.stringify(project.test.include) + ",");
    }
    if (project.test.exclude) {
      lines.push("      exclude: " + JSON.stringify(project.test.exclude) + ",");
    }
    lines.push("    },");
    lines.push("  },");
  }
  lines.push("]);");
  lines.push("");
  return lines.join("\n");
}

function main(): void {
  const cfg = buildWorkspaceConfig();
  const outDir = dirname(OUTPUT_FILE);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const text = serializeConfig(cfg);
  writeFileSync(OUTPUT_FILE, text, "utf8");

  const count = cfg.projects.length;
  console.log(`[gen-vitest-workspace] discovered ${count} project(s)`);
  for (const p of cfg.projects) {
    console.log(`  - ${p.test.name}  <- ${p.extends}`);
  }
  console.log(`[gen-vitest-workspace] written -> ${OUTPUT_FILE}`);
}

if (require.main === module || (import.meta as any).main) {
  main();
}

export { walkScanRoots, buildWorkspaceConfig, main };
