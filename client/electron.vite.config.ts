import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const ambireAlias = {
  '@ambire-common': resolve('src/ambire-common/src'),
  // validator's ESM deep import path lacks .js extension in ambire-common;
  // redirect to the CJS build which Node resolves without extension.
  'validator/es/lib/isEmail': resolve('node_modules/validator/lib/isEmail.js'),
}

export default defineConfig({
  main: {
    // Exclude 'validator' from externalization so Vite can apply the alias
    // that redirects its broken ESM subpath to the CJS build.
    plugins: [externalizeDepsPlugin({ exclude: ['validator'] })],
    resolve: {
      alias: ambireAlias,
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: ambireAlias,
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
        },
      },
    },
  },
  renderer: {
    define: {
      // WalletConnect's transitive deps reference `global`; remap to globalThis.
      global: 'globalThis',
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
        ...ambireAlias,
      },
    },
    plugins: [react()],
  },
})
