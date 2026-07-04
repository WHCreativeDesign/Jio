# Jio

**Jio** is a lightweight home NAS you run on a Raspberry Pi (or any Linux
box). It turns the Pi's internal storage and any plugged-in USB drives into
network storage that everyone in the house can browse from a web page —
upload, download, rename, delete, make folders. No client software needed;
the only install is on the Pi.

The web UI is styled as a retro-futuristic storage console — amber
phosphor, instrument panels, and telemetry readouts — and works on
phones as well as desktops.

## How it works

- Jio runs a small web server (port **8420** by default) and serves a file
  manager UI at `http://<pi-ip>:8420`.
- It automatically detects **internal storage** plus any drives mounted
  under `/media`, `/mnt`, or `/run/media` (USB sticks, external HDDs).
  You can also share arbitrary folders via *extra paths* in settings.
- Every Jio instance announces itself on the LAN via UDP broadcast
  (port **8421**), so instances discover each other automatically —
  check the **NETWORK** tab.

### Host mode

Flip on **host mode** in settings and that instance becomes the hub: it
merges every drive from every Jio machine on your network into one big
drive list. Files on remote drives are proxied through the host, so you
manage the whole house's storage from a single page.

### Self-update

Jio can update itself. On a schedule (default: every 30 minutes) it runs
`git ls-remote` against its own `origin` remote to see if the tracked
branch has moved. If it has:

1. It broadcasts live status ("checking", "downloading", "restarting", ...)
   to every open browser tab over Server-Sent Events, shown as a banner
   across the top of the page.
2. It `git fetch`s and hard-resets to the new commit, reinstalls
   `requirements.txt` if needed, then restarts itself in place
   (`os.execv`) — same process, same port, no systemd restart needed.

This only works when Jio is deployed as a git checkout (which is what
`deploy/install.sh` sets up). From the **CONFIG** tab you can check for
updates on demand, install one immediately, or turn on **auto-update** to
install new commits automatically as they land on the tracked branch.
Because it hard-resets the checkout, don't hand-edit files under
`/opt/jio` — config lives separately in `~/.config/jio/config.json`.

## Install on a Raspberry Pi (Raspberry Pi OS)

```bash
curl -fsSL https://raw.githubusercontent.com/WHCreativeDesign/Jio/main/deploy/install.sh | sudo bash
```

Or clone first and run it locally:

```bash
git clone https://github.com/WHCreativeDesign/Jio.git
cd Jio
sudo bash deploy/install.sh
```

The installer clones Jio to `/opt/jio` (as a real git checkout, so
self-update works), sets up a Python virtualenv, and enables a systemd
service (`jio@<user>`) that starts on boot. When it finishes it prints the
URL to open. Running it again later re-syncs `/opt/jio` to the latest
commit on `main`.

## Run from source (any Linux/macOS)

```bash
python3 -m venv venv
venv/bin/pip install -r requirements.txt
venv/bin/python -m jio
```

Then open `http://localhost:8420`.

## Configuration

Config lives at `~/.config/jio/config.json` (override with the
`JIO_CONFIG` env var) and is editable from the **CONFIG** tab:

| key                     | meaning                                             | default        |
|-------------------------|------------------------------------------------------|----------------|
| `device_name`           | name shown to other Jio instances                   | hostname       |
| `port`                  | web UI / API port                                   | `8420`         |
| `host_mode`             | aggregate drives from all LAN peers into one view   | `false`        |
| `extra_paths`           | extra folders to expose as drives                   | `[]`           |
| `internal_root`         | what "Internal Storage" points at                   | home directory |
| `auto_update`           | install updates automatically when found            | `false`        |
| `update_branch`         | git branch to track for updates                     | `main`         |
| `update_check_interval` | seconds between update checks (min `300`)           | `1800`         |

## API

Everything the UI does goes through a small JSON API: `/api/status`,
`/api/drives`, `/api/list`, `/api/download`, `/api/upload`, `/api/mkdir`,
`/api/move`, `/api/delete`, `/api/settings`, `/api/update/status`,
`/api/update/check`, `/api/update/apply`, and `/api/events` (the
Server-Sent Events stream used for live update status).

## Security note

Jio has **no authentication** — it trusts your LAN. Keep it on your home
network; don't port-forward it to the internet.
