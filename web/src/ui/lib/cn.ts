import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge must know the custom scales, otherwise e.g. `text-chat` (size) and
// `text-fg` (color) are treated as conflicting and one is dropped.
const merge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["2xs", "xs", "sm", "base", "chat", "lg", "xl", "2xl"],
      radius: ["xs", "sm", "md", "lg", "xl"],
      shadow: ["popover", "dialog", "composer"],
      font: ["text", "code"],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
