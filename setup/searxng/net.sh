#!/bin/sh
# Installed as /usr/local/libexec/outcrop-searxng-net (root-owned) and run by outcrop-searxng.service before the container:
# SearXNG gets a network of its own, and the firewall drops its traffic to private addresses, so a search engine
# that took over the container could not use it to reach the LAN.  (The host itself is closed to it by ufw: the
# container's addresses are not on the LAN list.)  The rules live in a chain of their own, rebuilt in order at every
# start, which DOCKER-USER jumps to for the network's traffic.
set -eu
NET=outcrop-searxng
SUBNET=172.30.53.0/24
CHAIN=OUTCROP-SEARXNG
docker network inspect "$NET" >/dev/null 2>&1 || docker network create --subnet "$SUBNET" "$NET" >/dev/null

iptables -N "$CHAIN" 2>/dev/null || true
iptables -F "$CHAIN"
# replies to connections it made itself
iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
# DNS to the host's resolvers (the router, say): Docker's resolver may ask them from the container's network
for ns in $(awk '/^nameserver/ {print $2}' /run/systemd/resolve/resolv.conf /etc/resolv.conf 2>/dev/null \
            | grep -v ':' | grep -v '^127\.' | sort -u); do
  for proto in udp tcp; do
    iptables -A "$CHAIN" -d "$ns" -p "$proto" --dport 53 -j RETURN
  done
done
for dst in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do
  iptables -A "$CHAIN" -d "$dst" -j DROP
done

# the jump, once; rules an older version put straight into DOCKER-USER are removed
iptables -C DOCKER-USER -s "$SUBNET" -j "$CHAIN" 2>/dev/null || iptables -I DOCKER-USER -s "$SUBNET" -j "$CHAIN"
iptables -S DOCKER-USER | grep -- "-s $SUBNET" | grep -v -- "-j $CHAIN" | sed 's/^-A /-D /' | while read -r rule; do
  # shellcheck disable=SC2086
  iptables $rule
done
