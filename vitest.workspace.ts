require('ts-node/register');

import { defineWorkspace } from 'vitest/config';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

interface ProjectEntry {
  extends: string;
  test: {
    name: string;
    transformMode: { ssr: RegExp[] };
    deps: { registerNodeLoader: boolean };
  };
}

function discoverProjects(): ProjectEntry[] {
  const workspaceRoot = __dirname;
  const projects: ProjectEntry[] = [];

  for (const scope of ['apps', 'packages']) {
    const scopePath = join(workspaceRoot, scope);

    try {
      if (!statSync(scopePath).isDirectory()) continue;
    } catch {
      continue;
    }

    const entries = readdirSync(scopePath, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules');

    for (const entry of entries) {
      const pkgPath = join(scopePath, entry.name);
      const viteConfig = join(pkgPath, 'vite.config.ts');

      try {
        if (statSync(viteConfig).isFile()) {
          projects.push({
            extends: relative(workspaceRoot, viteConfig),
            test: {
              name: `${scope}/${entry.name}`,
              transformMode: { ssr: [/\.ts$/] },
              deps: { registerNodeLoader: true },
            },
          });
        }
      } catch {
        continue;
      }
    }
  }

  return projects;
}

export default defineWorkspace(discoverProjects());