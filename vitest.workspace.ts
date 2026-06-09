declare const require: {
  (id: string): any
}

require('ts-node/register')

const { defineWorkspace } = require('vitest/config') as {
  defineWorkspace: (projects: unknown[]) => unknown
}
const { createWorkspaceProjects } = require('./scripts/gen-vitest-workspace') as {
  createWorkspaceProjects: (rootDir?: string) => unknown[]
}

export default defineWorkspace(createWorkspaceProjects())
