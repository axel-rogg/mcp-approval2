# `privat-openbao` — Post-Init OpenBao-Konfiguration

Eigenes TF-Modul mit eigenem State, weil dieses Modul nur appliebar ist
**nachdem** OpenBao initialisiert + unsealed wurde. Der vault-Provider
schlägt sonst hart fehl und blockt jeden plan/apply im Hauptmodul.

Im Geltungsbereich:

- Transit-Secrets-Engine mounten (`transit/`)
- Master-Key `user-dek` (aes256-gcm96, auto-rotate alle 90d)
- AppRole-Auth aktivieren (`approle/`)
- Zwei AppRoles: `approval2-fly` + `knowledge2-fly`
- Zwei Policies (approval2 darf wrap/unwrap, knowledge2 nur datakey/plaintext)
- `role_id` + `secret_id` werden direkt in die jeweiligen Doppler-Configs
  geschrieben — kein Copy-Paste durch den Operator.

## Voraussetzungen vor dem ersten Apply

1. **Bao läuft auf Fly.** Aus dem Hauptmodul (`environments/privat/`):

   ```bash
   bash scripts/doppler-run-terraform.sh apply \
     -target=fly_app.approval2_openbao \
     -target=fly_volume.approval2_openbao_data
   ```

   Danach manuell:

   ```bash
   fly deploy --config fly.openbao.toml -a mcp-approval2-openbao
   ```

2. **Bao initialisiert.** Einmalig, **NICHT** in TF (Output enthält Unseal-
   Keys + Root-Token, dürfen nicht in State landen):

   ```bash
   fly ssh console -a mcp-approval2-openbao
   bao operator init -key-shares=3 -key-threshold=2
   # → 3 Unseal-Keys + Root-Token auf Paper-Wallet / verschlüsseltes USB
   ```

3. **Bao unsealed.** Nach jedem Container-Restart:

   ```bash
   bao operator unseal <key-1>
   bao operator unseal <key-2>
   # → Sealed false
   ```

4. **Port-Forward auf Operator-Maschine** (in extra Terminal, lassen):

   ```bash
   fly proxy 8200 -a mcp-approval2-openbao
   # Listening on 127.0.0.1:8200
   ```

## Apply-Workflow

```bash
cd terraform/environments/privat-openbao

# Provider-Auth via env (NICHT als TF-Variable — hält Token aus State raus)
export VAULT_ADDR=http://127.0.0.1:8200
export VAULT_TOKEN=<root-token aus bao operator init>
export DOPPLER_TOKEN=<workplace-scoped personal-token, gleicher wie für privat-Modul>

terraform init
terraform plan
terraform apply
```

Nach Apply sind in beiden Doppler-Configs (`mcp-approval2/privat` und
`mcp-knowledge2/privat`) gesetzt:

- `OPENBAO_ROLE_ID`
- `OPENBAO_SECRET_ID`
- `OPENBAO_ADDR` (= `http://mcp-approval2-openbao.internal:8200`, Fly-6PN)
- `OPENBAO_TRANSIT_PATH` (= `transit`)

Der nächste `bash deploy/fly/sync-secrets.sh -a mcp-approval2` (analog für
knowledge2) zieht diese Werte als `fly secrets set`-Calls auf die Apps.

## secret_id-Rotation (alle 90 Tage)

OpenBao's `secret_id_ttl=7776000` (90d). Ablauf-Workflow:

```bash
# 1. Neuen secret_id für approval2 minten
fly proxy 8200 -a mcp-approval2-openbao &
export VAULT_ADDR=http://127.0.0.1:8200
export VAULT_TOKEN=<root-token>

bao write -force -f auth/approle/role/approval2-fly/secret-id
# Output: secret_id=...

# 2. In Doppler aktualisieren (oder TF-State refreshen):
terraform apply -refresh-only        # TF zieht die Drift in den State

# Selbe Sequenz für knowledge2-fly.
```

⚠️ Wenn die Token-TTL (`token_ttl=3600`, default 1h) ausläuft bevor der
Service `renew-self` aufruft, holt der Service automatisch via role_id+
secret_id einen neuen Token. Bei abgelaufenem secret_id schlägt das fehl
— Symptom im Service-Log: `OpenBao login: 400 invalid secret id`. Reaktion:
sofort rotieren wie oben.

## Rollback / Destroy

```bash
terraform destroy
```

…macht in dieser Reihenfolge:

1. Entfernt Doppler-Secrets (Services können nicht mehr authen)
2. Entfernt AppRoles + Policies
3. Entfernt Transit-Key — **CRITICAL**: alle damit verschlüsselten Daten in
   den Services sind unwiederbringlich. Crypto-Shredding ist Feature, nicht
   Bug, aber bewusste Aktion.

Vor Destroy → letzte pg_dump-Backups checken (R2 `mcp-{approval2,knowledge2}-
backup-eu`-Buckets), falls die Daten überhaupt noch interessant sind.

## State

Das State-File liegt in R2-EU unter
`mcp-approval2/privat-openbao/terraform.tfstate`. Im State:

- `vault_approle_auth_backend_role_secret_id.{approval2,knowledge2}` — beide
  enthalten den aktuellen `secret_id` (sensitive).
- Doppler-Pipe-Resources halten denselben Wert (`doppler_secret`).

Wer Zugriff auf das State-File hat, hat effektiv beide Service-AppRoles.
R2-Bucket-ACL ist auf den TF-Operator-API-Token beschränkt — keine
breitere Sharing-Surface.

## Spec-Reference

- `docs/privat.md` §9.3 — OpenBao Side-Car-Strategie
- `mcp-knowledge2/docs/runbooks/runbook-as3-cutover.md` Section 1.3 —
  ursprüngliche bao-CLI-Schritte (jetzt durch dieses Modul ersetzt)
- `mcp-knowledge2/src/adapters/kms/openbao.ts` — Client-Code, der gegen
  diese Konfiguration spricht
