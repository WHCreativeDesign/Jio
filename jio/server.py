"""Jio web server.

Serves the web UI plus a JSON API for browsing and managing files on every
drive this instance exposes. In host mode, drives from other Jio instances
discovered on the LAN are merged into the drive list, and operations on
those drives are transparently proxied to the owning peer.

Remote drive ids look like ``r~<ip>~<port>~<local-drive-id>`` so a single
id string is enough to route any request.
"""

import os
import shutil

import requests
from flask import Flask, Response, abort, jsonify, request, send_file, send_from_directory, stream_with_context

from . import __version__, config, discovery, drives, events, updater

PROXY_TIMEOUT = 15
app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024 * 1024  # 16 GiB uploads

_cfg = config.load()
_discovery = discovery.Discovery(lambda: _cfg)
_updater = updater.Updater(lambda: _cfg)


def get_cfg():
    return _cfg


# -- remote drive routing ---------------------------------------------------

def split_remote(drive_id):
    """Return (base_url, local_drive_id) for a remote drive id, else None."""
    if not drive_id or not drive_id.startswith("r~"):
        return None
    parts = drive_id.split("~", 3)
    if len(parts) != 4:
        return None
    _, ip, port, local_id = parts
    if not port.isdigit():
        return None
    known = {(p["ip"], p["port"]) for p in _discovery.peers()}
    if (ip, int(port)) not in known:
        abort(502, "peer is no longer available")
    return "http://%s:%s" % (ip, port), local_id


def proxy_get(base, endpoint, params, stream=False):
    try:
        return requests.get(base + endpoint, params=params, stream=stream, timeout=PROXY_TIMEOUT)
    except requests.RequestException:
        abort(502, "peer did not respond")


def proxy_post(base, endpoint, **kwargs):
    try:
        return requests.post(base + endpoint, timeout=PROXY_TIMEOUT, **kwargs)
    except requests.RequestException:
        abort(502, "peer did not respond")


def relay(resp):
    """Turn a peer's JSON response into our own response."""
    try:
        return jsonify(resp.json()), resp.status_code
    except ValueError:
        abort(502, "bad response from peer")


def local_drive_or_404(drive_id):
    drive = drives.find_drive(_cfg, drive_id)
    if drive is None:
        abort(404, "unknown drive")
    return drive


def resolve_or_400(drive, path):
    try:
        return drives.resolve(drive, path)
    except ValueError:
        abort(400, "invalid path")


# -- pages -------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


# -- status / settings --------------------------------------------------------

@app.route("/api/status")
def api_status():
    return jsonify({
        "name": _cfg.get("device_name"),
        "version": __version__,
        "host_mode": bool(_cfg.get("host_mode")),
        "peers": [
            {"id": p["id"], "name": p["name"], "ip": p["ip"], "port": p["port"], "host_mode": p["host_mode"]}
            for p in _discovery.peers()
        ],
    })


@app.route("/api/settings", methods=["GET", "POST"])
def api_settings():
    if request.method == "POST":
        body = request.get_json(silent=True) or {}
        if "device_name" in body:
            name = str(body["device_name"]).strip()
            if name:
                _cfg["device_name"] = name[:64]
        if "host_mode" in body:
            _cfg["host_mode"] = bool(body["host_mode"])
        if "extra_paths" in body and isinstance(body["extra_paths"], list):
            _cfg["extra_paths"] = [str(p) for p in body["extra_paths"] if str(p).strip()]
        if "auto_update" in body:
            _cfg["auto_update"] = bool(body["auto_update"])
        config.save(_cfg)
    return jsonify({
        "device_name": _cfg.get("device_name"),
        "host_mode": bool(_cfg.get("host_mode")),
        "extra_paths": _cfg.get("extra_paths", []),
        "auto_update": bool(_cfg.get("auto_update")),
        "port": _cfg.get("port"),
    })


# -- self-update --------------------------------------------------------------

@app.route("/api/update/status")
def api_update_status():
    return jsonify(_updater.status())


@app.route("/api/update/check", methods=["POST"])
def api_update_check():
    return jsonify(_updater.check())


@app.route("/api/update/apply", methods=["POST"])
def api_update_apply():
    if not _updater.is_git_repo():
        abort(400, "not a git checkout, cannot self-update")
    if not _updater.apply():
        return jsonify({"error": "update already in progress"}), 409
    return jsonify({"ok": True})


@app.route("/api/events")
def api_events():
    q = events.subscribe()
    return Response(
        stream_with_context(events.stream(q)),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# -- drives -------------------------------------------------------------------

@app.route("/api/drives")
def api_drives():
    result = []
    for drive in drives.list_drives(_cfg):
        entry = dict(drive)
        entry["device"] = _cfg.get("device_name")
        entry["remote"] = False
        entry.pop("path", None)
        result.append(entry)

    # Peers ask for local_only so drive lists never chain through hosts.
    if _cfg.get("host_mode") and request.args.get("local_only") != "1":
        for peer in _discovery.peers():
            base = "http://%s:%d" % (peer["ip"], peer["port"])
            try:
                resp = requests.get(base + "/api/drives", params={"local_only": "1"}, timeout=PROXY_TIMEOUT)
                peer_drives = resp.json().get("drives", [])
            except (requests.RequestException, ValueError):
                continue
            for entry in peer_drives:
                result.append({
                    "id": "r~%s~%d~%s" % (peer["ip"], peer["port"], entry.get("id", "")),
                    "label": entry.get("label", "drive"),
                    "kind": entry.get("kind", "external"),
                    "total": entry.get("total", 0),
                    "used": entry.get("used", 0),
                    "free": entry.get("free", 0),
                    "device": peer["name"],
                    "remote": True,
                })
    return jsonify({"drives": result})


# -- file operations -----------------------------------------------------------

@app.route("/api/list")
def api_list():
    drive_id = request.args.get("drive", "")
    path = request.args.get("path", "")
    remote = split_remote(drive_id)
    if remote:
        base, local_id = remote
        return relay(proxy_get(base, "/api/list", {"drive": local_id, "path": path}))

    drive = local_drive_or_404(drive_id)
    target = resolve_or_400(drive, path)
    if not os.path.isdir(target):
        abort(404, "not a directory")
    entries = []
    try:
        names = os.listdir(target)
    except OSError:
        abort(403, "cannot read directory")
    for name in sorted(names, key=str.lower):
        full = os.path.join(target, name)
        try:
            st = os.stat(full)
            is_dir = os.path.isdir(full)
        except OSError:
            continue
        entries.append({
            "name": name,
            "is_dir": is_dir,
            "size": 0 if is_dir else st.st_size,
            "mtime": int(st.st_mtime),
        })
    entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
    return jsonify({"path": path.strip("/"), "entries": entries})


@app.route("/api/download")
def api_download():
    drive_id = request.args.get("drive", "")
    path = request.args.get("path", "")
    remote = split_remote(drive_id)
    if remote:
        base, local_id = remote
        upstream = proxy_get(base, "/api/download", {"drive": local_id, "path": path}, stream=True)
        if upstream.status_code != 200:
            abort(upstream.status_code)
        headers = {
            key: upstream.headers[key]
            for key in ("Content-Type", "Content-Length", "Content-Disposition")
            if key in upstream.headers
        }
        return Response(
            stream_with_context(upstream.iter_content(chunk_size=64 * 1024)),
            headers=headers,
        )

    drive = local_drive_or_404(drive_id)
    target = resolve_or_400(drive, path)
    if not os.path.isfile(target):
        abort(404, "not a file")
    return send_file(target, as_attachment=True, download_name=os.path.basename(target))


@app.route("/api/upload", methods=["POST"])
def api_upload():
    drive_id = request.form.get("drive", "")
    path = request.form.get("path", "")
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        abort(400, "no file provided")

    remote = split_remote(drive_id)
    if remote:
        base, local_id = remote
        resp = proxy_post(
            base, "/api/upload",
            data={"drive": local_id, "path": path},
            files={"file": (upload.filename, upload.stream, upload.mimetype)},
        )
        return relay(resp)

    drive = local_drive_or_404(drive_id)
    directory = resolve_or_400(drive, path)
    if not os.path.isdir(directory):
        abort(404, "not a directory")
    filename = os.path.basename(upload.filename.replace("\\", "/"))
    if not filename or filename in (".", ".."):
        abort(400, "bad filename")
    upload.save(os.path.join(directory, filename))
    return jsonify({"ok": True})


@app.route("/api/mkdir", methods=["POST"])
def api_mkdir():
    body = request.get_json(silent=True) or {}
    drive_id = body.get("drive", "")
    path = body.get("path", "")
    remote = split_remote(drive_id)
    if remote:
        base, local_id = remote
        return relay(proxy_post(base, "/api/mkdir", json={"drive": local_id, "path": path}))

    drive = local_drive_or_404(drive_id)
    target = resolve_or_400(drive, path)
    if target == drive["path"]:
        abort(400, "invalid path")
    try:
        os.makedirs(target, exist_ok=False)
    except FileExistsError:
        abort(409, "already exists")
    except OSError:
        abort(403, "cannot create directory")
    return jsonify({"ok": True})


@app.route("/api/delete", methods=["POST"])
def api_delete():
    body = request.get_json(silent=True) or {}
    drive_id = body.get("drive", "")
    path = body.get("path", "")
    remote = split_remote(drive_id)
    if remote:
        base, local_id = remote
        return relay(proxy_post(base, "/api/delete", json={"drive": local_id, "path": path}))

    drive = local_drive_or_404(drive_id)
    target = resolve_or_400(drive, path)
    if target == drive["path"]:
        abort(400, "refusing to delete drive root")
    try:
        if os.path.isdir(target) and not os.path.islink(target):
            shutil.rmtree(target)
        else:
            os.remove(target)
    except FileNotFoundError:
        abort(404, "no such file")
    except OSError:
        abort(403, "cannot delete")
    return jsonify({"ok": True})


@app.route("/api/move", methods=["POST"])
def api_move():
    body = request.get_json(silent=True) or {}
    drive_id = body.get("drive", "")
    remote = split_remote(drive_id)
    if remote:
        base, local_id = remote
        payload = dict(body, drive=local_id)
        return relay(proxy_post(base, "/api/move", json=payload))

    drive = local_drive_or_404(drive_id)
    source = resolve_or_400(drive, body.get("path", ""))
    dest = resolve_or_400(drive, body.get("dest", ""))
    if source == drive["path"] or dest == drive["path"]:
        abort(400, "invalid path")
    if not os.path.exists(source):
        abort(404, "no such file")
    if os.path.exists(dest):
        abort(409, "destination already exists")
    try:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.move(source, dest)
    except OSError:
        abort(403, "cannot move")
    return jsonify({"ok": True})


@app.errorhandler(400)
@app.errorhandler(403)
@app.errorhandler(404)
@app.errorhandler(409)
@app.errorhandler(502)
def api_error(err):
    return jsonify({"error": getattr(err, "description", str(err))}), err.code


def main():
    _discovery.start()
    _updater.start()
    port = int(_cfg.get("port", config.DEFAULT_PORT))
    print("Jio %s - '%s' listening on http://0.0.0.0:%d (host mode: %s)" % (
        __version__, _cfg.get("device_name"), port, "on" if _cfg.get("host_mode") else "off"))
    app.run(host="0.0.0.0", port=port, threaded=True)


if __name__ == "__main__":
    main()
