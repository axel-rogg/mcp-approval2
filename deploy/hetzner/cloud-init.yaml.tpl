#cloud-config
# cloud-init.yaml.tpl — VM bootstrap script consumed by Hetzner-Cloud at first boot.
#
# Rendered by Terraform (see terraform/environments/privat/hetzner.tf):
#   ${ssh_public_key}  — operator's SSH public key (single line)
#
# This file is also renderable via `bash render-config.sh` when
# SSH_PUBLIC_KEY is exported, for manual sanity-checks.

package_update: true
package_upgrade: true

packages:
  - ca-certificates
  - curl
  - git
  - gnupg
  - jq
  - ufw
  - fail2ban
  - unattended-upgrades
  - docker.io
  - docker-compose-plugin
  - gettext-base

users:
  - name: deploy
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: true
    ssh_authorized_keys:
      - ${ssh_public_key}

write_files:
  # Tune sysctl for Postgres + container workloads.
  - path: /etc/sysctl.d/99-mcp.conf
    content: |
      vm.max_map_count=262144
      vm.overcommit_memory=1
      net.core.somaxconn=1024
      net.ipv4.tcp_max_syn_backlog=2048

  # Daily unattended security updates.
  - path: /etc/apt/apt.conf.d/20auto-upgrades
    content: |
      APT::Periodic::Update-Package-Lists "1";
      APT::Periodic::Unattended-Upgrade "1";
      APT::Periodic::AutocleanInterval "7";

  # Basic fail2ban config for SSH brute-force protection.
  - path: /etc/fail2ban/jail.local
    content: |
      [sshd]
      enabled = true
      maxretry = 5
      bantime = 3600
      findtime = 600

runcmd:
  # ── Docker ──────────────────────────────────────────────────────────
  - systemctl enable docker
  - systemctl start docker
  - usermod -aG docker deploy

  # ── Firewall ────────────────────────────────────────────────────────
  - ufw default deny incoming
  - ufw default allow outgoing
  - ufw allow 22/tcp
  - ufw allow 80/tcp
  - ufw allow 443/tcp
  - ufw --force enable

  # ── Sysctl reload ───────────────────────────────────────────────────
  - sysctl --system

  # ── 2GB swap (CX21 only has 8 GB RAM — Postgres + containers benefit) ──
  - |
    if ! swapon --show | grep -q swapfile; then
      fallocate -l 2G /swapfile
      chmod 600 /swapfile
      mkswap /swapfile
      swapon /swapfile
      echo '/swapfile none swap sw 0 0' >> /etc/fstab
    fi

  # ── Repo clone (read-only public URL; private repos need an SSH key) ──
  - mkdir -p /opt/mcp-approval2
  - chown deploy:deploy /opt/mcp-approval2
  - sudo -u deploy git clone https://github.com/axel-rogg/mcp-approval2.git /opt/mcp-approval2
  - chown -R deploy:deploy /opt/mcp-approval2

  # ── Fail2ban + unattended-upgrades active ───────────────────────────
  - systemctl enable --now fail2ban
  - systemctl enable --now unattended-upgrades

final_message: |
  ─────────────────────────────────────────────────────────────────
  VM bootstrap complete after $UPTIME seconds.

  Next steps (as user 'deploy'):
    ssh deploy@<VM_IP>
    cd /opt/mcp-approval2/deploy/hetzner
    bash generate-secrets.sh > .env
    nano .env                 # set GOOGLE_OAUTH_* + DOMAIN_*
    bash setup.sh
  ─────────────────────────────────────────────────────────────────
