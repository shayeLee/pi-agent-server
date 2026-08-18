// 系统提示词解析端口：application/server 只依赖稳定字符串结果，不感知 Pi SDK session 类型。

/** 按项目工作目录解析实际生效的系统提示词（Pi 默认或服务端覆盖）。 */
export interface SystemPromptPort {
  resolve(cwd: string): Promise<string>;
}
