import { iconSource, type SourceIconName } from './icon-sources.js';

// Explicit fallback inventory: assets have no semantically equivalent glyphs.
const paths = {
  activity: "M4 18a9 9 0 1 1 16 0M12 13l5-6M12 16h.01",
  tokens: "M20 6c0 2-3.6 3-8 3S4 8 4 6s3.6-3 8-3 8 1 8 3ZM4 6v12c0 2 3.6 3 8 3s8-1 8-3V6M4 12c0 2 3.6 3 8 3s8-1 8-3",
  context: "M12 3a9 9 0 1 1-9 9 9 9 0 0 1 9-9ZM12 3v4",
  agents: "M8 5h8v5H8ZM4 16h5v5H4ZM15 16h5v5h-5ZM12 10v3M6 16v-3h12v3",
  tool: "m8 4-4 8 4 8M16 4l4 8-4 8M14 3l-4 18",
  markdown: "M3 18V6l5 6 5-6v12M19 6v12m-3-3 3 3 3-3",
  menu: "M4 6h16M4 12h16M4 18h16",
  shared: "M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0M5 21v-2a7 7 0 0 1 14 0v2M18 4a3 3 0 0 1 0 6M21 21v-2a7 7 0 0 0-3-5",
  inspector: "M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM15 3v18",
  download: "M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6",
  info: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18ZM12 11v5M12 8h.01",
} as const;
export type IconName = keyof typeof paths | SourceIconName | "dot";
/** Compatibility facade; mapping is owned by the pure tool metadata registry. */
export { toolIcon } from "../tools/metadata.js";
/** Decorative only: the containing control owns its accessible name. */
export function Icon({ name, size = 16, className = "", viewBox }: { name: IconName; size?: number; className?: string; viewBox?: string }) {
  const source = iconSource(name);
  if (source) return <svg data-icon={name} className={`ui-icon ${className}`} width={size} height={size} viewBox={viewBox ?? source.viewBox} fill="none" aria-hidden="true" focusable="false" dangerouslySetInnerHTML={{ __html: source.__html }} />;
  return <svg data-icon={name} className={`ui-icon ${className}`} width={size} height={size} viewBox={viewBox ?? "0 0 24 24"} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {name === "dot" ? <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" /> : <path d={paths[name as keyof typeof paths]} />}
  </svg>;
}
