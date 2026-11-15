import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Temporary dev-server config for the cloud preview hostname (untracked, not part of the app).
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    // the cloud preview hostname changes between sandbox restores, so it comes from the env
    allowedHosts: [process.env.PREVIEW_HOST ?? 'pv-0cc8a9e664b7-4d0bba24-d3b5-4c92-8bb5-5c2d7504f726.style.dev'],
  },
});
