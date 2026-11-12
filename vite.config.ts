import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
