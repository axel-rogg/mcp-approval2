# Environment: `privat`

Single-user, single-instance deployment of mcp-approval2 + mcp-knowledge2 on
one Hetzner Cloud VM, with Cloudflare DNS records pointing at it.

## Resources (after apply)

- 1× `hcloud_server` (Ubuntu 24.04, cx21 by default, cloud-init bootstrapped)
- 1× `hcloud_firewall` (22 restricted, 80, 443, icmp)
- 1× `hcloud_ssh_key` (operator)
- 0..1× `hcloud_volume` (when `data_volume_size_gb > 0`)
- 6× `cloudflare_dns_record` — A + AAAA for `mcp2`, `knowledge2`, `app2`

## Bootstrap

```bash
# 1. Fill secrets
cp terraform.tfvars.example terraform.tfvars
nano terraform.tfvars     # hcloud_token, operator_ssh_public_key, cloudflare_zone_id

# 2. Load env vars (R2 backend creds + Cloudflare API token)
set -a && source <(grep -vE '^\s*(#|$)' ../../../.env | sed 's/^/export /') && set +a

# 3. Init + plan + apply
terraform init
terraform plan
terraform apply

# 4. Get outputs
terraform output ssh_cmd
terraform output -json domains
```

## State

State lives in R2: `s3://terraform-state/mcp-approval2/privat/terraform.tfstate`.
EU jurisdiction (DSGVO).

## Operational notes

- The cloud-init template (`deploy/hetzner/cloud-init.yaml.tpl`) is referenced
  relatively from the `hetzner-mcp-instance` module. The deploy/ workstream
  owns that file; if it's missing, `terraform plan` fails fast.
- `proxied = false` for all DNS records — WebAuthn passkeys break across
  RP_ID changes, and Cloudflare-proxy re-terminates TLS. Revisit only if
  DDoS becomes a problem.
- The Hetzner server has `lifecycle.ignore_changes = [user_data, image]`.
  Editing cloud-init.yaml.tpl after the first apply is a no-op for the
  existing VM — recreate manually if you really need to re-bootstrap.

## Rollback

```bash
terraform destroy        # nukes VM + volume + DNS in one shot
```

The R2 state file is preserved across destroys so re-applying restores the
last-known config (modulo Hetzner reassigning IPs — DNS will point at the
new IP after re-apply).
