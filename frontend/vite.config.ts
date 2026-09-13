import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Docker Desktop on Windows doesn't propagate native fs-change events
    // for bind-mounted files edited from the host side into the container,
    // so HMR silently stops working there without polling.
    watch: {
      usePolling: process.env.VITE_USE_POLLING === 'true',
    },
  },
})
