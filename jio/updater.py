"""Self-update: polls the git remote (GitHub) for new commits on the
tracked branch, and when one is found, pulls it in, reinstalls
dependencies, and restarts the process in place.

This only works when Jio is deployed as a git checkout (as deploy/install.sh
sets up) — REPO_ROOT is derived from this file's own location, so it always
points at the checkout this code is running from.
"""

import os
import subprocess
import sys
import threading
import time

from . import events

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIN_CHECK_INTERVAL = 300
INITIAL_DELAY = 15


def _err_text(exc):
    stderr = getattr(exc, "stderr", None)
    return stderr.strip() if stderr else str(exc)


class Updater:
    def __init__(self, get_config):
        self._get_config = get_config
        self._stop = threading.Event()
        self._busy = threading.Lock()
        self.last_checked = None
        self.latest_sha = None
        self.update_available = False
        self.error = None

    def start(self):
        threading.Thread(target=self._loop, daemon=True).start()

    def stop(self):
        self._stop.set()

    # -- git plumbing ---------------------------------------------------

    def _git(self, *args, timeout=30):
        return subprocess.run(
            ["git", *args], cwd=REPO_ROOT, capture_output=True, text=True,
            timeout=timeout, check=True,
        )

    def is_git_repo(self):
        return os.path.isdir(os.path.join(REPO_ROOT, ".git"))

    def current_commit(self):
        try:
            return self._git("rev-parse", "HEAD").stdout.strip()
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
            return None

    def remote_url(self):
        try:
            return self._git("remote", "get-url", "origin").stdout.strip()
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
            return None

    def _remote_commit(self, branch):
        result = self._git("ls-remote", "origin", "refs/heads/%s" % branch, timeout=20)
        line = result.stdout.strip().splitlines()
        if not line:
            raise RuntimeError("branch '%s' not found on remote" % branch)
        return line[0].split()[0]

    # -- public API -------------------------------------------------------

    def status(self):
        cfg = self._get_config()
        return {
            "enabled": self.is_git_repo(),
            "remote": self.remote_url(),
            "branch": cfg.get("update_branch", "main"),
            "current": self.current_commit(),
            "latest": self.latest_sha,
            "update_available": self.update_available,
            "auto_update": bool(cfg.get("auto_update")),
            "last_checked": self.last_checked,
            "error": self.error,
        }

    def check(self):
        self.last_checked = time.time()
        if not self.is_git_repo():
            self.error = "not a git checkout"
            return self.status()
        branch = self._get_config().get("update_branch", "main")
        try:
            self.latest_sha = self._remote_commit(branch)
            self.error = None
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, RuntimeError, OSError) as exc:
            self.error = _err_text(exc)
            self.update_available = False
            return self.status()
        current = self.current_commit()
        self.update_available = bool(current and self.latest_sha and current != self.latest_sha)
        return self.status()

    def apply(self):
        """Kick off the update in a background thread; returns False if one
        is already running."""
        if not self._busy.acquire(blocking=False):
            return False
        threading.Thread(target=self._run_locked, daemon=True).start()
        return True

    def _run_locked(self):
        try:
            self._run_update_sequence()
        finally:
            self._busy.release()

    def _run_update_sequence(self):
        branch = self._get_config().get("update_branch", "main")
        events.broadcast("update_checking")
        self.check()
        if self.error:
            events.broadcast("update_error", message=self.error)
            return
        if not self.update_available:
            events.broadcast("update_none")
            return

        events.broadcast("update_downloading", sha=self.latest_sha[:8])
        try:
            self._git("fetch", "origin", branch, timeout=60)
            self._git("reset", "--hard", "origin/%s" % branch, timeout=30)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            self.error = _err_text(exc)
            events.broadcast("update_error", message=self.error)
            return

        events.broadcast("update_installing")
        req_file = os.path.join(REPO_ROOT, "requirements.txt")
        if os.path.isfile(req_file):
            try:
                subprocess.run(
                    [sys.executable, "-m", "pip", "install", "-q", "-r", req_file],
                    cwd=REPO_ROOT, capture_output=True, text=True, timeout=180, check=True,
                )
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
                self.error = _err_text(exc)
                events.broadcast("update_error", message=self.error)
                return

        events.broadcast("update_restarting")
        time.sleep(1.5)
        self._restart()

    def _restart(self):
        os.chdir(REPO_ROOT)
        os.execv(sys.executable, [sys.executable, "-m", "jio"])

    def _loop(self):
        if self._stop.wait(INITIAL_DELAY):
            return
        while not self._stop.is_set():
            interval = max(int(self._get_config().get("update_check_interval", 1800)), MIN_CHECK_INTERVAL)
            self.check()
            if self.update_available and not self.error:
                events.broadcast("update_available", sha=(self.latest_sha or "")[:8])
                if self._get_config().get("auto_update"):
                    self.apply()
            if self._stop.wait(interval):
                break
