// 项目信任（GET/PUT /v1/projects/:id/trust）的公开 DTO，服务端与 Web 共用。
// 信任记录就是 Pi 的 trust.json，和 pi CLI 的信任提示改的是同一份；所有人能看，只有 admin 能改。

export type DefaultProjectTrust = "ask" | "always" | "never";

/** 受信任时才加载的项目文件。 */
export const PROJECT_TRUST_FILES = [".pi/mcp.json", ".pi/settings.json", ".pi/SYSTEM.md", ".pi/APPEND_SYSTEM.md"] as const;

export interface ProjectTrustView {
  readonly trusted: boolean;
  /** project：trust.json 里有这个项目自己的记录；parent：沿用上级目录的记录；default：没有记录，按 defaultProjectTrust。 */
  readonly source: "project" | "parent" | "default";
  /** source 为 parent 时，是那条记录的目录。 */
  readonly entryPath?: string;
  /** 全局 settings.json 里的 defaultProjectTrust（没写时为 ask）。 */
  readonly defaultTrust: DefaultProjectTrust;
  /** 调用者能否修改（只有 admin）。 */
  readonly canEdit: boolean;
  /** 项目里有哪些受信任才加载的文件。 */
  readonly files: readonly { readonly name: (typeof PROJECT_TRUST_FILES)[number]; readonly exists: boolean }[];
}

/** PUT /v1/projects/:id/trust：在 trust.json 里给这个项目记一条信任或不信任。 */
export interface ProjectTrustInput {
  readonly trusted: boolean;
}
