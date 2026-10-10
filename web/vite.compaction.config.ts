import config from "./vite.config.js";
// No real backend proxy in the isolated fixture.
export default { ...config, server: { host: "127.0.0.1", proxy: {} } };
