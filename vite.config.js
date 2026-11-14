import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    proxy: {
      // JPL Horizons sends no CORS headers, so in dev we go through Vite
      '/jpl': {
        target: 'https://ssd.jpl.nasa.gov',
        changeOrigin: true,
        rewrite: p => p.replace(/^\/jpl/, '/api'),
      },
    },
  },
});
