"""The gateway's HTTP connections: uvicorn's httptools protocol with two limits uvicorn does not have.

- **Headers in time.**  A request's headers must arrive within HEADER_TIMEOUT_S of the connection opening (or of the
  request's first byte on a kept-alive connection); else the connection is closed.  uvicorn waits for ever, so idle
  half-sent requests could pile up until the process runs out of file descriptors (slowloris).
- **Connections per address.**  At most MAX_PER_IP open connections from one client address (an IPv6 /64, since a
  device can use any address in it); more are closed at once.

The body's own time limits are in app.py (BODY_IDLE_S, BODY_TOTAL_S).
"""
from __future__ import annotations

import collections

from uvicorn.protocols.http.httptools_impl import HttpToolsProtocol

from ..common.policy import addr_keys

HEADER_TIMEOUT_S = 20.0
MAX_PER_IP = 256


class GatewayProtocol(HttpToolsProtocol):
    per_ip: collections.Counter = collections.Counter()     # client address -> open connections (one event loop)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._header_timer = None
        self._keys: list[tuple[str, int]] = []

    def connection_made(self, transport) -> None:
        super().connection_made(transport)
        self._keys = addr_keys(self.client[0]) if self.client else []
        over = False
        for key, mult in self._keys:
            GatewayProtocol.per_ip[key] += 1
            over = over or GatewayProtocol.per_ip[key] > MAX_PER_IP * mult
        if over:
            transport.close()
            return
        self._arm()

    def connection_lost(self, exc) -> None:
        self._disarm()
        for key, _ in self._keys:
            GatewayProtocol.per_ip[key] -= 1
            if GatewayProtocol.per_ip[key] <= 0:
                del GatewayProtocol.per_ip[key]
        self._keys = []
        super().connection_lost(exc)

    def on_message_begin(self) -> None:
        super().on_message_begin()
        self._arm()

    def on_headers_complete(self) -> None:
        self._disarm()
        super().on_headers_complete()

    def _arm(self) -> None:
        self._disarm()
        self._header_timer = self.loop.call_later(HEADER_TIMEOUT_S, self._headers_late)

    def _disarm(self) -> None:
        if self._header_timer is not None:
            self._header_timer.cancel()
            self._header_timer = None

    def _headers_late(self) -> None:
        self._header_timer = None
        if not self.transport.is_closing():
            self.transport.close()
