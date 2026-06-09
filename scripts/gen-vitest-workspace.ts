#!/usr/bin/env node

import * as path from 'path'
import * as fs from 'fs'

const ROOT_DIR = process.cwd()
const SEARCH_DIRS = ['apps', 'packages']
const OUTPUT_FILE = path.join(ROOT_DIR, 'vitest.workspace.ts')

function findViteConfigs(dir: string): string[] {
  const viteConfigPath = path.join(dir, 'vite.config.ts')
  if (fs.existsSync(viteConfigPath)) {
    return [viteConfigPath]
  }
  return []
}

function discoverViteConfigs(): string[] {
  const configs: string[] = []

  for (const searchDir of SEARCH_DIRS) {
    const fullPath = path.join(ROOT_DIR, searchDir)
    if (!fs.existsSync(fullPath)) {
      continue
    }

    const entries = fs.readdirSync(fullPath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const projectPath = path.join(fullPath, entry.name)
        configs.push(...findViteConfigs(projectPath))
      }
    }
  }

  if (configs.length === 0) {
    console.log('No vite.config.ts files found in apps/* or packages/*')
    return []
  }

  console.log(`Found ${configs.length} vite.config.ts file(s):`)
  configs.forEach((c) => console.log(`  - ${c}`))

  return configs
}

function generateWorkspaceContent(configPaths: string[]): string {
  const projects = configPaths.map((configPath: string) => {
    const projectDir = path.dirname(configPath)
    const projectName = path.basename(projectDir)
    const relativeConfig = path.relative(ROOT_DIR, configPath)

    return `  {
    extends: './${relativeConfig}',
    test: {
      include: ['${projectDir}/**/*.test.ts', '${projectDir}/**/*.spec.ts'],
      globals: true,
      environment: 'node',
      transformMode: {
        web: [/\\.[jt]sx$/],
        ssr: [/\\.[jt]s$/],
      },
      setupFiles: ['${projectDir}/test-setup.ts'],
      name: '${projectName}',
    },
  }`
  })

  return `import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
${projects.join(',\n')}
])
`
}

function main(): void {
  console.log('Generating vitest workspace configuration...\n')

  const configs = discoverViteConfigs()

  if (configs.length === 0) {
    console.log('No projects found. Skipping workspace generation.')
    return
  }

  const content = generateWorkspaceContent(configs)

  fs.writeFileSync(OUTPUT_FILE, content, 'utf-8')
  console.log(`\nWorkspace configuration written to: ${OUTPUT_FILE}`)
  console.log(`Total projects: ${configs.length}`)
}

main()
