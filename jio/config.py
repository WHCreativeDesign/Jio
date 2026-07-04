"""Configuration handling for Jio.

Config lives in a JSON file (default: ~/.config/jio/config.json, overridable
with the JIO_CONFIG environment variable). It is created with defaults on
first run and can be edited from the web UI settings panel.
"""

import json
import os
import socket
import threading

DEFAULT_PORT = 8420
DISCOVERY_PORT = 8421

_lock = threading.Lock()


def config_path():
    override = os.environ.get("JIO_CONFIG")
    if override:
        return override
    base = os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config"))
    return os.path.join(base, "jio", "config.json")


def _defaults():
    return {
        "device_name": socket.gethostname() or "jio",
        "port": DEFAULT_PORT,
        "host_mode": False,
        # Extra directories to expose as drives, besides auto-detected mounts.
        "extra_paths": [],
        # Where "internal storage" points. On a Pi this is the SD card.
        "internal_root": os.path.expanduser("~"),
        # Self-update: track this branch of the git remote named "origin".
        "auto_update": False,
        "update_branch": "main",
        "update_check_interval": 1800,
    }


def load():
    path = config_path()
    cfg = _defaults()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            stored = json.load(fh)
        if isinstance(stored, dict):
            cfg.update(stored)
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return cfg


def save(cfg):
    path = config_path()
    with _lock:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, indent=2)
        os.replace(tmp, path)
