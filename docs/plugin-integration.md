# 插件接入

本文说明如何给 `pi-agent-server` 增加插件。接口细节以文末的源码为准。

## 边界与加载

- 插件是**受信的同进程 ESM 代码**，不是沙箱或进程隔离。插件导入时的模块顶层代码也会
  执行，故应避免在模块求值阶段产生副作用。
- 在 `PI_PLUGINS` 中写插件包名，或构建后入口文件的绝对路径；多个插件用逗号分隔。
  不设置就不加载插件，不会自动查找本机安装的插件。
- 服务先读取并检查插件声明。检查通过后，如果插件提供了 `register(context)`，就调用它来
  注册接口和权限；服务停止时，如果插件提供了 `dispose()`，就调用它来关闭自己创建的资源。
  这两个函数是**按需提供**的：只提供工具定义、不注册接口的插件可以不写 `register`；
  没有需要关闭的资源时可以不写 `dispose`。
- 插件只依赖公开的插件接口与 Pi SDK 公共类型，不依赖 agent-server 的 `src/*` 内部模块。

## 模块与 manifest

入口模块可以默认导出一个插件对象，也可以在模块顶层分别导出 `manifest`、`tools` 等字段；不会读取名为 `plugin` 的命名导出。插件对象结构如下：

```ts
{
  manifest: {
    id, version, name?, tools?, promptFragments?, modes?, capabilities?
  },
  tools?, modes?, register?, dispose?
}
```

- `manifest.id` 为小写字母/数字/连字符标识；`version` 为正整数。插件 id 必须唯一。
- `manifest.tools` 是 Agent 可见工具声明（`name`、可选
  `category: "read" | "write" | "execute"`、可选 `description`）；实现放在 `module.tools`，
  名称集合必须一一对应，声明的描述须匹配。工具名不可与 Pi 内置保留名或其他插件工具冲突。
  未声明 `category` 按 `read` 处理。
- `promptFragments` 可用非空 `inline` 文本，或已存在的绝对 `file` 路径，二者选一。
- `capabilities` 是插件自己的功能标识列表（最多 32 个）；agent-server 不解释这些标识的业务含义。
  注册时须用 `declareCapabilities({ flag: "read" | "write" | "admin" })` 为每个声明项映射档位。

## 注册接口、工具与路由

`register` 收到的 `PluginHostContext` 包含：

- `projectCwd`；
- `mountRoute`、`declareCapabilities`；
- 服务提供的 `turnErrorCodes`。

通过上述接口注册，不直接操作 agent-server 内部的 Fastify、会话存储或数据库。

- 路由声明 `method`（`GET`/`POST`/`PUT`/`PATCH`/`DELETE`）、以 `/` 开头的插件内 `path`、
  `access` 和 `handler`。服务会把路由挂到 `/v1/capabilities/<plugin-id>`；同一插件内路由不得重复，
  `/access` 是保留路径。
- `access` 写在插件的 `register(context)` 中、调用 `context.mountRoute` 时传入的对象里，例如
  `context.mountRoute({ method: "GET", path: "/items", access: "read", handler })`。
  这里的 `access` 决定谁能调用这条接口：`read` 允许 viewer/user/admin，`write` 允许
  user/admin，`admin` 只允许 admin。未获授权的请求会被服务拒绝。
  `GET /v1/access` 是另一个**供客户端查询权限**的接口，返回 `{ "canRead": true, "canWrite": true }`；
  它不是在插件路由里填写的字段。
- 服务会识别当前请求是谁，并在路由处理函数的 `context.ownerKey` 中给出该用户的标识。
  插件可用它关联自己的数据，不要让客户端自行提交用户标识来代替它。若一条接口内还需
  判断用户是否能读、写或管理，使用 `context.capabilities.read/write/admin`；不要从
  `context.request` 或 `context.reply` 的内部字段推断用户权限。
- 如果插件声明了功能标识并为每项指定权限，服务会提供只读的
  `GET /v1/capabilities/<plugin-id>/access`，告诉客户端当前用户可用哪些插件功能。
  不认识的用户得到的结果均为 `false`；实际操作仍需经过路由权限检查。
- 插件通过 `context.sessions` 操作**当前用户自己的会话**：可以创建、恢复、读取消息和提示词、
  修改标题或运行一轮对话；具体方法见文末 `PluginSessionApi`。用户身份由服务绑定，插件不能
  指定另一个用户，也不能通过这组方法删除任意会话。
- 创建插件会话分两步：先调用 `sessions.reserve({ modeId })` 获取服务生成的会话 ID，
  将它与插件自己的业务记录关联；再在**同一次请求**中调用
  `sessions.create({ reservation, title })` 真正创建会话。这样插件的记录和服务会话
  使用同一个 ID；预约不能跨请求使用。
- 插件调用 `sessions.runTurn({ sessionId, requestId, prompt })`，让服务在该会话中运行
  **一轮对话并等待最终结果**。它使用创建会话时确定的模型和配置；调用时不能另选模型、
  工具、工作目录，也不能传图片。单轮有输入长度、输出长度、工具次数和运行时间上限。
  只能在处理当前请求期间调用；请求结束或被取消后，不可拿旧的 `context.sessions` 继续运行。

## 会话事件与图片

插件无需另建事件流。需要实时显示回复时，使用服务的 `GET /v1/sessions/:id/events`：正常任务
事件带其 `requestId`，客户端按该 id 关联事件，避免串入其他请求；事件字段以
[OpenAPI v1 源定义](../src/public-api/openapi-v1.ts) 为准。插件 `runTurn` 本身只返回最终结果，
不提供 SSE 回调。

图片由普通会话消息接口接收，不是插件 `runTurn` 的功能：
`POST /v1/sessions/:id/messages` 可接收最多 4 张 PNG/JPEG/WebP 图片，服务会检查内容与尺寸。
需要图片输入时复用该会话消息通道；不要假定 `runTurn` 支持图片或另建图片上传接口/图片存储。
详见 [图片校验实现](../src/agent/image-input.ts) 与 OpenAPI。

## 持久化与运维责任

插件自行负责其业务数据与数据库/schema、迁移、备份和恢复，以及相应的部署配置、运维任务和
验证演练。迁移由插件 CLI 或部署流程显式执行，不在加载插件时自动迁移；agent-server 不管理插件数据库表，
也不把插件业务数据并入自己的数据库迁移。插件按需用 `register` / `dispose` 管理自身运行资源。

## 权威实现

- [插件类型与公开接口](../src/plugin/contract.ts)
- [环境变量入口](../src/main.ts) · [启动装配](../src/server/start.ts)
- [加载与校验](../src/application/plugins/loader.ts) ·
  [路由、授权上下文与生命周期](../src/server/plugin-host.ts)
- [权限档位与角色矩阵](../src/server/route-rbac.ts) ·
  [OpenAPI v1 定义](../src/public-api/openapi-v1.ts)
- [英文 README 配置说明](../README.md#current-boundaries)（中英文 README 说明保持同步）
