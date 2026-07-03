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
  check the **the.network** tab.

### Host mode

Flip on **host mode** in settings and that instance becomes the hub: it
merges every drive from every Jio machine on your network into one big
drive list. Files on remote drives are proxied through the host, so you
manage the whole house's storage from a single page.

## Install on a Raspberry Pi (Raspberry Pi OS)

```bash
git clone https://github.com/WHCreativeDesign/Jio.git
cd Jio
sudo bash deploy/install.sh
```

That installs Jio to `/opt/jio`, sets up a Python virtualenv, and enables a
systemd service (`jio@<user>`) that starts on boot. When it finishes it
prints the URL to open.

## Run from source (any Linux/macOS)

```bash
python3 -m venv venv
venv/bin/pip install -r requirements.txt
venv/bin/python -m jio
```

Then open `http://localhost:8420`.

## Configuration

Config lives at `~/.config/jio/config.json` (override with the
`JIO_CONFIG` env var) and is editable from the **set.tings** tab:

| key             | meaning                                             | default        |
|-----------------|-----------------------------------------------------|----------------|
| `device_name`   | name shown to other Jio instances                   | hostname       |
| `port`          | web UI / API port                                   | `8420`         |
| `host_mode`     | aggregate drives from all LAN peers into one view   | `false`        |
| `extra_paths`   | extra folders to expose as drives                   | `[]`           |
| `internal_root` | what "Internal Storage" points at                   | home directory |

## API

Everything the UI does goes through a small JSON API: `/api/status`,
`/api/drives`, `/api/list`, `/api/download`, `/api/upload`, `/api/mkdir`,
`/api/move`, `/api/delete`, `/api/settings`.

## Security note

Jio has **no authentication** — it trusts your LAN. Keep it on your home
network; don't port-forward it to the internet.
