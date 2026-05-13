#!/usr/bin/env bash
# Quick SSH-helper fuer die Hetzner-VM.
# Liest IP aus terraform output (default: terraform/environments/privat)
# oder aus $HETZNER_VM_IP.

set -euo pipefail

TF_DIR="${TF_DIR:-terraform/environments/privat}"

VM_IP=""
if [[ -d "$TF_DIR" ]]; then
  VM_IP=$(cd "$TF_DIR" && terraform output -raw vm_ipv4 2>/dev/null) || VM_IP=""
fi

VM_IP="${VM_IP:-${HETZNER_VM_IP:-}}"

if [[ -z "$VM_IP" ]]; then
  echo "ERROR: VM IP not found." >&2
  echo "       Set HETZNER_VM_IP=... or run 'terraform output' in $TF_DIR" >&2
  exit 1
fi

SSH_USER="${SSH_USER:-deploy}"
echo "-> SSH to $SSH_USER@$VM_IP"
exec ssh "$SSH_USER@$VM_IP" "$@"
