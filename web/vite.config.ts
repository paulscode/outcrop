/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// The console API (console/dev.py runs it on :8800).  The proxy keeps the browser's Host and Origin, which the console
// accepts from http://localhost:5173 in dev mode.
const backend = process.env.OUTCROP_BACKEND ?? 'http://localhost:8800'

/**
 * The console's CSP is style-src 'self': nothing may add a <style> element or a style="…" attribute at runtime.  sonner
 * injects its stylesheet that way on import, so its injector is switched off here and main.tsx imports
 * sonner/dist/styles.css instead.  The build fails if sonner's code changes and the patch no longer applies.
 */
function noRuntimeStyles(): Plugin {
  const guard = "if (!code || typeof document == 'undefined') return"
  return {
    name: 'outcrop-no-runtime-styles',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]sonner[\\/]dist[\\/]index\.m?js$/.test(id)) return null
      if (!code.includes(guard)) this.error(`sonner changed: cannot switch off its <style> injection in ${id}`)
      return { code: code.replace(guard, 'return'), map: null }
    },
  }
}

export default defineConfig({
  plugins: [noRuntimeStyles(), react(), tailwindcss()],
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      // see src/shims/react-style-singleton.ts
      { find: /^react-style-singleton$/, replacement: fileURLToPath(new URL('./src/shims/react-style-singleton.ts', import.meta.url)) },
    ],
  },
  optimizeDeps: {
    // pre-bundling would skip the alias and the transform above in development
    exclude: ['sonner', 'react-style-singleton'],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: backend, ws: true, changeOrigin: false },
      '/ca.crt': { target: backend, changeOrigin: false },
      '/strata/': { target: backend, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react'
          if (id.includes('@tanstack')) return 'tanstack'
          // Motion (shared by the pages that animate lanes); named, or Rollup calls it "react" after motion/react
          if (/[\\/]node_modules[\\/](\.pnpm[\\/])?(motion|framer-motion|motion-dom|motion-utils)[@\\/]/.test(id)) return 'motion'
          return undefined
        },
      },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
