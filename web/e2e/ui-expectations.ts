// styles/tokens.css seven-level scale and dedicated session-title exception.
export const FONT_SIZE = {
  xs: 10, sm: 11, baseSm: 12, md: 13, base: 14, lg: 16, xl: 20, sessionTitle: 18,
} as const;
// Named coverage scenarios, not responsive breakpoints or production expectations.
export const COMPOSER_VIEWPORT_CASES = [
  { name: 'wide-desktop', width: 1440, height: 844, layout: 'desktop' },
  { name: 'desktop', width: 1280, height: 844, layout: 'desktop' },
  { name: 'narrow-mobile', width: 390, height: 844, layout: 'mobile' },
] as const;
