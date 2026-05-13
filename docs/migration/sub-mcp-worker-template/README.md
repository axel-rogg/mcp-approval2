# Sub-MCP-Worker-Template

Reference-Implementation fuer einen Sub-MCP-Worker, der mit `mcp-approval2`'s
Multi-User-Pattern (`X-User-JWT`-Header + JIT-Credential-Resolve) integriert.

Sieh dazu auch [../sub-mcp-server-migration-guide.md](../sub-mcp-server-migration-guide.md) fuer den
vollen Migrations-Pfad (v1-single-user → v2-multi-user).

---

## Was ist hier drin?

| File | Zweck |
|---|---|
| `wrangler.toml` | Cloudflare-Workers-Config (production/staging Bindings, KV-Stub). Edit `name`, `routes`, `vars`. |
| `src/index.ts` | Hono-Server-Skeleton mit `/health`, `/mcp` (tools/list + tools/call). |
| `src/auth.ts` | Zweistufige Auth-Middleware (Service-Bearer + User-JWT-Verify, HS256 today, RS256-ready). |
| `src/credentials.ts` | JIT-Credential-Resolver — wrappt `POST mcp-approval2/internal/v1/credentials/resolve`. |
| `src/tools/example-tool.ts` | Beispiel-Tool das nichts braucht ausser dem User-Context — als Skeleton zum Forken. |

Das Template ist **CF-Workers-zentrisch** (deshalb `wrangler.toml`), aber `src/*` ist plattform-agnostisch.
Du kannst genauso gut auf Node + `@hono/node-server` deployen — der Service-Token + JWT-Flow funktionieren
identisch.

---

## Adoption-Schritte

### 1. Fork / Copy

```bash
# Repo-Pfad anpassen je nach existing Sub-MCP-Repo
cp -r docs/migration/sub-mcp-worker-template/ my-sub-mcp/
cd my-sub-mcp/
```

### 2. `package.json` anlegen

```json
{
  "name": "mcp-<your-name>",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "hono": "^4.12.0",
    "jose": "^5.10.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20240909.0",
    "typescript": "^5.7.0",
    "wrangler": "^3.78.0"
  }
}
```

`npm install` — fertig.

### 3. Env-Vars setzen

In `wrangler.toml` unter `[vars]` (Plain-Werte) bzw. via `wrangler secret put` (sensibel):

| Var | Plain/Secret | Wert |
|---|---|---|
| `SUB_MCP_NAME` | plain | `gws` / `utils` / dein Name |
| `MCP_APPROVAL_BASE_URL` | plain | `https://mcp.<tenant>.example.com` |
| `MCP_APPROVAL_JWT_ISSUER` | plain | `mcp-approval2` |
| `SERVICE_TOKEN` | **secret** | aus mcp-approval2-Registrierung |
| `MCP_APPROVAL_JWT_SECRET` | **secret** | gleiches Secret wie mcp-approval2 (HS256-shared) |

### 4. In mcp-approval2 registrieren

Auf mcp-approval2-Admin-Surface (oder direkt via DB-Migration in Pilot-Phase):

```bash
curl -X POST https://mcp.<tenant>.example.com/v1/admin/sub-mcp/register \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-sub-mcp",
    "display_name": "My Sub-MCP",
    "base_url": "https://my-sub-mcp.example.com",
    "auth_mode": "service_bearer",
    "service_token_plain": "<generated-32-char-random>",
    "enabled": true
  }'
```

Antwort enthaelt die `id` — den Token-Plain-Wert bekommst **du** zurueck und musst ihn als
`wrangler secret put SERVICE_TOKEN` in dein Sub-MCP deployen.

### 5. Eigene Tools einbauen

Pro Tool: file unter `src/tools/<name>.ts` anlegen, im Pattern von `example-tool.ts`. Tools werden in
`src/index.ts` ueber eine simple Map registriert (`TOOL_REGISTRY`). Tool-Funktion erhaelt
`{ userId, resolveCredential, args }` und liefert MCP-Content-Array zurueck.

### 6. Deploy

```bash
wrangler deploy
```

### 7. Smoke

Siehe Migration-Guide §1 Phase 5 oder das zentrale `scripts/pilot-smoke.sh` in mcp-approval2-Repo.

---

## Typecheck

```bash
npm run typecheck
```

Muss clean sein. `jose` + `hono` haben volle TypeScript-Defs.

---

## Sicherheits-Notizen

- **Kein User-Token-Storage im Sub-MCP.** Jeder Token kommt JIT ueber `/internal/v1/credentials/resolve`
  und ist request-scoped. Niemals in einem Cache, einem Log oder einer KV festhalten.
- **Service-Token-Rotation.** Wenn das `SERVICE_TOKEN` rotiert wird, muss mcp-approval2 **gleichzeitig**
  re-registriert werden (neuer Hash in `sub_mcp_servers.auth_config.service_token_hash`). Out-of-band
  Koordination ist Pflicht — siehe runbook-token-rotation.md.
- **JWT-Secret-Rotation.** Wir teilen heute ein `JWT_SECRET` (HS256). Rotation bedeutet beide Worker
  gleichzeitig env-tauschen. Bei RS256 (Phase 8) reicht JWKS-Refresh.
- **Logging.** NIEMALS access_token, refresh_token, JWT-Payload oder Service-Token loggen. Best-Practice:
  in der Auth-Middleware nur `user_id` (= jwt.sub) ins request-context-log schreiben.
