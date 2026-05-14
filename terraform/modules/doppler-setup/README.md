# Module: `doppler-setup`

Legt das Doppler-Setup fuer **mcp-approval2** an: Project, 3 Environments,
Secret-Placeholders und 2 read-only Service-Tokens. **Werte tragen User-seitig
in der Doppler-UI ein** — Terraform legt nur die Strukturen + leere
Placeholders an.

## Was Terraform anlegt

| Resource | Anzahl | Beschreibung |
|---|---|---|
| `doppler_project` | 1 | `mcp-approval2` |
| `doppler_environment` | 3 | `dev`, `privat`, `business` |
| `doppler_secret` | 30 | Placeholders im `privat`-Config |
| `doppler_service_token` | 2 | `hetzner-vm-readonly`, `github-actions-readonly` |

Alle Placeholders haben `lifecycle.ignore_changes = [value]`. Das heisst:

- Initialer `terraform apply` legt das Secret mit leerem Wert (oder
  sinnvollem Default fuer Domain-/Region-Felder) an.
- User traegt danach in der Doppler-UI den echten Wert ein.
- Spaetere `terraform apply` ueberschreiben den User-Wert **NICHT** mehr.
- `terraform destroy` loescht das Secret komplett — Vorsicht.

## Voraussetzung: DOPPLER_TOKEN env-var

Der Doppler-Provider liest seinen Token aus `DOPPLER_TOKEN`. Brauche ein
**Personal-Token** mit `workplace:admin`-Scope (nicht ein Service-Token —
Service-Tokens koennen kein Project anlegen).

```bash
# Doppler-UI: Profile → Personal Tokens → Generate
# scopes: workplace:admin
# Token in /workspaces/mcp-approval2/.dev.vars eintragen:
DOPPLER_TOKEN=dp.pt.xxxxxxxxxxxxxxxxxxxxxxxx
```

Vor `terraform plan/apply` sourcen:

```bash
set -a && source .dev.vars && set +a
```

## Inputs

| Variable | Type | Default | Beschreibung |
|---|---|---|---|
| `project_name` | `string` | `"mcp-approval2"` | Doppler-Project-Name (Single-Source-of-Truth fuer alle Secrets) |
| `project_description` | `string` | siehe variables.tf | In der Doppler-UI sichtbar |

## Outputs

| Output | Sensitive | Beschreibung |
|---|---|---|
| `project_name` | nein | Project-Name |
| `config_dev` / `config_privat` / `config_business` | nein | Config-Slugs |
| `hetzner_vm_service_token` | **ja** | Read-only Token fuer VM `/opt/mcp-approval2/.doppler-token` |
| `github_actions_service_token` | **ja** | Read-only Token fuer GH-Actions `DOPPLER_TOKEN_GHA` Repo-Secret |
| `doppler_dashboard_url` | nein | Direkt-Link in die Doppler-UI |
| `placeholder_count` | nein | Anzahl angelegter Placeholders (30) |

## Workflow

### 1. Erstmaliger Apply

```bash
cd /workspaces/mcp-approval2/terraform/environments/privat
set -a && source ../../../.dev.vars && set +a
terraform init
terraform apply -target=module.doppler   # nur das Doppler-Modul zuerst
```

Output:

```
doppler_dashboard = "https://dashboard.doppler.com/workplace/projects/mcp-approval2/configs"
doppler_vm_token  = <sensitive>
doppler_gha_token = <sensitive>
```

### 2. Werte in Doppler-UI eintragen

```bash
terraform output doppler_dashboard
# -> URL in Browser oeffnen, Config "privat" auswaehlen
# -> Alle 30 leeren Placeholders mit echten Werten fuellen
```

Quelle fuer die Werte (Kopiervorlage):

- **Cloud-Provider-Auth**: aus `mcp-approval/.dev.vars` uebernehmen
  (HCLOUD_TOKEN, CLOUDFLARE_*, AWS_*, R2_ENDPOINT, GITHUB_TOKEN).
- **Google-OAuth**: aus Google-Cloud-Console (OAuth-Client fuer
  mcp2.ai-toolhub.org).
- **SSH-Keys**: `OPERATOR_SSH_PUBLIC_KEY` aus `~/.ssh/mcp-approval2_ed25519.pub`;
  `HETZNER_DEPLOY_SSH_PRIVATE_KEY` aus separat generiertem GH-Actions-Keypair.
- **VAPID**: `npx web-push generate-vapid-keys` einmalig.
- **Generated-on-VM**: nach erstem `setup.sh`-Run auf der VM aus
  `/opt/mcp-approval2/.env` kopieren (POSTGRES_PASSWORD, VAULT_TOKEN,
  JWT_*, KNOWLEDGE_BACKUP_MASTER_KEY_BASE64, ACME_EMAIL).
- **Domains** haben sinnvolle Defaults — meist nicht aendern.
- **HETZNER_FQDN_V4 / ALLOWED_ORIGINS**: erst nach VM-Apply verfuegbar
  (`terraform output default_hetzner_fqdn_v4`, `allowed_origins_csv`).

### 3. Service-Tokens deployen

```bash
# Auf der VM:
terraform output -raw doppler_vm_token | ssh operator@<vm-ip> \
  'sudo tee /opt/mcp-approval2/.doppler-token >/dev/null && \
   sudo chmod 600 /opt/mcp-approval2/.doppler-token'

# GitHub-Actions:
terraform output -raw doppler_gha_token | gh secret set DOPPLER_TOKEN_GHA -R axel-rogg/mcp-approval2
```

Auf der VM laeuft danach `doppler run --config privat -- docker compose up`
(oder Aequivalent in systemd-unit) — Doppler-CLI injiziert die Secrets
als ENV-Vars zur Laufzeit.

### 4. Wert geaendert in Doppler-UI

Kein Terraform-Action noetig. `ignore_changes = [value]` haelt TF aus dem
Weg, der naechste `doppler run` auf VM/CI bekommt sofort den neuen Wert.
Service-Tokens-Rotate: `terraform taint module.doppler.doppler_service_token.hetzner_vm`
+ `terraform apply` -> neuen Token deployen.

## Anti-Patterns (was wir NICHT machen)

- **Keine Secret-Values via Terraform setzen.** Alle bleiben User-controlled
  in der Doppler-UI. Der initiale Wert ist `""` (leer) bzw. ein
  Domain-/Region-Default.
- **Keine Doppler-GitHub-Integration als TF-Resource.** Die wird einmalig
  per Klick in der Doppler-UI gesynced (Integrations → GitHub → Connect
  Repository) — der Provider unterstuetzt das nicht als Resource-Block.
- **Keine `doppler_token` Variable.** Der Provider liest `DOPPLER_TOKEN`
  direkt aus dem Environment. Token fliesst nie durch den TF-State.

## Troubleshooting

- **`Error: 401 Unauthorized`** beim Plan/Apply → `DOPPLER_TOKEN` nicht
  exportiert oder nicht workplace-admin-scope. `echo $DOPPLER_TOKEN | head -c 8`
  sollte `dp.pt.` ergeben.
- **`Error: project already exists`** → das Doppler-Project wurde frueher
  haendisch in der UI angelegt. Loesung: `terraform import
  module.doppler.doppler_project.mcp_approval2 mcp-approval2`.
- **Service-Token wurde manuell revoked** → `terraform taint
  module.doppler.doppler_service_token.hetzner_vm` + `terraform apply` legt
  einen neuen an.
