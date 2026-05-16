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

  # ── Doppler CLI (Single-Source-of-Truth for secrets) ────────────────
  # Installed for everyone (root + deploy) via the /usr/local/bin install
  # path baked into the upstream install.sh. The deploy user later uses
  # `scripts/doppler-vm-sync.sh` to pull secrets into the .env file.
  # See: docs/runbooks/runbook-doppler.md
  - curl -Ls --tlsv1.2 --proto '=https' --retry 3 https://cli.doppler.com/install.sh | sh

  # ── Firewall ────────────────────────────────────────────────────────
  - ufw default deny incoming
  - ufw default allow outgoing
  - ufw allow 22/tcp
  - ufw allow 80/tcp
  - ufw allow 443/tcp
  - ufw --force enable

  # ── Sysctl reload ───────────────────────────────────────────────────
  - sysctl --system

  # ── NO swapfile ─────────────────────────────────────────────────────
  # OpenBao requires mlock to keep secret material from being paged out
  # (disable_mlock was removed from the OpenBao config schema in late 2026).
  # A swapfile + mlock-pinned memory is a known crash-vector under memory
  # pressure, and the CPX22 (4 GB RAM) easily fits the 5-container working
  # set: caddy ~80 MB, postgres ~400 MB, openbao ~150 MB, approval2 ~200 MB,
  # knowledge2 ~200 MB → headroom ≈ 3 GB. Adding swap buys us nothing and
  # weakens the vault. If you ever upgrade the OS image on an existing VM
  # that still has /swapfile from an older template, remediate manually:
  #
  #   sudo swapoff /swapfile && sudo rm /swapfile && \
  #     sudo sed -i '/swapfile/d' /etc/fstab

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

    # 1) Drop the Doppler service-token (one-time):
    #      terraform output -raw doppler_vm_token         # on operator host
    #    Then on the VM:
    #      echo 'dp.st.privat.xxx' > /opt/mcp-approval2/.doppler-token
    #      chmod 600 /opt/mcp-approval2/.doppler-token

    # 2) Run setup — it will fetch the .env from Doppler automatically:
    cd /opt/mcp-approval2/deploy/hetzner
    bash setup.sh

  Full runbook: docs/runbooks/runbook-doppler.md (Phase 6)
  ─────────────────────────────────────────────────────────────────
