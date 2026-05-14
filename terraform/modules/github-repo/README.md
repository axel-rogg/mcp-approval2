# Module: github-repo

Manages **settings** of an existing GitHub repository via Terraform:

- Repository options (visibility, merge-policy, vulnerability alerts)
- Branch-protection on `main`
- Deployment environments (`hetzner-production`, optionally `gcp-business`)
- A **minimal** set of Actions secrets (Doppler bootstrap token only)
- Repository-level Actions variables (non-sensitive)

The module **does not create the repository itself** — the repo is created
once manually so that GitHub's billing/visibility defaults are picked
deliberately. Terraform then converges settings on the existing repo.

## Required GitHub PAT scopes

Generate a Personal-Access-Token at <https://github.com/settings/tokens>
(classic PAT, not fine-grained — fine-grained tokens cannot yet manage
environments on personal repos):

- `repo` (full) — read/write repo settings + branch protection
- `workflow` — Actions secrets / variables / environments
- `admin:org` — **only** if managing org-owned repos, NOT needed for
  personal repos

Export before running Terraform:

```bash
export GITHUB_TOKEN="ghp_xxxxx"
# Or source from a gitignored .env / 1Password CLI.
```

## Doppler-Integration (post-2026-05-14)

**Before Doppler:** 13 secrets were managed directly by Terraform via
`github_actions_secret` / `github_actions_environment_secret` resources.
Rotating any value meant editing `terraform.tfvars` and running `apply`.

**With Doppler:** only `DOPPLER_TOKEN_GHA` (+ its env-mirror `DOPPLER_TOKEN`)
stays in GitHub-Secrets directly — the rest flows in via the **Doppler ->
GitHub-Actions sync**. Doppler becomes the Single-Source-of-Truth for every
secret; Terraform just pushes the bootstrap token that lets workflows
authenticate against Doppler.

### Activating the Doppler -> GitHub-Actions sync (one-time, in Doppler UI)

1. Open the Doppler dashboard:
   <https://dashboard.doppler.com/workplace/projects/mcp-approval2>
2. Project **mcp-approval2** -> tab **Integrations** -> click
   **"GitHub Actions"**.
3. Click **Connect** -> authorise the Doppler-GitHub-App for `axel-rogg`.
4. Sync-Mode: **"Per Environment"**.
   - Map Doppler-Config `privat` -> GitHub-Environment `hetzner-production`.
5. **Save**.

From this point on, every secret in the `privat` config is mirrored into
the GH `hetzner-production` environment automatically — including future
adds. No more Terraform-round-trip for secret-rotation.

### What Terraform still pushes directly (chicken-and-egg only)

| Secret name | Scope | Why direct |
| --- | --- | --- |
| `DOPPLER_TOKEN_GHA` | repository | workflows need it to auth against Doppler |
| `DOPPLER_TOKEN` | environment `hetzner-production` | same value, conventional name |

Both come from `var.doppler_gha_service_token`, which is wired from
`module.doppler.github_actions_service_token` in
`environments/privat/github.tf`.

## State-sensitivity warning

`doppler_gha_service_token` lands in the Terraform state file as
**plaintext** (still — only one secret instead of 13). The state backend
therefore MUST be encrypted at rest:

| Backend | Verdict |
| --- | --- |
| R2 (default for this project) | OK — encrypted at rest by Cloudflare |
| S3 with SSE-KMS / SSE-S3 | OK |
| local file | NOT OK — never use for sensitive secrets |
| TF Cloud / TF Enterprise | OK — encrypted + access-controlled |

The R2 backend used here lives in the EU jurisdiction
(`...eu.r2.cloudflarestorage.com`), covering DSGVO requirements for the
operator data.

## Secret rotation

**For the Doppler bootstrap token** (managed by this module):

```bash
# Roll the service-token in the doppler-setup module first
cd terraform/environments/privat
terraform apply -target='module.doppler.doppler_service_token.github_actions'
# Then apply this module to push the new value into GH
terraform apply -target='module.github'
```

**For everything else** (CLOUDFLARE_API_TOKEN, HCLOUD_TOKEN, R2_*, ...):

1. Update the value in the Doppler UI (or via `doppler secrets set`).
2. The Doppler -> GitHub-Actions sync pushes the new value automatically
   within seconds. No Terraform apply required.

## Inputs

See `variables.tf` — only one sensitive input remains
(`doppler_gha_service_token`).

## Outputs

- `repository_name`, `repository_full_name`, `repository_node_id`
- `environment_hetzner_prod`, `environment_gcp_business`
- `managed_secrets` — list of secret **names** (no values). Now contains
  only the two Doppler-bootstrap entries; everything else lives in Doppler.
