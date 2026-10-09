# 非图片文件上传：本地部署配置

该功能需**显式**设置两个绝对路径；未配置时上传接口返回 503，既有文字与 `images/base64` 消息保持可用。服务启动只验证配置形状，不声称已验证 Pi 容器挂载。

- `PI_UPLOAD_STORAGE_ROOT`：应用服务进程可写的私有受控目录。仅保存随机 UUID 命名的原字节；不得指向公开静态目录、项目代码目录或临时清理目录。进程首次上传时创建私有目录；已有目录须由当前用户拥有且不向组/其他用户开放。
- `PI_UPLOAD_AGENT_ROOT`：同一批字节在 Pi 工作进程／容器中可见的绝对目录。部署者须自行配置持久卷或只读挂载，并确保 `storageRoot/<UUID>` 与 `agentRoot/<UUID>` 为同一文件；两个路径恰好相同**不是**挂载存在的证明。
- `PI_UPLOAD_OWNER_QUOTA_BYTES`、`PI_UPLOAD_GLOBAL_QUOTA_BYTES`：启用上传时须配置正整数 owner/global 字节预算；DB reservation 事务累计 `uploading` 和 `ready` 元数据，超额返回 507。同一上传键重试不重复计额。由于首版绝不清理原件，预算耗尽后只能由另行批准的容量方案处理，不可让上传覆盖存量文件。

上传使用 `POST /v1/files`，请求体为单个 `application/octet-stream` 原文件；`x-upload-project-id`、`x-upload-key`、`x-upload-name`（URI 编码原文件名）、`x-upload-kind`（text/code/csv/json/pdf/docx/xlsx/pptx）、`x-upload-type` 为元数据。上传键由客户端为每次选择生成并在同一字节重试时复用；同键不同字节会冲突。随后 `POST /v1/sessions/:id/messages` 增加 `fileIds` 数组，由服务端按 owner/project/session 验证并从数据库生成给 Agent 的文件名及路径；客户端不得提交可信路径。现有 `images/base64` 不变。

**运行前验收**：用实际服务用户和 Pi 工作进程检查卷映射、文件读权限及 read/ls/find/grep 的真实可访问范围；路径和目录分类**不是权限沙箱**。确认 Agent 环境有处理目标 PDF/Office 内容的工具；允许上传不保证它能解析。非图片限单个 20 MiB、每消息最多 5 个且总量 50 MiB；docx/xlsx/pptx 使用容器结构校验，旧式二进制 Office 不在首版范围。

首版**没有任何上传文件清理**：未绑定、已绑定、上传失败残留与删除会话后的原件都不会被自动删除；运维需监控磁盘容量、配置上述累计配额，并核对存储卷可用空间。**加密备份 v2**：备份 CLI 需读取同一 `PI_UPLOAD_STORAGE_ROOT`；DB 快照中的每条 `uploaded_files`（包括未绑定文件）必须与原件大小及 SHA-256 匹配，否则 fail-closed、不发布包。恢复 v2 包时显式设置 `PI_RESTORE_UPLOAD_AGENT_ROOT`，它是目标根在 Pi 环境中的挂载映射：原件恢复至 `<finalPath>/uploads/<UUID>`，DB 中 Pi 路径重映射至 `<PI_RESTORE_UPLOAD_AGENT_ROOT>/<restore-id>/uploads/<UUID>`。运维必须实测挂载；仅凭路径字符串不能证明可读。旧 v1 无附件包仍可恢复，旧包若 DB 含上传记录但缺原件则拒绝。不要接入已有会话 JSONL 清理 outbox 来删除附件。离线数据库迁移须先于服务启动执行；服务启动只验证迁移 head。实际部署前在隔离测试目录/数据库中验收两种存储方言和挂载。
