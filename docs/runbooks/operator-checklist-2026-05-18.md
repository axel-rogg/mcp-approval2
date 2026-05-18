# Operator-Checklist 2026-05-18 (Phase 2 Group-Sharing + Followups)

> Schnelle Übersicht aller pending Operator-Tasks nach dem heutigen Sprint.
> Eine Seite. Nicht-erschöpfend. Detailed Runbooks pro Punkt verlinkt.

---

## 🚨 Blockt P2-Deploy (MUSS vor naechstem `fly deploy -a mcp-knowledge2`)

**Neon-Role-Grant fuer FK-References on users:**

```bash
cd /workspaces/mcp-approval2
doppler secrets get DATABASE_ADMIN_URL --plain \
  --project mcp-knowledge2 --config fly | \
xargs -I{} psql "{}" <<'EOF'
GRANT REFERENCES ON TABLE users   TO knowledge_app;
GRANT REFERENCES ON TABLE invites TO knowledge_app;
EOF
```

Verify:
```bash
psql "$DATABASE_ADMIN_URL" -c "\dp users" | grep knowledge_app
# Expect: knowledge_app=arwxR/... (R = REFERENCES)
```

**Dann:** `cd /workspaces/mcp-knowledge2 && fly deploy --remote-only -a mcp-knowledge2`

Migrations 0020–0026 sollten dann durchlaufen. Status pre-fix:
- Mig 0019 angewendet (groups/group_members/share_grants Tabellen existieren)
- _migrations enthaelt '0019_groups_and_sharing_phase1.sql'
- v23 läuft (Phase-1-Stand), kein Service-Impact

Vollstaendiger Runbook: [knowledge2 docs/runbooks/runbook-neon-role-grants.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/runbooks/runbook-neon-role-grants.md)

---

## ⚙️ Nach erfolgreichem KC2-Deploy

### approval2-Deploy
```bash
cd /workspaces/mcp-approval2
git commit --allow-empty -m "chore: deploy phase 2 + followups [deploy]"
git push
# Triggert GH-Action Deploy to Fly.io
```

### Migration 0029 (P2-6 v2 invites.target_group_id) — approval2-Side

approval2-release_command lässt das per Doppler-`DATABASE_ADMIN_URL` automatisch laufen. Wenn approval2 die gleiche role-config hat wie knowledge2: vorab grants nötig (analog oben fuer approval2-DB).

### Rewrap-Cron Secret setzen

```bash
# In knowledge2 repo:
cd /workspaces/mcp-knowledge2
SERVICE_TOKEN_OPS=$(doppler secrets get SERVICE_TOKEN_OPS --plain \
  --project mcp-knowledge2 --config fly)
gh secret set SERVICE_TOKEN_OPS --body "$SERVICE_TOKEN_OPS"
```

Verifizieren: GH-Action `rewrap-tick` schaltet auf grün beim nächsten alle-2-min-Tick.

---

## 🔒 Family-Hardening Sprint (~4h, optional, blockt nichts)

Per memory pending seit 2026-05-17. Voll-Runbook in [runbook-family-hardening.md](runbook-family-hardening.md). Kurzfassung:

- [ ] **§1 Google-Passkey** für Axel + Familienmitglieder (~45 min)
- [ ] **§3.2 R2 Object-Lock + Versioning** im CF-Dashboard aktivieren (~10 min)
- [ ] **§3.3 Restore-Drill** scharf fahren (~30 min, [scripts/restore-dry-run](../../scripts/) via runbook)
- [ ] **§5 Recovery-Brief** ausdrucken, ausfüllen, im Safe verwahren (~30 min, [operator-recovery-brief.md](operator-recovery-brief.md))

Keine dieser Tasks blockt den laufenden Service.

---

## 💰 Compliance-Optional (nur bei Audit-Bedarf)

### WORM-Audit-Sink (P2-8)

Für SOC-2 / ISO-27001 Audit-Trails:

```bash
cd /workspaces/mcp-approval2
# Variable umstellen in terraform.tfvars:
echo 'gcs_audit_enabled = true' >> terraform/environments/privat/terraform.tfvars
bash scripts/doppler-run-terraform.sh apply
doppler secrets set AUDIT_SINK_MODE pg+gcs --project mcp-approval2 --config fly
bash deploy/fly/sync-secrets.sh
fly deploy --remote-only -a mcp-approval2
```

Voll-Runbook: [runbook-audit-worm.md](runbook-audit-worm.md)

---

## 🧪 Smoke-Test nach Deploy

```bash
# 1. Beide Services healthy
curl -s https://mcp2.ai-toolhub.org/health | jq
curl -s https://mcp-knowledge2.fly.dev/health/ready | jq

# 2. PWA reachable
curl -sI https://app2.ai-toolhub.org/ | head -3

# 3. P2-Migrations applied (psql via DATABASE_ADMIN_URL)
psql "$DATABASE_ADMIN_URL" -c "SELECT name FROM _migrations WHERE name LIKE '00%' ORDER BY name DESC LIMIT 5;"
# Erwarte: 0026_rewrap_jobs.sql obenauf

# 4. Group-Sharing-Tools sichtbar (via Claude.ai MCP-Client tools/list)
# groups.create, groups.transfer_ownership, groups.invite_email,
# docs.share_with_group, shares.revoke etc.
```

---

## 🗓 Token-Rotation Reminder

Per [runbook-token-rotation.md](runbook-token-rotation.md):

- **180 Tage**: Fly-API-Token, GCP-Service-Account-Keys
- **90 Tage**: KMS-Master-Key (auto-rotate via TF)
- **30 Tage**: CF Access Service-Tokens (next: 2026-06-12)

Kalender-Erinnerungen sind in [terraform/environments/privat/](../../terraform/environments/privat/) als Variablen-Kommentare hinterlegt.
