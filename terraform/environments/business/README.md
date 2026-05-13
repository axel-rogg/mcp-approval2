# Environment: `business` (STUB)

**Status:** Phase-2 placeholder. See PLAN-hetzner-deployment.md §14.

This directory exists so the `terraform/environments/` tree is shaped
correctly from day-1. Activating it is a Phase-2 task once the Hetzner
`privat` deployment is stable.

## When activated

This environment will provision the GCP-backed business workspace:

- `module "vm"` → `../../modules/gcp-mcp-instance` (Cloud Run v2 or GCE-VM)
- `module "dns"` → `../../modules/cloudflare-dns` (or business-domain provider)
- Separate R2 state key: `mcp-approval2/business/terraform.tfstate`
- Separate provider config: GCP credentials via `GOOGLE_APPLICATION_CREDENTIALS`
- Separate `terraform.tfvars` (gitignored)

## Activation steps (Phase 2)

1. Build out `modules/gcp-mcp-instance/main.tf` per the TODO list there.
2. Replace this README + main.tf stub with real config (mirror `environments/privat/`).
3. Create `terraform.tfvars.example`, `variables.tf`, `versions.tf`, `backend.tf`.
4. `terraform init && terraform plan && terraform apply`.
