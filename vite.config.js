import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss()],
  clearScreen: false,
  esbuild: {
    legalComments: 'none'
  },
  build: {
    rollupOptions: {
      input: {
        main: './index.html',
        app: './app.js'
      }
    }
  }
});
