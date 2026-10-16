/**
 * Pi always appends the session's cwd section after a custom prompt. A frozen prompt was captured
 * with Pi's own cwd section inside it, so restoring it verbatim would repeat the cwd. The last
 * standalone cwd section is removed and Pi re-adds the current one:
 * - a plain session ends with that section, so an unmoved session restores byte-for-byte;
 * - a mode-append session has its addendum after it (joined by a blank line), so the cwd moves
 *   to the end but appears once.
 * Frozen prompts from Pi ≤0.85.1 end with a plain line instead of a section.
 *
 * Project context (AGENTS.md) and skills are live session resources: Pi re-adds them from the
 * session loader after a custom prompt, and /reload refreshes them. Their frozen copies are
 * removed the same way, so a restored session carries them once and in Pi's own order. Prompts
 * frozen before these resources were loaded simply have nothing to remove.
 */
const CWD_SECTION = /\n\n<cwd>\n[^\n]*\n<\/cwd>(?=\n\n|$)/g;
const TRAILING_CWD_LINE = /\nCurrent working directory: [^\n]*\n?$/;
const LIVE_SECTIONS = ["project_context", "skills"] as const;

/** Removes the last `<name>` section; its body may span lines and blank lines. */
function withoutLastSection(prompt: string, name: string): string {
  const start = prompt.lastIndexOf(`\n\n<${name}>\n`);
  if (start < 0) return prompt;
  const close = `\n</${name}>`;
  for (let end = prompt.indexOf(close, start); end >= 0; end = prompt.indexOf(close, end + 1)) {
    const after = end + close.length;
    if (after === prompt.length || prompt.startsWith("\n\n", after)) return prompt.slice(0, start) + prompt.slice(after);
  }
  return prompt;
}

export function frozenPromptBase(prompt: string): string {
  const last = [...prompt.matchAll(CWD_SECTION)].at(-1);
  let base = last ? prompt.slice(0, last.index) + prompt.slice(last.index + last[0].length) : prompt.replace(TRAILING_CWD_LINE, "");
  for (const name of LIVE_SECTIONS) base = withoutLastSection(base, name);
  return base;
}
