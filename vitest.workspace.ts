// 自动生成的工作区配置文件，请勿直接修改
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      transformMode: {
        ssr: [/\.[jt]sx?$/],
      },
      setupFiles: ['ts-node/register'],
    }
  }
]);
