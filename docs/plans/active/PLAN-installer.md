# PLAN — One-Shot Pilot-Installer (pro Service)

> **Status:** ⚠️ Entwurf 2026-05-16/17 — wartet auf Architektur-Review, dann Implementierung. Pro-Service-Struktur nach User-Decision 2026-05-17: knowledge2-Installer zuerst (gegen heutige Pilot-Erfahrungen), approval2-Installer als Spiegelung danach.
> **Owner:** Axel
> **Schwester-Docs:** [`mcp-approval2/docs/privat.md`](../../privat.md), [`mcp-knowledge2/docs/STRATEGIE-pilot.md`](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/STRATEGIE-pilot.md)
> **Auslöser:** Pilot-Bootstrap heute aus Stückwerk-Schritten → reproduzierbar machen + Operator-Stops klar markieren statt im Maschinenraum verlaufen.

## 1. Ziel + Nicht-Ziele

**Ziel:** **Zwei eigenständige Installer-Skripte**, eines pro Service, beide ähnlich strukturiert für Direct-Compare + Wiedereinsetzbarkeit:

- `mcp-knowledge2/scripts/install-pilot.sh` — orchestriert Knowledge-Service-Setup auf Fly.io
- `mcp-approval2/scripts/install-pilot.sh` — orchestriert Approval-Service-Setup auf Fly.io
- **Geteilter TF-Root** bleibt in `mcp-approval2/terraform/` (CF + Doppler-Resources, beide Installer rufen ihn an mit Service-spezifischen `-target=`-Filtern)
- **Cross-Service-Bridge** (OBO-Token-Pairing, `MCP_KNOWLEDGE_URL`-Setup) als optionale „Phase 9" in beiden Installern, mit Hinweis dass der jeweilige andere Service vorher angelegt sein muss

Idempotent, mit klar markierten Operator-Hand-Stops, läuft gegen frische CF/Fly/GCP-Accounts ebenso wie gegen den heutigen Halb-Zustand.

**Nicht-Ziele:**
- Kein Code-Build im Installer (das macht `fly deploy` selbst)
- Keine business-Mode (GCP-Cloud-Run) Variante in V1 — separate Phase, falls je gebraucht
- Keine Auto-Token-Erstellung in fremden Accounts (Google/CF) — Operator-Hand bleibt der Schloss-Mechanismus
- Keine Auto-Approval bei destruktiven Operationen — explizite Confirm pro Phase

## 2. Phasen-Übersicht (pro Service)

Neun Phasen pro Installer, jede idempotent, jede mit klarem Pre-Check und Post-Verify. Phasen sind in beiden Installern strukturell gleich, aber service-spezifisch (eigene Fly-App, eigene Postgres-DB, eigene Secrets).

| # | Phase | Operator-Hand nötig? | Idempotent | Geschätzt |
|---|---|---|---|---|
| 0 | Pre-Flight Check (Tools, Logins) | ⏸ ggf. install missing tools | ✓ | ~1 min |
| 1 | Doppler-Config-Setup (`fly`-config existiert + befüllt) | ⏸ Token + externe Secrets befüllen | ✓ | ~5 min |
| 2 | Cloudflare + Neon Resources via TF (DNS, R2-Buckets, Neon-Project + Roles + Doppler-Push der DB-URLs) — nutzt geteilten TF-Root in approval2 | nein | ✓ | ~5 min |
| 3 | CF R2-Token-Erstellung + Doppler-Push | ⏸ 4 Tokens via CF-Dashboard, dann Doppler-CLI-Push | ✓ | ~10 min |
| 4 | Fly App-Erstellung via TF (`fly_app` + `fly_ip`) | ⏸ einmal `fly auth login` für lokale `fly deploy`-Schritte; `FLY_API_TOKEN` in Doppler für TF | ✓ | ~3 min |
| 5 | Postgres-Bootstrap (`CREATE EXTENSION vector + pg_trgm` via `psql $DATABASE_ADMIN_URL`) | ⏸ Operator führt SQL-Block aus (Auto-Mode blockt DB-Schreibzugriff) | ✓ | ~1 min |
| 6 | Doppler → Fly Secrets-Sync | nein | ✓ | ~1 min |
| 7 | Deploy + Migrations (`fly deploy --remote-only`) | nein | ✓ | ~5 min |
| 8 | Smoke-Test + Status-Report | nein | ✓ | ~2 min |
| 9 | **Cross-Service-Bridge** (OBO-Token-Pairing) — *optional* | ⏸ nur wenn Schwester-Service bereits live | ✓ | ~1 min |

**Total realistisch:** 25-35 min beim ersten Setup pro Service, davon ~15 min Operator-Hand-Aktivität. (Schneller seit Neon-Switch — keine MPG-Cluster-Wartezeit mehr.)

**Wichtige Lessons-Learned aus dem 2026-05-16/17-Pilot (knowledge2):**
- **Postgres-Backend: Neon Free Tier statt Fly MPG/Postgres.** Fly Postgres (Flex-Image, pg-16 + pg-17 v0.1.0) hat **kein pgvector** preinstalled — verifiziert am 2026-05-16. Fly MPG hatte ein dokumentiertes `--pgvector`-Flag das in `flyctl v0.4.52` *nicht* existierte. **Neon hat pgvector 0.8.0 + pg_trgm 1.6 out-of-box**, kostet 0 €/mo im Free Tier, ist EU (eu-central-1 Frankfurt), und wird komplett via [`kislerdm/neon`-Terraform-Provider](https://registry.terraform.io/providers/kislerdm/neon/latest/docs) angelegt — Doppler-Push der Connection-Strings inklusive (siehe [`terraform/environments/privat/neon-*.tf`](../../../terraform/environments/privat/)).
- **Neon-Hostname-Pattern**: TF-Locals dürfen **nicht** das Branch-ID-Pattern (`${branch_id}-pooler.${region_id}.aws.neon.tech`) bauen — das produziert DNS-unauflösbare Hosts. Stattdessen `neon_project.<name>.database_host[_pooler]` direkt referenzieren (echtes Pattern: `ep-<name>.c-N.<region>.aws.neon.tech`).
- **Neon Free-Tier-Limits in TF**: `history_retention_seconds` default ist 24h, Free-Tier-max ist 21600 (6h) → explizit setzen, sonst lehnt die API ab. `default_endpoint_settings.suspend_timeout_seconds` ist Free-Tier-disallowed → Block weglassen.
- **`fly auth token` deprecated** → `fly tokens create org -o personal -x 8760h` ist der neue Pfad. Plus Token-Output durch `tr -d '[:space:]'` trimmen. Aber: Org-scoped Tokens funktionieren NICHT für TF-Provider `fly-apps/fly` (App-Erstellung verlangt User-Macaroon). Workaround: weiterhin `fly auth token` (deprecated, gibt aber `FlyV1 fm2_...`-Macaroon zurück) bis Provider Org-Tokens unterstützt.
- **`fly ssh console -C "ls dir | grep pattern"`** interpretiert Pipe nicht — `bash -c '...'`-Wrap erforderlich.
- **CF Free-Plan limitiert Zone-Rulesets pro Phase auf 1**: ein zweites `cloudflare_ruleset` mit `kind="zone"` + `phase="http_ratelimit"` schlägt mit `code:20217` fehl wenn die Zone bereits ein Ratelimit-Ruleset hat. Workaround: In-Process-Rate-Limiter im App-Code (siehe `mcp-knowledge2/src/middleware/rate_limit.ts`) oder CF-Ruleset-Sharing mit existierendem Worker.

## 3. Operator-Hand-Stops (kann nicht automatisiert werden)

Bei jedem dieser Punkte pausiert der Installer mit klarer Anweisung, prüft nach „Enter" ob die Voraussetzung erfüllt ist, und stoppt nochmal wenn nicht.

### 3.1 Phase 0 — fehlende Tools
- **flyctl** nicht installiert → Installer bietet `curl -L https://fly.io/install.sh | sh` an, fragt nach Confirm
- **doppler-cli** nicht installiert → Anweisung mit Installer-Link, Confirm
- **terraform** nicht installiert → Link zu Hashicorp-Installer
- **jq** nicht installiert → `apt install jq` oder `brew install jq`

### 3.2 Phase 1 — Doppler-Login
- Prüft: `doppler me` funktioniert
- Wenn nein: „Bitte `doppler login` ausführen, dann Enter"
- Plus: prüft Token-Scope durch Test-Read auf `mcp-approval2 / fly`

### 3.3 Phase 3 — Cloudflare R2 API-Tokens
- Zeigt: Dashboard-URL, 4 Token-Specs (Bucket-Scoped, Object Read & Write)
- Wartet auf 4 × Access-Key-ID + Secret-Pair-Eingabe via `read -s` (Werte landen direkt in Doppler, nicht in Bash-History)
- Verifikation: aws-cli-`ls` gegen R2-Endpoint testet jeden Token

### 3.4 Phase 4 — Fly-Login
- Prüft: `fly auth whoami` funktioniert
- Wenn nein: „Bitte `fly auth login` ausführen, dann Enter"
- Prüft: ob ein gültiger FLY_API_TOKEN in Doppler liegt (für TF-Pfade)

### 3.5 Phase 5 — Postgres-Bootstrap (Neon)
- Wegen Auto-Mode-Classifier-Schutz: der Installer **darf nicht** autonom in Production-DB schreiben
- Installer holt `DATABASE_ADMIN_URL` aus Doppler in eine ENV-Var (nicht in stdout echo), schreibt das SQL in `/tmp/pilot-pg-bootstrap.sql`, zeigt:
  ```
  Bitte führe aus:
    export ADMIN_URL="$(doppler secrets get DATABASE_ADMIN_URL --plain --project mcp-knowledge2 --config fly)"
    psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f /tmp/pilot-pg-bootstrap.sql
    unset ADMIN_URL
  Drücke Enter wenn das durch ist.
  ```
  SQL-Body (knowledge2):
  ```sql
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  -- Neon: knowledge_app + knowledge_admin sind beide in der neon_superuser-Gruppe
  -- (BYPASSRLS via Group-Inheritance), keine zusätzlichen GRANTs nötig.
  SELECT extname, extversion FROM pg_extension WHERE extname IN ('vector','pg_trgm');
  ```
  Für approval2 entfällt `CREATE EXTENSION vector` (keine Embedding-Search).
- Post-Verify: Installer queryt `pg_extension` mit `DATABASE_ADMIN_URL` und prüft Versionen ≥ erwartet

## 4. State-Detection pro Phase

Jede Phase prüft ihren Output VOR der Aktion. Konkrete Mechanik:

| Phase | Detection-Mechanik | Skip-Bedingung |
|---|---|---|
| 0 | `command -v flyctl doppler terraform jq` | alle 4 vorhanden |
| 1 | `doppler projects --json` + grep `mcp-approval2` + `mcp-knowledge2` | beide Projects mit Config `fly` |
| 2 | `terraform state list` grep R2-Buckets + CF-AI-Gateway | alle TF-Resources vorhanden |
| 3 | `doppler secrets --json` length-check für 4 R2-Token-Keys in beiden Projects | alle 8 Keys gefüllt + aws-cli-ls successful |
| 4 | `fly apps list` grep + `fly status` | alle 4 Fly-Apps existieren |
| 5 | `psql -c "\du"` zeigt `knowledge_admin` mit BYPASSRLS | knowledge_admin existiert + Extensions installiert |
| 6 | `fly secrets list` length-check für DATABASE_URL + BLOB_ACCESS_KEY | alle Required-Keys staged |
| 7 | `fly status` zeigt latest_deploy + `curl /health` 200 | App deployed + health green |
| 8 | (kein State-Skip — Smoke läuft immer) | — |

## 5. Skript-Struktur (pro Service)

Beide Repos haben die gleiche Struktur. Service-Identität wird durch Variablen am Anfang des Master-Skripts gesetzt.

```
<repo>/scripts/
├── install-pilot.sh                    # Master-Orchestrator (mit SERVICE-Variable)
└── install/
    ├── 00-preflight.sh
    ├── 01-doppler-config.sh
    ├── 02-tf-cloudflare.sh              # ruft mcp-approval2/scripts/doppler-run-terraform.sh (geteilter TF-Root)
    ├── 03-r2-tokens.sh
    ├── 04-fly-bootstrap.sh              # Fly App via TF (`fly_app` + `fly_ip`). DB ist Neon, separate TF-Phase in 02
    ├── 05-postgres-bootstrap.sh         # `psql $DATABASE_ADMIN_URL` mit CREATE EXTENSION vector+pg_trgm
    ├── 06-secrets-sync.sh
    ├── 07-deploy.sh
    ├── 08-smoke.sh
    ├── 09-bridge-other-service.sh       # optional (Cross-Service-Token-Pairing)
    └── lib/
        ├── log.sh                      # ✓/⏳/⏭/✗ marker, color, timestamps
        ├── confirm.sh                  # interactive yes/no/skip prompts
        ├── doppler.sh                  # check_secret_filled, push_secret
        ├── fly.sh                      # fly_app_exists, fly_auth_check (Postgres ist Neon, getrennte lib/neon.sh-Helpers)
        └── state.sh                    # is_tf_resource_present
```

**Service-Identität via Variablen** im Master-Skript-Kopf:

```bash
# mcp-knowledge2/scripts/install-pilot.sh
SERVICE="knowledge2"
FLY_APP="mcp-knowledge2"
FLY_DB_APP="mcp-knowledge2-mpg"
DOPPLER_PROJECT="mcp-knowledge2"
DOPPLER_CONFIG="${DOPPLER_CONFIG:-fly}"
NEEDS_PGVECTOR="true"
NEEDS_OPENBAO="false"
```

```bash
# mcp-approval2/scripts/install-pilot.sh
SERVICE="approval2"
FLY_APP="mcp-approval2"
FLY_DB_APP="mcp-approval2-mpg"
DOPPLER_PROJECT="mcp-approval2"
DOPPLER_CONFIG="${DOPPLER_CONFIG:-fly}"
NEEDS_PGVECTOR="false"
NEEDS_OPENBAO="true"                  # zusätzlich Fly-App mcp-approval2-openbao
```

**Geteilter Code:** in V1 wird der Code aus knowledge2 nach approval2 kopiert + Service-spezifisch ergänzt (OpenBao-Setup, WebAuthn-PRF-Init). Submodule oder zentrales Lib-Repo ist Over-Engineering für Solo-Pilot — Copy mit Diff-Pflege reicht.

**Master-Skript-Logik:**

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/install/lib/log.sh"

log_info "mcp-approval2 + mcp-knowledge2 Pilot-Installer V1"
log_info "Idempotent, durchlauffähig — Re-Run skipt erledigte Phasen"
log_info ""

PHASES=(
  "00-preflight"
  "01-doppler-bootstrap"
  "02-tf-cloudflare"
  "03-r2-tokens"
  "04-fly-bootstrap"
  "05-postgres-bootstrap"
  "06-secrets-sync"
  "07-deploy"
  "08-smoke"
)

# CLI-Flags
FROM=""   # --from=04 startet ab Phase 4
ONLY=""   # --only=07 läuft nur diese Phase
DRY=""    # --dry-run zeigt nur was getan würde
for arg in "$@"; do
  case "$arg" in
    --from=*) FROM="${arg#*=}" ;;
    --only=*) ONLY="${arg#*=}" ;;
    --dry-run) DRY="1" ;;
    --help) print_usage; exit 0 ;;
  esac
done

for phase in "${PHASES[@]}"; do
  [[ -n "$ONLY" && "$phase" != "$ONLY"* ]] && continue
  [[ -n "$FROM" && "${phase%%-*}" < "$FROM" ]] && continue
  
  log_phase_start "$phase"
  if [[ -n "$DRY" ]]; then
    log_info "  [dry-run] würde ausführen: install/$phase.sh"
  else
    bash "$SCRIPT_DIR/install/$phase.sh"
  fi
  log_phase_end "$phase"
done

log_success "Pilot-Setup komplett. Smoke-Report siehe oben."
```

## 6. Cross-Repo-Orchestrierung

Der Installer lebt in **mcp-approval2/scripts/** weil dort der TF-Root für Doppler + CF managed wird. Aber er orchestriert auch **mcp-knowledge2-Operationen**:

Pro-Service-Installer ruft den **geteilten TF-Root** für CF + Doppler-Resources an (lebt in mcp-approval2). Pro-Service-Operationen (Fly-App, Deploy, Bootstrap) sind im Service-eigenen Repo.

| Operation | Skript-Pfad | Funktioniert weil |
|---|---|---|
| **knowledge2:** Doppler-Config-Setup | `mcp-knowledge2/scripts/install/01-doppler-config.sh` | Doppler-CLI ist provider-agnostisch, Token reicht |
| **knowledge2:** R2-Buckets + AI Gateway (TF) | `mcp-knowledge2/scripts/install/02-tf-cloudflare.sh` → ruft `bash $APPROVAL2/scripts/doppler-run-terraform.sh apply -target=cloudflare_r2_bucket.knowledge2_*` | TF-State liegt in approval2-Repo (shared), aber Targeting selektiert nur knowledge2-Resources |
| **knowledge2:** Fly-App | `mcp-knowledge2/scripts/install/04-fly-bootstrap.sh` | TF-managed (`fly_app.knowledge2` + `fly_ip.knowledge2_v6` im geteilten TF-Root). Postgres ist Neon, getrennt in Phase 02. |
| **knowledge2:** Fly-Deploy | `mcp-knowledge2/scripts/install/07-deploy.sh` → ruft existing `bash deploy/fly/deploy.sh` | bestehendes Skript, idempotent |
| **approval2:** analog mit eigenem Pfad | `mcp-approval2/scripts/install/0X-*.sh` | gleiche Mechanik, andere Resource-Namen |
| **Cross-Service-Bridge** (Phase 9) | `<service>/scripts/install/09-bridge-other-service.sh` | sucht Schwester-Repo via Env `MCP_APPROVAL2_REPO=` oder `MCP_KNOWLEDGE2_REPO=` (default: `../<other-repo>` parallel) |

**Repo-Pfad-Findung:** Installer prüft via `realpath` ob das Schwester-Repo unter `$SCRIPT_DIR/../../<other-repo-name>` liegt. Wenn nicht: env-var prüfen. Wenn auch nicht gesetzt: klare Fehlermeldung mit Klon-Anweisung. Die geteilte TF-Operation in `02-tf-cloudflare.sh` braucht den approval2-Pfad zwingend; wenn approval2 nicht da ist, kann der knowledge2-Installer nur die service-eigenen Phasen (1, 4-9) ausführen + Cloudflare auf manuelle Operator-Schritte degradieren.

## 7. Error-Handling + Resume

- **`set -euo pipefail`** in jedem Phase-Skript
- Bei Fehler in Phase N: Installer stoppt, zeigt klar an welche Phase und was schief lief
- Re-Run: User startet `bash scripts/install-pilot.sh --from=NN` ab der Stelle wo's stehen geblieben ist (jede Phase ist idempotent, also auch erneutes Durchlaufen von früheren Phasen ist harmlos)
- **Cleanup-Mode** (nicht in V1): `--rollback=NN` würde die Phase rückgängig machen — gefährlich, deshalb nicht im ersten Wurf

## 8. Logging-Konvention

Vier Marker:

| Marker | Bedeutung |
|---|---|
| `✓` (grün) | Schritt erfolgreich abgeschlossen |
| `⏳` (gelb) | Schritt läuft gerade |
| `⏭` (blau) | Schritt geskipt (schon erledigt) |
| `✗` (rot) | Schritt fehlgeschlagen |
| `⏸` (orange) | Wartet auf Operator-Aktion |

Output-Format pro Phase:
```
══════════════════════════════════════════════════════════════
  Phase 04: Fly Apps (via TF)
══════════════════════════════════════════════════════════════
  ✓  fly auth: axelrogg@gmail.com (login frisch verifiziert)
  ⏭ mcp-approval2 App existiert (TF state hat fly_app.approval2)
  ⏭ mcp-knowledge2 App existiert (TF state hat fly_app.knowledge2)
  ⏭ mcp-approval2 IPv6 existiert (fly_ip.approval2_v6)
  ⏭ mcp-knowledge2 IPv6 existiert
  ⏳ Neon-DB-Connectivity-Probe: knowledge2...
  ✓  Neon-DB reachable: ep-young-term-alpu306x.c-3.eu-central-1.aws.neon.tech
  ⏳ Neon-DB-Connectivity-Probe: approval2...
  ✓  Neon-DB reachable: ep-cool-mud-als1w8ps.c-3.eu-central-1.aws.neon.tech
  ✓  Phase 04 komplett (1.8s)
```

## 9. Sicherheits-Boundaries

| Was der Installer NIE tut |
|---|
| Secret-Werte ins Stdout/Log echoen (alles via `read -s` + `$()` + `--silent`) |
| Bash-History pollen mit Tokens (via `read -s` für interaktive Eingabe, `$()` für CLI-Pipes) |
| Destructive ops ohne explizites Confirm (Bucket-Delete, App-Destroy) |
| `terraform destroy` aufrufen (separates Tool, nicht im Installer) |
| Cross-Account-Operations ohne Bestätigung (z.B. anderen GCP-Project anfassen) |
| Production-DB-Writes ohne Operator-Hand (Phase 5 ist explizit) |

## 10. Pre-Flight-Anforderungen (Phase 0 Details)

Der Installer setzt voraus:
- Linux/macOS mit Bash 4+ (Codespace ist OK)
- Internet-Zugang zu fly.io, doppler.com, cloudflare.com, fly.io API
- ~500 MB freier Disk (für TF state, Doppler-cache)
- Cloudflare-Account mit ai-toolhub.org Zone (oder eigener Zone — Pre-Flight prüft DNS)
- Doppler-Workplace mit Personal-Token-Permissions auf workplace:admin

## 11. Test-Strategie

V1 wird **manuell** getestet — keine automated tests für den Installer selbst. Akzeptanz-Kriterien:

1. **Fresh-Run-Test:** Auf einem frischen Codespace mit nur den 5 Pre-Flight-Voraussetzungen läuft `bash install-pilot.sh` ohne Crashes durch alle 8 Phasen (mit 4 Operator-Stops). Resultiert in 2 live Fly-Apps mit `/health` 200.

2. **Resume-Test:** Nach Crash in Phase 5: `--from=05` läuft nur Phase 5-8.

3. **Re-Run-Test:** Gegen einen schon vollständig provisionierten Pilot: jede Phase erkennt „skipped" und der ganze Run ist <30s ohne Operator-Stops.

4. **Idempotenz-Test gegen den HEUTIGEN halb-fertigen Zustand (16.05.):** Installer erkennt R2-Buckets, Fly-Apps, Doppler-Configs als vorhanden, fragt nur die noch fehlenden Bits ab (Postgres-Admin-Rolle, knowledge2-Deploy).

## 12. Was kommt NACH dem Installer

Wenn der Installer V1 läuft + getestet ist, wären nächste Schritte:

- **Uninstaller / Teardown** (für sauberen Customer-Off-Boarding)
- **Customer-Pilot-Wizard** — gleiche Phasen, aber mit Customer-spezifischen Variablen (eigener Domain, eigener Doppler-Workspace, etc.)
- **CI-Hook** — Installer als Teil eines GitHub-Actions-Workflows, der bei neuem Pilot-Onboarding läuft

Nicht in V1, aber strukturell vorbereitet (durch die modulare Phasen-Struktur).

## 13. Open Decisions vor Implementierungs-Start

Bevor ich `00-preflight.sh` schreibe — drei Klärungs-Punkte für dich:

1. **Repo-Verzeichnis-Convention:** Erwartet der Installer beide Repos parallel unter `/workspaces/mcp-approval2` + `/workspaces/mcp-knowledge2`? Oder konfigurierbar via `MCP_KNOWLEDGE2_REPO=/path/to/knowledge2` Env-Var? Empfehlung: **parallel + Env-Override**.

2. **R2-Token-Erstellung (Phase 3):** Soll der Installer dich Schritt-für-Schritt durch die 4 Token-Klicks im CF-Dashboard führen (mit URL + Token-Name-Vorschlag + Bucket-Auswahl-Erinnerung), oder einfach auf einen vorbereiteten `docs/runbook-cf-r2-tokens.md` verweisen? Empfehlung: **interaktiv mit Verifikation pro Token**.

3. **Cleanup-Verhalten:** Wenn ein Skript abbricht weil ein Pre-Check failt — soll der Installer Temp-Files (`/tmp/pilot-pg-bootstrap.sql` etc.) aufräumen, oder lassen? Empfehlung: **lassen** (für Debug + manuelle Wiederaufnahme).

Sag mir deine Antworten zu diesen drei, dann starte ich mit Phase 0 + lib/.

## 14. Referenzen

- [docs/privat.md](../../privat.md) — Pilot-Architektur, Doppler-Conventions, Resource-Liste
- [knowledge2/docs/STRATEGIE-pilot.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/STRATEGIE-pilot.md) — Fly-Strategie + Provider-Switch-Matrix
- [knowledge2/docs/PILOT-READINESS.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/PILOT-READINESS.md) — Sign-off-Checklist (wird vom Installer durchlaufen)
- [scripts/doppler-run-terraform.sh](../../../scripts/doppler-run-terraform.sh) — bestehender TF-Wrapper, wird vom Installer aufgerufen
- [knowledge2/deploy/fly/deploy.sh](https://github.com/axel-rogg/mcp-knowledge2/blob/main/deploy/fly/deploy.sh) — bestehender knowledge2-Deploy, wird in Phase 7 wrapped