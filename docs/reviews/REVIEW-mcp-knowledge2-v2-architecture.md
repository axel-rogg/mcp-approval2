# Review — PLAN-mcp-knowledge2-v2-architecture.md

> Status: **APPROVE-WITH-CHANGES**
> Reviewer: subagent-claude, 2026-05-14
> Plan-Stand: 552 Zeilen, 12 Sektionen, Entwurf 2026-05-14

## Executive Summary

Der Plan ist insgesamt solide gedacht — die Adapter-Boundary stimmt, env-Naming
ist nah am Bestand, und die Doppler/Compose-Diffs sind realistisch. Aber er
trifft falsche Aussagen ueber den Bestands-Code (Vertex-Default-Region,
ObjectKind='app_state', KEK-Ref-Form, MCP_APPROVAL_INTERNAL_TOKEN-Laenge) und
verschweigt einen Architektur-Bruch: die heutige `KnowledgeService`-Surface in
mcp-approval2 erwartet bereits einen v2-Wire (D-1..D-12 RESOLVED), in dem es
weder `object_refs` noch `object_tags` als first-class-Routen gibt — die werden
durch `meta.resource_ids` simuliert. Der Plan schreibt aber, das v1-Graph-
Pattern werde "1:1 portiert". Eines von beiden ist falsch.

## Findings (sortiert nach Severity)

### CRITICAL

- **C1: ObjectKind-Wert `app_state` existiert v2-seitig nicht** — §3 Port-Inventur
  + §5.3 Schluessel-Konvention + §8.1.
  Plan-Behauptung: kind='app_state' wird portiert.
  Realitaet:
  `packages/adapters/src/knowledge/types.ts:21` `ObjectKind = 'doc'|'skill'|'app'|'memo'`.
  Der ganze v2-Wire (incl. PWA-Proxy in `routes/knowledge-proxy.ts:36`) kennt
  nur `'app'`. mcp-knowledge v1 nutzt `'app_state'` (siehe
  `/workspaces/mcp-knowledge/migrations/0001_objects.sql:21`).
  Fix: §3 + §8 expliziten Rename-Schritt aufnehmen
  (`'app_state' → 'app'`) und alle 17 apps-Tools entsprechend portieren. Sonst
  bricht der Cross-Service-Contract sofort beim ersten apps.invoke.

- **C2: object_refs / object_tags fehlen im v2-Wire** — §3 Port-Inventur,
  §9.2 API-Surface.
  Plan-Behauptung: refs+tags werden 1:1 als Schema portiert (Tabelle in §11
  setzt das ebenfalls voraus).
  Realitaet:
  `apps/server/src/services/knowledge.ts:150-273` modelliert die Skill-Resource-
  Beziehung schon HEUTE ueber `meta.resource_ids` als Workaround weil "KC2 hat
  heute keine dedizierten /v1/refs-Routen" (Zeile 152). Der Plan dokumentiert
  nicht, ob v2 die nativen refs/tags-Routes nachreicht (und damit den
  Workaround in `attachDocToSkill`, `docUsages`, `readSkillResource` aufloest)
  oder die meta-basierte Variante als final adoptiert. Beide sind moeglich
  — aber das ist eine Architektur-Entscheidung, keine Trivialitaet.
  Fix: §3 + §8 einen Block "Refs/Tags-Strategie" aufnehmen. Wenn nativ:
  REST-Endpoints + Schema-Migration definieren; bei meta-only: explizit
  sagen dass `addObjectRef`/`syncRefcount`/`object_tags`-Audit-H... aus v1
  NICHT portiert wird, und refcount-Bookkeeping anders geloest wird
  (z.B. Vectorize-Cleanup wandert in Cron).

### HIGH

- **H1: AAD-Recordtype-Drift** — §2/§3 Crypto-Reuse (Q2).
  Plan-Vorschlag: `@mcp-approval2/core/crypto` reusen, "AAD-Convention
  semantisch identisch (`<recordType>|<id>|<kind>:<subtype>`)".
  Realitaet:
  v1 nutzt VIER recordTypes (`objects`, `objects-desc`, `objects-produced-for`,
  `objects-quality` — siehe `migrations/0001_objects.sql:7-11` v1).
  `packages/core/src/crypto/aad.ts` exportiert `AadRecordType` mit fixer
  Liste (credentials/session/audit/object/generic — siehe `aad.ts`). Heisst
  konkret: das core-AAD-Modul **kennt aktuell nicht** die description-/
  produced-for-/quality-Varianten. Reuse erfordert ENTWEDER core-Erweiterung
  (4 zusaetzliche AadRecordType-Werte plus Tests) ODER explizite Fork-Strategie
  fuer description/produced-for/quality. Plan sagt das nicht.
  Fix: Q2-Entscheidung mit konkretem Plan: "core/aad.ts erweitern um
  object-desc / object-produced-for / object-quality" (1-2h Aufwand) ODER
  knowledge2 hat eigenes minimales aad-Helper (4h).

- **H2: AiAdapter `embed()` defaultet 768-dim, aber Region-Override fehlt**
  — §6.2 + §4.1.
  Behauptung Plan: `VERTEX_AI_REGION` default `europe-west4` (sauber).
  Realitaet: `packages/adapters/src/ai/vertex.ts:87-89` Konstanten DEFAULT_REGION,
  DEFAULT_EMBED_MODEL, DEFAULT_CHAT_MODEL sind alle bereits korrekt
  (`europe-west4`, `text-embedding-005`, `gemini-2.0-flash-exp`). Aber
  Plan sagt in §4.3 `VERTEX_REGION` (alt) muesse zu `VERTEX_AI_REGION` (neu)
  umbenannt werden — das ist im Server-Block (Z.122) schon `VERTEX_AI_REGION`.
  Nur der Knowledge-Block (Z.155-156) nutzt noch `VERTEX_REGION`/`VERTEX_PROJECT_ID`.
  Fix klar: §10.3 explizit dokumentieren dass Z.155+156 in compose
  umzubenennen sind, sonst startet mcp-knowledge2 mit `undefined`-Region
  (zod-default greift, aber das ist Glueck, kein Vertrag).

- **H3: KEK-Ref-Form passt nicht zum existierenden OpenBaoKekProvider**
  — §1 + §3 KEK-Mapping.
  Plan: KEK-Namespace `vault://transit/keys/knowledge2`.
  Realitaet: `packages/adapters/src/kek/openbao.ts:7` Comment + `:113`
  REF_PATTERN: erwartet `vault://<mount>/keys/<keyName>` — passt, ABER die
  Konvention in mcp-approval2 ist `user-<user_id>` als keyName (per-User-DEK,
  siehe `openbao.ts:7`). Single-Tenant in v2 ok, aber wenn knowledge2 spaeter
  Multi-User wird (PLAN-multi-user-isolation), wuerde EIN globaler `knowledge2`-
  KEK alle User-Daten gleichzeitig kompromittieren. Plan sagt §1: "eigener
  KEK-Namespace" — das ist sicher gegen approval2, aber NICHT user-isolierend.
  Fix: §1 + §6 klar machen: Pilot single-tenant ok mit globalem
  `knowledge2`-key; Multi-User-Cutover braucht `knowledge2-user-<userId>`
  Pattern (1 Migration, Re-Wrap-Loop). Aufnehmen in Q3 oder neues Q9.

- **H4: D9 multi-kind search ist NICHT resolved** — §8.2 search-rewrite.
  Plan sagt: tool-Schema bleibt identisch.
  Realitaet:
  `docs/CROSS-SERVICE-CONTRACT-RESOLUTION.md:28` D-9 ist "⏳ partially
  resolved" — Server akzeptiert nur single kind. Der Plan §8.2 sagt
  "Komplett rewrite auf RRF-Pattern. Tool-Schema bleibt identisch", erwaehnt
  aber nicht ob v2 endlich `kind: ObjectKind[]` zod-akzeptieren wird.
  Fix: §8 + §11.2 Q? explizit aufnehmen: "v2 implementiert multi-kind
  search-Request server-side (zod schema `kind: ObjectKind | ObjectKind[]`)"
  — sonst bleibt der adapter forward-compat-Code im http-client toter Pfad.

- **H5: Vectorize-eventually-consistent-Problem fehlt im Schema-Mapping**
  — §6.1 pgvector-Schema.
  Realitaet: v1 hat sowohl Vectorize ALS AUCH ein D1-Mirror der Embeddings
  (`embedding_blob BLOB` in objects, siehe migration 0001 Zeile 65-67).
  Begruendung: Vectorize ist eventually-consistent (5-30 min Lag). Bei
  pgvector ist das Problem WEG (synchron). Der Plan loescht den D1-Mirror
  implizit — das ist korrekt, sollte aber explizit als "Konsistenz-Bonus
  in v2" benannt werden, sonst denkt ein spaeterer Subagent man muesse
  beides parallel halten. Auch: HNSW-Index-Updates synchron mit INSERT
  (vs Vectorize-async-pipeline) — Insert-Latenz steigt, das ist neu.
  Fix: §6.1 ein Absatz "Konsistenz-Modell" mit explizitem Hinweis
  "pgvector ist synchron, kein D1-Mirror noetig, dafuer +5-15ms INSERT-
  Latenz".

### MEDIUM

- **M1: postgres-init.sql schon angepasst, Plan glaubt es muss noch
  passieren** — §10.3 + Phase 1.
  Realitaet: `deploy/hetzner/postgres-init.sql` createt schon
  `knowledge2`-DB + `CREATE EXTENSION vector` in beiden DBs.
  Fix: §10.3 Bullet "postgres-init.sql erweitern" streichen, statt
  "schon erledigt im Bestand" markieren.

- **M2: MCP_APPROVAL_INTERNAL_TOKEN Pflicht-Laenge >= 32 chars** — §4.1.
  Realitaet: `apps/server/src/lib/config.ts:40` `min(32)`. Plan zeigt
  `z.string().min(32)` — passt. Aber: das Token wird in compose.yml:108+154
  geshared zwischen approval2 und knowledge2 ueber Env. Plan dokumentiert
  das schon (§7.2). Nit: Rotation-Cadence fehlt. CLAUDE.md sagt 30-Tage
  Token-Rotation fuer CF-Access — fuer service tokens muss der Plan eine
  Cadence + Doppler-Rotation-Runbook nennen.
  Fix: §7.2 Hinweis "Rotation 90 Tage (oder mit Doppler-Secret-Rotation-
  Sync); shared-Pflege via beide Compose-Container".

- **M3: §11 Risiko-Tabelle nennt JWKS-Pull-503-Race, aber Bestand hat
  schon `waitForDb` — `waitForJwks` ist nicht spezifiziert** — §11.1.
  Plan-Behauptung: "jose.createRemoteJWKSet cached + retried automatisch".
  Realitaet: `createRemoteJWKSet` retried bei einzelnen Requests, aber
  beim Boot ist der erste request bei kaltem mcp-approval2 ein hard-fail
  → erster API-Call kommt mit 503 zurueck. v1 hat dafuer keinen Boot-
  Preflight. mcp-approval2/apps/server/src/index.ts:213-243 hat `waitForDb`,
  und der Plan §3 Phase-Liste erwaehnt `waitForVault()` — aber kein
  `waitForApprovalJwks()`.
  Fix: §7.1 Boot-Preflight definieren: HTTP-GET gegen `JWKS_URL` mit
  Retry, 30s budget. Phase-2-Liste in §12 entsprechend ergaenzen.

- **M4: `docs/reviews/` existiert nicht im Bestand** — Tool/Process-nit.
  Realitaet: `ls /workspaces/mcp-approval2/docs/reviews/` → not exist.
  CLAUDE.md sagt das directory ist Audit-Trail. Plan referenziert keinen
  Review-Workflow.
  Fix: Plan-Sektion "12.x — Doku-Pflichten" aufnehmen: review-Briefs nach
  Phase 0 + Phase 7 in `docs/reviews/` ablegen.

- **M5: Implementation-Sequenz: Phase 1 vor Phase 2 erstellt JWT-Tests
  ohne JWKS-Provider** — §12 Phase 2.
  Realitaet: Phase 2 schreibt JWT-Vitest gegen Stub-JWKS. Aber JWKS-Stub
  braucht RS256-Keypair und `apps/server/src/auth/jwt-signing.ts` (siehe
  Bestand) hat den Bauplan. Plan erwaehnt das nicht.
  Fix: Phase 2 expliziter Bullet "ports `jwt-signing.ts`-Stub-Generator
  fuer Test-Fixtures".

### LOW

- **L1: §10.4 Doppler-Placeholders — `KNOWLEDGE_TAG` ist neu** — passt,
  aber Default `latest` widerspricht Watchtower-Rolling-Restart-Pattern.
  In compose.yml:144 ist es schon `${KNOWLEDGE_TAG:-latest}`. Nit.

- **L2: Plan Estimate 70-100h** — Subjektiv plausibel fuer Single-Engineer
  mit Subagent-Hilfe; Verweis auf "PLAN-architecture-v1 Phasen-Bursts"
  als Massstab waere belastbarer.

- **L3: §11.1 Risiko "Adapter-Coupling" → ESLint** — gut, aber bewaehrter
  ist `dependency-cruiser` (im monorepo schon dafuer da)? Optional.

- **L4: DSGVO-Pruefung in §1 erwaehnt nur Region, nicht Vertex-DPA-Status**
  — Google Workspace-API-Pfade in mcp-approval2 nutzen schon Workspace-DPA;
  Vertex AI braucht eigenen DPA (Google Cloud Customer Data Processing
  Addendum). Plan nimmt Existenz an. Sollte vor Phase 7 verifiziert sein.

## Bestaetigte Annahmen (was der Plan richtig macht)

- §1 Adapter-Pattern korrekt — DbAdapter/BlobAdapter/KekProvider/AiAdapter sind
  alle in `packages/adapters/src/index.ts` exportiert.
- §5.2 S3BlobAdapter unveraendert wiederverwendbar — `endpoint`+`forcePathStyle`
  sind options; Hetzner ist S3v4. Verifiziert.
- §6.2 AiAdapter hat `embed(args: EmbedArgs): Promise<Float32Array[]>` —
  verifiziert in `vertex.ts:128`. Default-Model bereits 768-dim
  `text-embedding-005`. Plan-Annahme korrekt.
- §4.1 Naming-Konvention zod + translateBootEnv-Pattern — passt zum Stil in
  `apps/server/src/lib/config.ts` + `apps/server/src/index.ts:45-68`.
- §9.1 v2 startet leer — korrekt, kein Datenimport-Risiko.
- §10.2 Migrate-Pattern (separater compose-service mit `restart: "no"`) —
  konform mit Bestand.
- §10.5 Caddyfile.tpl `${DOMAIN_KNOWLEDGE}` ist schon vorgesehen (siehe
  Caddyfile.tpl-Kopf). Plan-Aenderung minimal.
- D-1..D-12 Wire-Vertrag — alle in `docs/CROSS-SERVICE-CONTRACT-RESOLUTION.md`
  resolved (ausser D-9 forward-compat). Plan respektiert die.

## Offene User-Entscheidungen (vom Architekt markiert + meine Position)

- **Q1 Image-Tag:** behalten (`ghcr.io/axel-rogg/mcp-knowledge2`). Empfehlung:
  zustimmen. Refactor-Kosten > semantischer Gewinn.
- **Q2 Crypto-Reuse:** Reuse, ABER mit core/aad.ts-Erweiterung um 3 weitere
  recordTypes (objects-desc/-produced-for/-quality). Sonst Fork bei v1-Crypto-
  Modul akzeptieren — nicht der "default reuse" wie Plan suggeriert.
- **Q3 Dim 768:** zustimmen. Pilot ist leer, Schema-Migration kostenfrei.
- **Q4 Idempotency PG:** zustimmen. Single-User; PG-Pattern ist sauber.
- **Q5 Cron:** zustimmen (node-cron Phase 1). pg-boss erst wenn Job-
  Vielfalt > 5.
- **Q6 Uploads:** zustimmen. AWS-SDK `s3-request-presigner` ist Standard.
- **Q7 Sharing:** keine offene Frage — gut, dass markiert.
- **Q8 TF-State R2:** zustimmen. CLAUDE.md hat das explizit.
- **Neuer Q9 (von mir):** "KEK-Ref-Form pro Tenant (multi-user) vs global
  (single-tenant)?" — empfehle Pilot global, mit dokumentiertem Migrations-
  Pfad zu `knowledge2-user-<userId>`.
- **Neuer Q10 (von mir):** "object_refs/object_tags native Routen in v2
  oder beim meta-basierten Workaround bleiben?" — empfehle native: einmal
  bauen, dann ist `services/knowledge.ts:150-273` Workaround entfernbar.
