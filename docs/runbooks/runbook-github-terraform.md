# Runbook: GitHub-Repo Terraform Management

Manage `axel-rogg/mcp-approval2` repository settings, branch-protection,
deployment environments, and Actions secrets declaratively via Terraform.

Module: `terraform/modules/github-repo/`
Entry-Point: `terraform/environments/privat/github.tf`

---

## 1. PAT-Generation

The Terraform GitHub provider authenticates via a Personal-Access-Token.

1. Open <https://github.com/settings/tokens/new> (classic PAT).
   Fine-grained tokens currently lack reliable environment-secret support
   for personal repos — stick with classic for now.
2. Scopes:
   - `repo` (Full control) — repository settings + branch protection
   - `workflow` — Actions secrets, variables, environments
   - **NOT** `admin:org` — only needed for org-owned repos
3. Expiry: 90 days. Calendar a rotation reminder.
4. Copy the token (`ghp_...`) into your password manager. GitHub will not
   show it again.

Export before any `terraform plan`/`apply`:

```bash
export GITHUB_TOKEN="ghp_xxxxx"
# Verify:
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user | jq .login
# → "axel-rogg"
```

If you use 1Password CLI:

```bash
export GITHUB_TOKEN="$(op read 'op://Private/github-terraform-pat/credential')"
```

---

## 2. First-Apply

```bash
cd terraform/environments/privat

# 2a. Seed local tfvars (gitignored).
cp terraform.tfvars.example terraform.tfvars
nano terraform.tfvars

# 2b. Load all provider env-vars (R2 backend creds, Cloudflare, GitHub).
export GITHUB_TOKEN="ghp_..."
export CLOUDFLARE_API_TOKEN="..."
export AWS_ACCESS_KEY_ID="..."         # R2 backend creds
export AWS_SECRET_ACCESS_KEY="..."
# Hetzner + Cloudflare zone-id already in tfvars.

# 2c. Init + plan + apply.
terraform init
terraform plan       # carefully review — should show ~25 new resources
terraform apply

# 2d. Verify on GitHub:
gh secret list --repo axel-rogg/mcp-approval2
gh secret list --repo axel-rogg/mcp-approval2 --env hetzner-production
gh api repos/axel-rogg/mcp-approval2/branches/main/protection
```

**First-apply gotcha:** the `github_repository` resource performs an implicit
takeover of the existing repo via `name`. If the repo doesn't exist yet,
Terraform fails fast on the `data "github_repository"` lookup — create the
repo manually first (`gh repo create axel-rogg/mcp-approval2 --public --confirm`).

---

## 3. State-Sensitivity-Awareness

All sensitive values passed into the `github-repo` module end up as
**plaintext** in the Terraform state file. The state backend MUST be
encrypted at rest:

| Backend | Status |
| --- | --- |
| R2 (current default, EU jurisdiction) | OK — encrypted at rest by Cloudflare |
| Local file | NEVER — never enable for sensitive work |
| S3 with SSE | OK |

Cross-check:

```bash
# Confirm state is in R2, not local:
grep -E '^\s*backend' terraform/environments/privat/backend.tf
# → backend "s3" → R2 endpoint
```

`.gitignore` rules in `terraform/.gitignore` already protect:

- `*.tfstate*` (in case of an accidental local backend)
- `*.tfvars` (every value file, with an explicit `!*.tfvars.example` allow)
- `.terraform/` (provider cache)

If you ever pull state for debugging:

```bash
terraform state pull > /tmp/state.json
# DO YOUR ANALYSIS
shred -u /tmp/state.json    # don't leave plaintext on disk
```

---

## 4. Secret-Rotation

### Rotate a single secret

```bash
cd terraform/environments/privat

# 4a. Update the new value in tfvars.
nano terraform.tfvars

# 4b. Target-apply just that secret.
terraform apply \
  -target='module.github.github_actions_environment_secret.hetzner_ssh_key'

# 4c. Trigger a no-op workflow to verify the new value works:
gh workflow run smoke.yml --ref main
gh run watch
```

### Rotate everything

Quarterly (or after any suspected compromise):

```bash
cd terraform/environments/privat
nano terraform.tfvars   # cycle every sensitive value
terraform apply
```

### Rotate the GitHub PAT itself

The PAT is NOT managed by Terraform — it's the bootstrap credential.

1. Generate a new PAT (see §1).
2. Export the new `GITHUB_TOKEN`.
3. `terraform plan` — should report no changes (the new PAT just has the
   same permissions on the same resources).
4. Revoke the old PAT at <https://github.com/settings/tokens>.

---

## 5. Adding-new-Secret-Pattern

To wire up a new GH-Actions secret (e.g. `OPENBAO_ROOT_TOKEN`):

```bash
# 5a. Module: add variable
nano terraform/modules/github-repo/variables.tf
# → variable "openbao_root_token" { type=string; sensitive=true; ... }

# 5b. Module: add resource (repo-level OR env-level)
nano terraform/modules/github-repo/secrets.tf
# → resource "github_actions_environment_secret" "openbao_root_token" { ... }

# 5c. Module: append the NAME to outputs.tf → managed_secrets list

# 5d. Privat env: wire through
nano terraform/environments/privat/github.tf
# → openbao_root_token = var.openbao_root_token

# 5e. Privat env: declare variable
nano terraform/environments/privat/variables.tf
# → variable "openbao_root_token" { ... }

# 5f. Privat env: document in tfvars.example
nano terraform/environments/privat/terraform.tfvars.example

# 5g. Apply
nano terraform/environments/privat/terraform.tfvars   # fill the real value
terraform plan
terraform apply
```

---

## 6. Deploy-Key vs Operator-Key

**Do not reuse the operator SSH key for GH-Actions deploys.** Use two
separate keys:

| Key | Lives where | Used for |
| --- | --- | --- |
| Operator key | `~/.ssh/mcp-approval2_ed25519` on the operator laptop | Interactive `ssh root@vm` for incident response, manual restarts, file inspection |
| Deploy key | GH-Actions secret `HETZNER_SSH_PRIVATE_KEY` (in environment `hetzner-production`) | Automated workflows that SSH in to pull images / restart docker-compose |

Why split:

- **Independent rotation:** rotate the deploy key on its own cadence (e.g.
  every workflow-secret rotation) without forcing operators to re-import
  their key.
- **Audit trail:** auth.log clearly distinguishes human-operator logins
  from GH-Actions runs.
- **Scope reduction:** the deploy key can be a `restrict`-prefixed entry in
  `authorized_keys` allowing only a narrow set of commands (e.g.
  `docker compose pull/up`).

Bootstrap a fresh deploy key:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/hetzner-deploy -N "" -C "gh-actions@mcp-approval2-$(date +%Y%m%d)"

# Add the public key to the VM:
ssh-copy-id -i ~/.ssh/hetzner-deploy.pub root@<vm-ip>
# Or via cloud-init / Ansible playbook.

# Put the private key into terraform.tfvars (heredoc form):
cat ~/.ssh/hetzner-deploy
# Paste into hetzner_deploy_ssh_private_key.

terraform apply -target='module.github.github_actions_environment_secret.hetzner_ssh_key'
```

---

## 7. Removing-Secrets

When a secret is no longer used by any workflow:

```bash
# 7a. Remove from secrets.tf (delete the resource block).
# 7b. Remove from outputs.tf (managed_secrets list).
# 7c. Remove the corresponding variable in variables.tf.
# 7d. Remove the input from github.tf in the privat env.
# 7e. Remove the variable + tfvars-line from the privat env.
# 7f. Apply:
terraform apply
# → Terraform deletes the secret on GitHub.

# 7g. Verify removal:
gh secret list --repo axel-rogg/mcp-approval2 | grep -i <removed-secret>
# → no output
```

If the resource lingers in state after a rename/refactor:

```bash
terraform state list | grep <secret>
terraform state rm 'module.github.github_actions_secret.<old-name>'
```

---

## 8. Troubleshooting

### `401 Unauthorized` on `terraform plan`

The GitHub provider can't authenticate. Check:

```bash
echo "$GITHUB_TOKEN" | head -c 4   # should print "ghp_"
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/axel-rogg/mcp-approval2 | jq .full_name
```

If the curl fails: regenerate the PAT (it may have expired).

### `403 Resource not accessible by personal access token`

The PAT is missing the `workflow` scope. Regenerate with the correct
scopes (see §1).

### `Error: 404 Not Found` on `data "github_repository"`

The repo doesn't exist yet. Create it manually:

```bash
gh repo create axel-rogg/mcp-approval2 --public --description "Multi-User MCP-Approval"
```

### `Error: Saved value for "auto_init" is not consistent`

This is a known quirk of the provider when adopting an existing repo. The
module pre-empts it via `ignore_changes = [auto_init, ...]`. If you see it
anyway, your `terraform` binary is too old — upgrade to ≥ 1.6.

### Secret value didn't change in GitHub UI after `apply`

GitHub doesn't surface plaintext secrets in the UI — that's expected.
Verify via a workflow run that actually consumes the secret. The
`updated_at` timestamp on the secret will move:

```bash
gh api repos/axel-rogg/mcp-approval2/actions/secrets/HETZNER_VM_HOST | jq .updated_at
```

### `prevent_destroy` blocks `terraform destroy`

That's intentional — see `main.tf` lifecycle block. To intentionally
nuke the repo (rare!):

1. Comment out the `prevent_destroy = true` line.
2. `terraform destroy -target=module.github`.
3. Re-add `prevent_destroy = true`.

### State drift after a manual UI edit

If someone touched the repo via the GitHub UI:

```bash
terraform plan        # shows the drift
terraform apply       # converges back to TF-source
```

Open a calendar reminder: every manual touch of the repo is a deviation
from the IaC baseline. Add a CLAUDE-rules note discouraging UI edits.
