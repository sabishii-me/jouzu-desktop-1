import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  // The same `@` alias the app build uses, so render tests can load UI components.
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') } },
  plugins: [react()],
  test: { include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
});
