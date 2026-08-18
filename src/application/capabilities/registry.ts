// 能力注册表：注册、启用、会话冻结与审计的唯一来源。
// 能力通过 register 显式启用；未被注册（或未启用）的能力工具与资源不可达。

import type { CapabilityManifest } from "./manifest.js";
import { composeCapabilities, type CapabilitySnapshot } from "./compose.js";

export class CapabilityRegistry {
  private readonly manifests = new Map<string, CapabilityManifest>();

  /** 注册并启用一个能力；重复 id 视为配置错误。 */
  register(manifest: CapabilityManifest): void {
    if (this.manifests.has(manifest.id)) {
      throw new Error(`能力已注册: ${manifest.id}`);
    }
    this.manifests.set(manifest.id, manifest);
  }

  get(id: string): CapabilityManifest | undefined {
    return this.manifests.get(id);
  }

  /** 已启用能力清单（当前注册即启用）。 */
  enabled(): readonly CapabilityManifest[] {
    return [...this.manifests.values()];
  }

  /** 冻结当前已启用能力的解析快照（供会话创建时使用）。 */
  snapshot(): CapabilitySnapshot {
    return composeCapabilities(this.enabled());
  }
}
