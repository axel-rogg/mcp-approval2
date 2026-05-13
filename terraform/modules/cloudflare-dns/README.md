# Module: `cloudflare-dns`

Creates DNS records (A + optional AAAA) for the three subdomains of one
mcp-approval2 instance: `mcp.*`, `knowledge.*`, `app.*`.

The module is intentionally **flat** (no nested loop / for_each over a map)
so import-IDs and plan diffs stay readable when records are eventually
imported from the existing zone state.

## Resources

Per instance, up to 6 records:

- `cloudflare_dns_record.mcp` + `.mcp_v6`
- `cloudflare_dns_record.knowledge` + `.knowledge_v6`
- `cloudflare_dns_record.app` + `.app_v6`

`*_v6` records are conditional on `target_ipv6 != ""`.

## Inputs

| Name | Type | Default | Required |
|---|---|---|---|
| `zone_id` | string | — | yes |
| `instance_name` | string | — | yes |
| `target_ipv4` | string | — | yes |
| `target_ipv6` | string | `""` | no |
| `domain_mcp` | string | — | yes |
| `domain_knowledge` | string | — | yes |
| `domain_app` | string | — | yes |
| `proxied` | bool | `false` | no |

## Outputs

- `fqdns` — list of 3 hostnames
- `domain_mcp`, `domain_knowledge`, `domain_app` — individual FQDNs
- `urls` — map with `mcp` / `knowledge` / `app` → `https://...`

## Note on `proxied`

WebAuthn passkey assertions require an end-to-end TLS chain the browser can
validate against the same origin used at registration. Cloudflare proxying
re-terminates TLS and rewrites some headers — works for most apps, but each
RP_ID change costs a re-registration. We default to **`proxied = false`**
(direct A-record) and reserve the proxied path for later DDoS-protection
work.
