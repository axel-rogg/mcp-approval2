# Module: `gcp-mcp-instance` (STUB)

**Status:** Phase 2 placeholder — see PLAN-hetzner-deployment.md §14.

This module is intentionally empty. It exists to:

1. Reserve the directory + name in `terraform/modules/`.
2. Document the target resource surface (see comments in `main.tf`).
3. Allow `environments/business/main.tf` to reference `source = "../../modules/gcp-mcp-instance"` once Phase 2 starts, without needing a tree-wide rename.

## Why GCP for `business`?

The business workspace lives in a Google Workspace tenant. Running compute in
the same cloud minimises latency for Workspace API calls, allows IAM-based
service-account auth instead of long-lived OAuth refresh tokens, and the
GCP-billing flows directly via the Workspace contract.

## When to implement

Trigger conditions (any one):

- Business-Workspace user actually wants to onboard
- Hetzner-Privat is stable for ≥ 30 days post-cutover
- Decision on Cloud Run v2 (stateless) vs. GCE-VM (mirror Hetzner) is made

## Resource shape (target)

See `main.tf` header comments for the full list. The outputs are designed to
match `hetzner-mcp-instance` 1:1 so the consuming environment stays cloud-agnostic.
