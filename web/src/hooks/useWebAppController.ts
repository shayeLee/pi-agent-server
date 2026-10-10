import { useWebAppControllerState } from "./web-app/useWebAppControllerState.js";
import { useWebAppControllerActions } from "./web-app/useWebAppControllerActions.js";

/** Web 页面专属服务端状态适配层：封装 API 编排与 SSE 聊天状态。 */
export function useWebAppController() {
  const state = useWebAppControllerState();
  const actions = useWebAppControllerActions(state);
  return { ...state, ...actions };
}
