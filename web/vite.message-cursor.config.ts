import config from "./vite.config.js";

// Never proxy fixture requests to a real backend.
export default { ...config, server: { host: "127.0.0.1", proxy: {} } };
