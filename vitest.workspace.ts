import { defineWorkspace } from 'vitest/config'
import { globSync } from 'glob'
import path from 'path'

const projectConfigs = globSync(['apps/*/vite.config.ts', 'packages/*/vite.config.ts'], {
  cwd: __dirname,
  absolute: true,
})

export default defineWorkspace(
  projectConfigs.map((configPath) => {
    const projectDir = path.dirname(configPath)
    const projectName = path.basename(projectDir)

    return {
      extends: configPath,
      test: {
        include: [`${projectDir}/**/*.test.ts`, `${projectDir}/**/*.spec.ts`],
        globals: true,
        environment: 'node',
        transformMode: {
          web: [/\.[jt]sx$/],
          ssr: [/\.[jt]s$/],
        },
        setupFiles: [`${projectDir}/test-setup.ts`],
        name: projectName,
      },
    }
  })
)
