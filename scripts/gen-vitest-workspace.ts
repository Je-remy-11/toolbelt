#!/usr/bin/env ts-node

import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

interface DiscoveredProject {
  name: string;
  configPath: string;
}

function discoverProjects(workspaceRoot: string): DiscoveredProject[] {
  const projects: DiscoveredProject[] = [];

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
            name: `${scope}/${entry.name}`,
            configPath: relative(workspaceRoot, viteConfig),
          });
        }
      } catch {
        continue;
      }
    }
  }

  return projects;
}

function generateWorkspaceFile(outputPath: string) {
  const workspaceRoot = process.cwd();
  const projects = discoverProjects(workspaceRoot);

  if (projects.length === 0) {
    console.log('No vite.config.ts files found under apps/* or packages/*');
    return;
  }

  const projectEntries = projects
    .map(
      (p) =>
        `  {
    extends: '${p.configPath}',
    test: {
      name: '${p.name}',
      transformMode: { ssr: [/\\\\.ts$/] },
      deps: {
        registerNodeLoader: true,
      },
    },
  }`
    )
    .join(',\n');

  const content = `import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
${projectEntries},
]);
`;

  writeFileSync(outputPath, content);
  console.log(`Generated vitest.workspace.ts with ${projects.length} project(s):`);
  projects.forEach((p) => console.log(`  - ${p.name}`));
}

const outputPath = resolve(process.cwd(), 'vitest.workspace.ts');
generateWorkspaceFile(outputPath);