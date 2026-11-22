#!/bin/bash
# webnet.sh  - (StartOS, the outcrop-webnet unit, as root) the network the chat's web access runs in: a network namespace of
# its own (outcrop-web) for the page fetcher and SearXNG, joined to the container by a veth pair, that reaches the public
# internet and nothing else.  The StartOS counterpart of Ubuntu's IPAddressDeny (outcrop-fetch.service) and
# setup/searxng/net.sh: a fetcher or a search engine that was taken over must not reach the LAN, StartOS (the container's
# gateway, which answers HTTP), Outcrop's own services (the gateway, the console, Strata) or anything else private.
#
#   Two layers, each enough on its own:
#   - in the container's namespace (table inet outcrop_web): what comes in from the veth may go to StartOS's DNS resolver
#     on port 53, and to public addresses; nothing private, no IPv6, and nothing addressed to the container itself;
#   - in outcrop-web (table inet outcrop_web_ns): the same, on the way out, so loopback and private addresses are dropped
#     (the fetcher's own check, outcrop.fetcher, then sees its probes time out and reports itself isolated).
# Safe to run again: every step replaces what it makes.
set -euo pipefail
NS=outcrop-web
HOST_IF=owh            # the container's end of the pair
NS_IF=own              # the namespace's end
HOST_IP=10.255.53.1
NS_IP=10.255.53.2
DNS=$(awk '/^nameserver/ && $2 !~ /:/ {print $2; exit}' /etc/resolv.conf)
[ -n "$DNS" ] || { echo "no IPv4 nameserver in /etc/resolv.conf" >&2; exit 1; }
PRIVATE="0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, \
192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4"

ip netns list | grep -qw "$NS" || ip netns add "$NS"
ip link del "$HOST_IF" 2>/dev/null || true
ip link add "$HOST_IF" type veth peer name "$NS_IF" netns "$NS"
ip addr add "$HOST_IP/30" dev "$HOST_IF"
ip link set "$HOST_IF" up
ip -n "$NS" link set lo up
ip -n "$NS" addr add "$NS_IP/30" dev "$NS_IF"
ip -n "$NS" link set "$NS_IF" up
ip -n "$NS" route replace default via "$HOST_IP"
mkdir -p "/etc/netns/$NS"
echo "nameserver $DNS" > "/etc/netns/$NS/resolv.conf"
sysctl -q -w net.ipv4.ip_forward=1
ip netns exec "$NS" sysctl -q -w net.ipv6.conf.all.disable_ipv6=1 || true

nft -f - <<EOF
table inet outcrop_web
delete table inet outcrop_web
table inet outcrop_web {
  chain forward {
    type filter hook forward priority 0; policy accept;
    oifname "$HOST_IF" ct state established,related accept
    oifname "$HOST_IF" drop
    iifname "$HOST_IF" ct state established,related accept
    iifname "$HOST_IF" meta nfproto ipv6 drop
    iifname "$HOST_IF" ip daddr $DNS meta l4proto { udp, tcp } th dport 53 accept
    iifname "$HOST_IF" ip daddr { $PRIVATE } drop
    iifname "$HOST_IF" accept
  }
  chain input {
    type filter hook input priority 0; policy accept;
    iifname "$HOST_IF" ct state established,related accept
    iifname "$HOST_IF" drop
  }
  chain postrouting {
    type nat hook postrouting priority 100; policy accept;
    ip saddr $NS_IP oifname != "$HOST_IF" masquerade
  }
}
EOF

ip netns exec "$NS" nft -f - <<EOF
table inet outcrop_web_ns
delete table inet outcrop_web_ns
table inet outcrop_web_ns {
  chain output {
    type filter hook output priority 0; policy accept;
    ct state established,related accept
    meta nfproto ipv6 drop
    ip daddr $DNS meta l4proto { udp, tcp } th dport 53 accept
    ip daddr { $PRIVATE } drop
  }
}
EOF

# the fetcher's socket, reachable by the service user (group outcrop-fetch) and nobody else
install -d -o outcrop-fetch -g outcrop-fetch -m 0750 /run/outcrop-fetch
echo "outcrop-web: $NS_IP, DNS $DNS, private addresses and IPv6 dropped"
