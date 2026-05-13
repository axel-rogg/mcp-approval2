# Renders the cloud-init bootstrap template.
#
# The .tpl file is owned by deploy/hetzner/ (built by a separate workstream).
# This module references it via a relative path so we don't duplicate it.
#
# If the cloud-init file is missing the templatefile() call fails fast at plan
# time — that's the desired behavior (forces the deploy/ workstream to land
# first).

locals {
  cloud_init_path = "${path.module}/../../../deploy/hetzner/cloud-init.yaml.tpl"

  cloud_init_rendered = templatefile(local.cloud_init_path, {
    ssh_public_key = var.operator_ssh_public_key
    instance_name  = var.instance_name
    environment    = var.environment
  })
}
