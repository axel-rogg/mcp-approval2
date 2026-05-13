# Module: github-repo

Manages **settings** of an existing GitHub repository via Terraform:

- Repository options (visibility, merge-policy, vulnerability alerts)
- Branch-protection on `main`
- Deployment environments (`hetzner-production`, optionally `gcp-business`)
- Repository-level + environment-level Actions secrets
- Repository-level Actions variables

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

## State-sensitivity warning

All secrets passed into this module end up in the Terraform state file as
**plaintext**. The state backend therefore MUST be encrypted at rest:

| Backend | Verdict |
| --- | --- |
| R2 (default for this project) | OK — encrypted at rest by Cloudflare |
| S3 with SSE-KMS / SSE-S3 | OK |
| local file | NOT OK — never use for sensitive secrets |
| TF Cloud / TF Enterprise | OK — encrypted + access-controlled |

The R2 backend used here lives in the EU jurisdiction (`...eu.r2.cloudflarestorage.com`),
covering DSGVO requirements for the operator data.

## Secret rotation

Rotate a single secret:

```bash
cd terraform/environments/privat
nano terraform.tfvars            # update the value
terraform apply \
  -target='module.github.github_actions_environment_secret.hetzner_ssh_key'
```

Rotate everything (e.g. quarterly):

```bash
terraform apply
```

## Adding a new secret

1. Add the variable to `variables.tf` (mark `sensitive = true`).
2. Add the resource to `secrets.tf` (repo-level → `github_actions_secret`,
   env-level → `github_actions_environment_secret`).
3. Add the secret NAME to the `managed_secrets` output in `outputs.tf`.
4. Wire the value through in `environments/privat/github.tf` and document the
   variable in `environments/privat/variables.tf` + `terraform.tfvars.example`.

## Removing a secret

```bash
# 1. Remove the resource block from secrets.tf
# 2. terraform apply  → deletes the secret on GitHub
# 3. (optional) terraform state rm if the resource went stale
```

## Inputs

See `variables.tf` for the full list. All sensitive inputs are marked
`sensitive = true`.

## Outputs

- `repository_name`, `repository_full_name`, `repository_node_id`
- `environment_hetzner_prod`, `environment_gcp_business`
- `managed_secrets` — list of secret **names** (no values)
