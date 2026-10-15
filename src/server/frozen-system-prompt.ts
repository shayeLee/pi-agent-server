/**
 * Pi always appends the session's cwd section after a custom prompt. A frozen prompt was captured
 * with Pi's own cwd section inside it, so restoring it verbatim would repeat the cwd. The last
 * standalone cwd section is removed and Pi re-adds the current one:
 * - a plain session ends with that section, so an unmoved session restores byte-for-byte;
 * - a mode-append session has its addendum after it (joined by a blank line), so the cwd moves
 *   to the end but appears once.
 * Frozen prompts from Pi ≤0.85.1 end with a plain line instead of a section.
 */
const CWD_SECTION = /\n\n<cwd>\n[^\n]*\n<\/cwd>(?=\n\n|$)/g;
const TRAILING_CWD_LINE = /\nCurrent working directory: [^\n]*\n?$/;

export function frozenPromptWithoutCwd(prompt: string): string {
  const last = [...prompt.matchAll(CWD_SECTION)].at(-1);
  if (last) return prompt.slice(0, last.index) + prompt.slice(last.index + last[0].length);
  return prompt.replace(TRAILING_CWD_LINE, "");
}
