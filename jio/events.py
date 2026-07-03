"""Server-sent event hub used to push live status (e.g. update progress)
to every browser tab with the UI open, without polling.
"""

import json
import queue
import threading
import time

_lock = threading.Lock()
_subscribers = set()


def subscribe():
    q = queue.Queue(maxsize=200)
    with _lock:
        _subscribers.add(q)
    return q


def unsubscribe(q):
    with _lock:
        _subscribers.discard(q)


def broadcast(event_type, **data):
    message = json.dumps(dict(data, type=event_type, ts=time.time()))
    with _lock:
        subs = list(_subscribers)
    for q in subs:
        try:
            q.put_nowait(message)
        except queue.Full:
            pass


def stream(q):
    """SSE-formatted generator for one subscriber; unsubscribes on disconnect."""
    try:
        while True:
            try:
                message = q.get(timeout=15)
                yield "data: %s\n\n" % message
            except queue.Empty:
                yield ": keep-alive\n\n"
    finally:
        unsubscribe(q)
