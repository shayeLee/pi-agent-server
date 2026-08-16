import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 根目录只跑服务端测试；web/ 子包有独立的 vitest 配置
    include: ["tests/**/*.test.ts"],
  },
});
