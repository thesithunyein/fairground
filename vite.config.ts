import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 3120, strictPort: true },
  build: {
    target: 'es2022',
    // Keep it tiny — the jam requires near-instant load.
    chunkSizeWarningLimit: 600,
  },
});
