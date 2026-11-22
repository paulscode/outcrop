"""The gateway's event hub: a stopping gateway ends its subscribers' streams at once."""
import asyncio

from outcrop.gateway.state import Hub


def test_close_ends_every_stream_even_a_full_one():
    async def run():
        hub = Hub(size=2)
        quiet, full = hub.subscribe(), hub.subscribe()
        hub.publish("a")
        hub.publish("b")                 # `full` is at its size now, and so is `quiet`
        hub.close()
        for q in (quiet, full):
            seen = [q.get_nowait() for _ in range(q.qsize())]
            assert seen[-1] is None and len(seen) <= 2
    asyncio.run(run())
