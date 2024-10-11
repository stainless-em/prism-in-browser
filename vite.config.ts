import { defineConfig } from "vite";
export default defineConfig({
  define: {
    "process.platform": '""',
    global: "globalThis",
    "process.browser": "true",
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        "process.platform": '""',
        "process.browser": "true",
      },
    },
  },
  resolve: {
    alias: {
      path: "rollup-plugin-node-polyfills/polyfills/path",
      url: "rollup-plugin-node-polyfills/polyfills/url",
      events: "rollup-plugin-node-polyfills/polyfills/events",
      os: "rollup-plugin-node-polyfills/polyfills/os",
      util: "rollup-plugin-node-polyfills/polyfills/util",
      buffer: "buffer",
    },
  },
});
