const paths = {
  activity: "M4 18a9 9 0 1 1 16 0M12 13l5-6M12 16h.01",
  tokens: "M20 6c0 2-3.6 3-8 3S4 8 4 6s3.6-3 8-3 8 1 8 3ZM4 6v12c0 2 3.6 3 8 3s8-1 8-3V6M4 12c0 2 3.6 3 8 3s8-1 8-3",
  context: "M12 3a9 9 0 1 1-9 9 9 9 0 0 1 9-9ZM12 3v4",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v5l3 2",
  terminal: "m4 6 6 6-6 6M13 18h7",
  file: "M14 3H5v18h14V8ZM14 3v5h5M8 12h8M8 16h6",
  agents: "M8 5h8v5H8ZM4 16h5v5H4ZM15 16h5v5h-5ZM12 10v3M6 16v-3h12v3",
  tool: "m8 4-4 8 4 8M16 4l4 8-4 8M14 3l-4 18",
  markdown: "M3 18V6l5 6 5-6v12M19 6v12m-3-3 3 3 3-3",
  plus: "M12 5v14M5 12h14",
  close: "m6 6 12 12M6 18 18 6",
  chevron: "m9 5 7 7-7 7",
  down: "m5 9 7 7 7-7",
  check: "m5 12 4 4L19 6",
  send: "M12 19V5m-7 7 7-7 7 7",
  menu: "M4 6h16M4 12h16M4 18h16",
  ellipsis: "M5 12h.01M12 12h.01M19 12h.01",
  search: "M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  folder: "M3 7V5h7l2 2h9v13H3Z",
  shared: "M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0M5 21v-2a7 7 0 0 1 14 0v2M18 4a3 3 0 0 1 0 6M21 21v-2a7 7 0 0 0-3-5",
  sidebar: "M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM9 3v18",
  inspector: "M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM15 3v18",
  edit: "m15 3 6 6-12 12H3v-6ZM13 5l6 6",
  download: "M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
  copy: "M9 9h12v12H9ZM15 5V3H3v12h2",
  sun: "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5",
  moon: "M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z",
} as const;
export type IconName = keyof typeof paths | "stop" | "dot" | "caret";
/** Compatibility facade; mapping is owned by the pure tool metadata registry. */
export { toolIcon } from "../tools/metadata.js";
/** Decorative only: the containing control owns its accessible name. */
export function Icon({ name, size = 16, className = "" }: { name: IconName; size?: number; className?: string }) {
  return <svg data-icon={name} className={`ui-icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {name === "stop" ? <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" /> : name === "dot" ? <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" /> : name === "caret" ? <rect x="11" y="3" width="2" height="18" rx="1" fill="currentColor" stroke="none" /> : <path d={paths[name]} />}
  </svg>;
}
