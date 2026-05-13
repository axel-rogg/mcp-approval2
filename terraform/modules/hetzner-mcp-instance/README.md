# Module: `hetzner-mcp-instance`

Provisions a single Hetzner Cloud VM that hosts the full mcp-approval2 +
mcp-knowledge2 stack via Docker Compose. Cloud-init runs the bootstrap from
`deploy/hetzner/cloud-init.yaml.tpl`.

## Resources

- `hcloud_ssh_key.operator` — operator key (var.operator_ssh_public_key)
- `hcloud_server.mcp` — Ubuntu 24.04, cloud-init bootstrapped, labelled
- `hcloud_firewall.mcp` + `hcloud_firewall_attachment.mcp` — 22 (restricted), 80, 443, icmp
- `hcloud_volume.data` + `hcloud_volume_attachment.data` — optional, only when `data_volume_size_gb > 0`

## Inputs

| Name | Type | Default | Required |
|---|---|---|---|
| `instance_name` | string | — | yes |
| `environment` | string | — | yes |
| `server_type` | string | `cx21` | no |
| `location` | string | `fsn1` | no |
| `operator_ssh_public_key` | string | — | yes |
| `allowed_ssh_ips` | list(string) | `[0.0.0.0/0, ::/0]` | no |
| `data_volume_size_gb` | number | `0` | no |

## Outputs

- `vm_ipv4`, `vm_ipv6`, `ssh_user` (default `deploy`)
- `instance_id`, `volume_id` (null if no volume), `firewall_id`

## Notes

- `lifecycle.ignore_changes` covers `user_data` + `image` — cloud-init only
  fires on first boot, so changing the template after provisioning is a no-op
  on an existing VM. Iterate via SSH or rebuild manually.
- The cloud-init template is referenced relatively
  (`../../../deploy/hetzner/cloud-init.yaml.tpl`) so plan fails fast if the
  deploy/ workstream hasn't landed yet.
