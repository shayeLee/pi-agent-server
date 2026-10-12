import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const merge = extendTailwindMerge({ prefix: "ui" });
/** Resolve only prefixed foundation utilities; preserve existing application classes. */
export function cn(...inputs: ClassValue[]) {
  return merge(clsx(inputs));
}
