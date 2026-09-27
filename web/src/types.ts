/** Web 调试面板的一条原始 SSE 事件日志。 */
export type EventLogEntry = {
  seq: number;
  time: string;
  type: string;
  data: unknown;
};
