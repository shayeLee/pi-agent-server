import type { Locator } from '@playwright/test';

// Include descendants: focus-within/has rules can affect labels and chevrons.
export async function appearance(locator: Locator) {
  return locator.evaluate(root => [root, ...root.querySelectorAll('*')].map(el => {
    const style = getComputedStyle(el);
    return Object.fromEntries([
      'background-color', 'background-image', 'color', 'border-color', 'border-width',
      'box-shadow', 'outline-style', 'outline-width', 'text-decoration', 'opacity',
      'visibility', 'display', 'caret-color',
    ].map(property => [property, style.getPropertyValue(property)]));
  }));
}
