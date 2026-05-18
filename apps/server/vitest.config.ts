import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `resolve.conditions: ['source']` zwingt Vite/Vitest beim Aufloesen von
  // `@mcp-approval2/<pkg>`-Imports den `source`-Eintrag aus package.json
  // `exports` zu nehmen (= `src/index.ts`) statt den `default`-Eintrag
  // (= `dist/index.js`). Damit laufen Tests ohne vorherigen Build.
  // Production-Node ignoriert `source` und faellt auf `default` zurueck.
  resolve: {
    conditions: ['source'],
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/_to_delete/**'],
    coverage: {
      reporter: ['text', 'json-summary'],
    },
  },
});
