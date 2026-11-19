#!/bin/bash
# harden.sh firewall | headless | ssh | confirm | status  - the network hardening (docs/SECURITY.md).
#
#   firewall  ufw: deny incoming; allow 22, 80, 443, 8080, 8443 and 11434 (TCP) and mDNS (5353/UDP, so HOSTNAME.local keeps
#             resolving) from the LAN only: this machine's IPv4 network (LAN4, found from the default route), the LAN's
#             IPv6 prefix and link-local addresses.
#   headless  boot to multi-user.target (no GDM or Xorg), stop the desktop now, and turn off GNOME's RDP server (port 3389).
#             `outcrop desktop on` brings the desktop back for a session.
#   ssh       SSH by key only: PasswordAuthentication and KbdInteractiveAuthentication off, PermitRootLogin no.
#   confirm   cancel the rollback timer, after checking a NEW login from another machine works
#   status    what is in place
#
# `firewall` and `ssh` arm a rollback timer first (5 minutes): unless `harden.sh confirm` runs in time, the change is undone
# by itself, so a mistake cannot lock you out.  Keep your current SSH session open until a fresh one has worked.
set -euo pipefail
# the LAN: the IPv4 network on the interface the default route uses (as the kernel set it up), unless LAN4 is given
lan4() {
  local dev
  dev=$(ip -4 route show default | awk '{print $5; exit}')
  [ -n "$dev" ] && ip -4 route show dev "$dev" proto kernel scope link | awk '{print $1; exit}'
}
LAN4=${LAN4:-$(lan4)}
[ -n "$LAN4" ] || { echo "could not tell this machine's LAN network; give it, e.g. LAN4=192.168.1.0/24 $0 $*" >&2; exit 1; }
DROPIN=/etc/ssh/sshd_config.d/01-outcrop-keys-only.conf
ROLLBACK_S=${ROLLBACK_S:-300}

lan6() {   # the LAN segment's own IPv6 prefixes (on-link /64s, not ones reached through a router), plus link-local
  local dev
  dev=$(ip -4 route show default | awk '{print $5; exit}')
  ip -6 route show dev "$dev" 2>/dev/null | awk '$1 ~ /\/64$/ && $1 !~ /^fe80/ && $0 !~ / via / {print $1}' | sort -u
  echo fe80::/10
}

mark() {   # a world-readable note of what was applied, for the console's posture card (the rules themselves are root-only)
  sudo install -d -m 0755 /etc/outcrop-harden
  echo "$(date -Is) $2" | sudo tee "/etc/outcrop-harden/$1" > /dev/null
}

arm() {   # arm "unit-name" "command"
  sudo systemctl stop "$1.timer" 2>/dev/null || true
  sudo systemctl reset-failed "$1.service" "$1.timer" 2>/dev/null || true
  sudo systemd-run --quiet --unit="$1" --on-active="$ROLLBACK_S" /bin/sh -c "$2"
  echo "rollback armed: $1 runs in $ROLLBACK_S s unless you run: $0 confirm"
}

case "${1:-status}" in
firewall)
  arm outcrop-harden-rollback-ufw "/usr/sbin/ufw --force disable"
  sudo ufw --force reset > /dev/null
  sudo sed -i 's/^IPV6=.*/IPV6=yes/' /etc/default/ufw
  sudo ufw default deny incoming > /dev/null
  sudo ufw default allow outgoing > /dev/null
  nets="$LAN4 $(lan6 | sort -u | tr '\n' ' ')"
  for n in $nets; do
    for p in 22 80 443 8080 8443 11434; do
      sudo ufw allow from "$n" to any port "$p" proto tcp comment "outcrop: LAN only" > /dev/null
    done
    sudo ufw allow from "$n" to any port 5353 proto udp comment "outcrop: mDNS" > /dev/null
  done
  sudo ufw --force enable > /dev/null
  sudo ufw status numbered | head -40
  echo "allowed from: $nets"
  mark firewall "LAN only from $nets"
  ;;
headless)
  sudo systemctl set-default multi-user.target
  if systemctl list-unit-files gnome-remote-desktop.service > /dev/null 2>&1; then
    sudo systemctl disable --now gnome-remote-desktop.service 2>/dev/null || true
  fi
  sudo systemctl stop display-manager.service 2>/dev/null || true
  echo "boots to $(systemctl get-default); desktop $(systemctl is-active display-manager.service || true);" \
       "RDP $(systemctl is-active gnome-remote-desktop.service 2>/dev/null || true)"
  mark headless "multi-user.target, RDP off"
  ;;
ssh)
  tmp=$(mktemp)
  cat > "$tmp" <<'EOF'
# SSH by key only (docs/SECURITY.md).  Installed by setup/harden.sh ssh.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
  arm outcrop-harden-rollback-ssh "rm -f $DROPIN; systemctl reload ssh.service 2>/dev/null || true"
  sudo install -o root -g root -m 0644 "$tmp" "$DROPIN"
  rm -f "$tmp"
  if ! sudo sshd -t; then
    sudo rm -f "$DROPIN"
    echo "sshd -t failed; nothing changed" >&2
    exit 1
  fi
  sudo systemctl reload ssh.service 2>/dev/null || true      # with ssh.socket, new connections read the config anyway
  mark ssh "keys only"
  sudo sshd -T | grep -E '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|pubkeyauthentication) '
  echo "now check a NEW login from another machine (keep this session open), then: $0 confirm"
  ;;
confirm)
  for u in outcrop-harden-rollback-ufw outcrop-harden-rollback-ssh; do
    if systemctl is-active -q "$u.timer" 2>/dev/null; then
      sudo systemctl stop "$u.timer"
      echo "kept: $u disarmed"
    fi
  done
  ;;
status)
  echo "firewall: $(sudo ufw status | head -1)"
  echo "boot target: $(systemctl get-default); desktop: $(systemctl is-active display-manager.service || true)"
  echo "RDP: $(systemctl is-active gnome-remote-desktop.service 2>/dev/null || true)"
  sudo sshd -T | grep -E '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) ' | tr '\n' ' '; echo
  systemctl list-timers 'outcrop-harden-rollback-*' --no-legend 2>/dev/null || true
  ;;
*)
  sed -n 2,16p "$0"; exit 2 ;;
esac
