declare const process: {
  cwd(): string
}

declare const require: {
  (id: string): any
  main?: unknown
}

declare const module: unknown

type DirEntry = {
  name: string
  isDirectory(): boolean
}

type FsModule = {
  existsSync(filePath: string): boolean
  readdirSync(filePath: string, options: { withFileTypes: true }): DirEntry[]
  writeFileSync(filePath: string, content: string, encoding: string): void
}

type PathModule = {
  dirname(filePath: string): string
  join(...paths: string[]): string
  relative(from: string, to: string): string
  sep: string
}

require('ts-node/register')

const { existsSync, readdirSync, writeFileSync } = require('node:fs') as FsModule
const path = require('node:path') as PathModule

export type VitestWorkspaceProject = {
  extends: string
  test: {
    name: string
    transformMode: {
      ssr: RegExp[]
    }
  }
}

const SEARCH_ROOTS = ['apps', 'packages'] as const
const VITE_CONFIG_FILE = 'vite.config.ts'
const SSR_TRANSFORM_PATTERN = /\.[cm]?[jt]sx?$/

function normalizeRelativePath(rootDir: string, filePath: string) {
  return path.relative(rootDir, filePath).split(path.sep).join('/')
}

function toProjectName(rootDir: string, configPath: string) {
  const serviceRoot = path.dirname(normalizeRelativePath(rootDir, configPath))
  return serviceRoot.replace(/[^a-zA-Z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

function collectConfigsInRoot(rootDir: string, scope: (typeof SEARCH_ROOTS)[number]) {
  const scopeDir = path.join(rootDir, scope)

  if (!existsSync(scopeDir)) {
    return [] as string[]
  }

  return readdirSync(scopeDir, { withFileTypes: true })
    .filter((entry: DirEntry) => entry.isDirectory())
    .map((entry: DirEntry) => path.join(scopeDir, entry.name, VITE_CONFIG_FILE))
    .filter((configPath: string) => existsSync(configPath))
    .sort((left: string, right: string) => left.localeCompare(right))
}

export function findViteConfigs(rootDir = process.cwd()) {
  return SEARCH_ROOTS.flatMap((scope) => collectConfigsInRoot(rootDir, scope))
}

export function createWorkspaceProjects(rootDir = process.cwd()): VitestWorkspaceProject[] {
  return findViteConfigs(rootDir).map((configPath) => ({
    extends: `./${normalizeRelativePath(rootDir, configPath)}`,
    test: {
      name: toProjectName(rootDir, configPath),
      transformMode: {
        ssr: [SSR_TRANSFORM_PATTERN],
      },
    },
  }))
}

export function renderVitestWorkspace(rootDir = process.cwd()) {
  const projects = createWorkspaceProjects(rootDir)
  const serializedProjects = projects
    .map((project) => {
      const patterns = project.test.transformMode.ssr.map((pattern) => pattern.toString()).join(', ')

      return [
        '  {',
        `    extends: '${project.extends}',`,
        '    test: {',
        `      name: '${project.test.name}',`,
        '      transformMode: {',
        `        ssr: [${patterns}],`,
        '      },',
        '    },',
        '  },',
      ].join('\n')
    })
    .join('\n')

  return [
    "require('ts-node/register')",
    "const { defineWorkspace } = require('vitest/config')",
    '',
    'export default defineWorkspace([',
    serializedProjects,
    '])',
    '',
  ].join('\n')
}

export function writeVitestWorkspace(rootDir = process.cwd()) {
  const outputPath = path.join(rootDir, 'vitest.workspace.ts')
  const content = renderVitestWorkspace(rootDir)

  writeFileSync(outputPath, content, 'utf8')

  return outputPath
}

if (require.main === module) {
  writeVitestWorkspace()
}
