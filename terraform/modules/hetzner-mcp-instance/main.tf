# Hetzner Cloud server for mcp-approval2 + mcp-knowledge2.
#
# Provides:
#   - 1× hcloud_server (Ubuntu 24.04, cloud-init bootstrapped)
#   - 1× hcloud_ssh_key (operator key)
#   - 1× hcloud_firewall + attachment (22/80/443 + icmp)
#   - 0..1× hcloud_volume + attachment (when data_volume_size_gb > 0)

resource "hcloud_ssh_key" "operator" {
  name       = "${var.instance_name}-operator"
  public_key = var.operator_ssh_public_key

  labels = {
    instance    = var.instance_name
    environment = var.environment
    managed_by  = "terraform"
  }
}

resource "hcloud_server" "mcp" {
  name        = "${var.instance_name}-mcp"
  server_type = var.server_type
  location    = var.location
  image       = "ubuntu-24.04"
  ssh_keys    = [hcloud_ssh_key.operator.id]

  user_data = local.cloud_init_rendered

  labels = {
    instance    = var.instance_name
    environment = var.environment
    role        = "mcp-host"
    managed_by  = "terraform"
  }

  # Don't recreate the server just because cloud-init changed — that's a
  # destructive action and cloud-init only runs on first boot anyway.
  # If the bootstrap script needs to change post-creation, do it via SSH
  # or a re-image workflow, not by rebuilding.
  #
  # `prevent_destroy = true` blocks `terraform destroy` + accidental
  # resource-renames from nuking the only VM. Real destroy: comment this
  # out, `terraform apply`, then `terraform destroy`.
  lifecycle {
    ignore_changes = [
      user_data,
      image,
    ]
    prevent_destroy = true
  }
}

resource "hcloud_firewall" "mcp" {
  name = "${var.instance_name}-mcp-firewall"

  # SSH — restrict in production via var.allowed_ssh_ips
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.allowed_ssh_ips
  }

  # HTTP — needed for Let's Encrypt HTTP-01 challenge + redirect-to-HTTPS
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # HTTPS — public MCP API + PWA
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # ICMP — ping / path-MTU / debugging
  rule {
    direction  = "in"
    protocol   = "icmp"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  labels = {
    instance    = var.instance_name
    environment = var.environment
    managed_by  = "terraform"
  }
}

resource "hcloud_firewall_attachment" "mcp" {
  firewall_id = hcloud_firewall.mcp.id
  server_ids  = [hcloud_server.mcp.id]
}

# Optional data volume — for pgdata / R2-equivalent storage that should
# survive a VM rebuild. Default off (0 GB == disabled).
resource "hcloud_volume" "data" {
  count    = var.data_volume_size_gb > 0 ? 1 : 0
  name     = "${var.instance_name}-data"
  size     = var.data_volume_size_gb
  location = var.location
  format   = "ext4"

  labels = {
    instance    = var.instance_name
    environment = var.environment
    managed_by  = "terraform"
  }

  # Volume haelt pgdata + R2-Cache. Verlust = User-Daten weg. Real destroy:
  # diesen Block auskommentieren, `terraform apply`, dann `terraform destroy`.
  lifecycle {
    prevent_destroy = true
  }
}

resource "hcloud_volume_attachment" "data" {
  count     = var.data_volume_size_gb > 0 ? 1 : 0
  volume_id = hcloud_volume.data[0].id
  server_id = hcloud_server.mcp.id
  automount = true
}
