// application/capabilities barrel export
export type {
  CapabilityManifest,
  ToolManifest,
  ToolCategory,
  PromptFragmentManifest,
} from "./manifest.js";
export type { CapabilitySnapshot } from "./compose.js";
export { composeCapabilities } from "./compose.js";
export { CapabilityRegistry } from "./registry.js";
export { collectPromptFragmentSources } from "./prompt-composer.js";
