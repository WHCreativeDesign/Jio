"""LAN peer discovery over UDP broadcast.

Every Jio instance broadcasts a small JSON announcement on the discovery
port a few times a minute and listens for announcements from others. Peers
that go quiet are pruned. Host-mode instances use the peer list to
aggregate remote drives into the unified view.
"""

import json
import socket
import threading
import time
import uuid

from .config import DISCOVERY_PORT

ANNOUNCE_INTERVAL = 5.0
PEER_TIMEOUT = 20.0
MAGIC = "jio-announce-v1"


class Discovery:
    def __init__(self, get_config):
        self._get_config = get_config
        # Random per-process id so we can recognize our own broadcast echo,
        # which is more reliable than comparing source IPs.
        self._instance_id = uuid.uuid4().hex
        self._peers = {}  # key: "ip:port" -> peer dict
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._threads = []

    def start(self):
        for target in (self._announce_loop, self._listen_loop):
            thread = threading.Thread(target=target, daemon=True)
            thread.start()
            self._threads.append(thread)

    def stop(self):
        self._stop.set()

    def peers(self):
        """Live peers, stale entries pruned."""
        now = time.time()
        with self._lock:
            stale = [k for k, p in self._peers.items() if now - p["last_seen"] > PEER_TIMEOUT]
            for key in stale:
                del self._peers[key]
            return [dict(p) for p in self._peers.values()]

    # -- internals ---------------------------------------------------------

    def _announce_loop(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        while not self._stop.wait(ANNOUNCE_INTERVAL):
            cfg = self._get_config()
            message = json.dumps({
                "magic": MAGIC,
                "instance": self._instance_id,
                "name": cfg.get("device_name", "jio"),
                "port": cfg.get("port", 8420),
                "host_mode": bool(cfg.get("host_mode")),
            }).encode("utf-8")
            try:
                sock.sendto(message, ("255.255.255.255", DISCOVERY_PORT))
            except OSError:
                pass

    def _listen_loop(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("", DISCOVERY_PORT))
        except OSError:
            return
        sock.settimeout(1.0)
        while not self._stop.is_set():
            try:
                data, addr = sock.recvfrom(4096)
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                info = json.loads(data.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if not isinstance(info, dict) or info.get("magic") != MAGIC:
                continue
            port = info.get("port")
            if not isinstance(port, int):
                continue
            if info.get("instance") == self._instance_id:
                continue
            key = "%s:%d" % (addr[0], port)
            with self._lock:
                self._peers[key] = {
                    "id": key,
                    "ip": addr[0],
                    "port": port,
                    "name": str(info.get("name", addr[0]))[:64],
                    "host_mode": bool(info.get("host_mode")),
                    "last_seen": time.time(),
                }
