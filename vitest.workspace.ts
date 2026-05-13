// Vitest Workspace Config — laeuft die Test-Suites aller Sub-Packages
// in einem Lauf. Pfadliste muss synchron mit `package.json#workspaces`
// gehalten werden, sobald neue packages/apps dazukommen.
//
// Hinweis: `apps/server/vitest.config.ts` existiert in Phase 0 noch nicht;
// die Referenz bleibt drin, damit der Workspace beim Anlegen automatisch
// mitlaeuft. Vitest meldet die fehlende Datei als Warnung bis sie angelegt
// ist — bewusst so akzeptiert (Spec: "funktioniert wenn die referenzierten
// configs existieren").

import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  './packages/core/vitest.config.ts',
  './packages/adapters/vitest.config.ts',
  './apps/server/vitest.config.ts',
]);
