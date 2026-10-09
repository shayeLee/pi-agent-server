// The runtime alias resolves lowlight's bundled highlight.js dependency.
declare module "highlight.js/lib/languages/*" {
  const grammar: import("lowlight").LanguageFn;
  export default grammar;
}
