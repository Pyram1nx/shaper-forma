import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // three.js (3D Carve) is code-split into its own chunk; it's large by nature.
    chunkSizeWarningLimit: 800,
  },
})
