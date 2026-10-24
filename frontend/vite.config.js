import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// React JSX aur fast refresh ke liye Vite plugin use kar rahe hain.
export default defineConfig({
  plugins: [react()],
});
