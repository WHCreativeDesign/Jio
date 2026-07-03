"""Drive detection and safe path resolution.

A "drive" is any storage root Jio exposes: the internal storage of the
device, external drives mounted under /media, /mnt or /run/media, and any
extra paths listed in the config. Every drive gets a stable id derived from
its mount point, and every file operation resolves paths *inside* a drive so
requests can never escape onto the rest of the filesystem.
"""

import os
import re

# Filesystems that represent real storage (as opposed to proc, tmpfs, etc.)
REAL_FS_TYPES = {
    "ext2", "ext3", "ext4", "vfat", "exfat", "ntfs", "ntfs3", "fuseblk",
    "btrfs", "xfs", "f2fs", "hfsplus", "iso9660", "udf",
}

EXTERNAL_MOUNT_PREFIXES = ("/media/", "/mnt/", "/run/media/")


def _slug(text):
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return slug or "drive"


def _usage(path):
    try:
        st = os.statvfs(path)
        total = st.f_blocks * st.f_frsize
        free = st.f_bavail * st.f_frsize
        return total, total - free, free
    except OSError:
        return 0, 0, 0


def _mounts():
    """Yield (mountpoint, fstype) from /proc/mounts."""
    try:
        with open("/proc/mounts", "r", encoding="utf-8") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) < 3:
                    continue
                # Mount points encode spaces as \040
                mountpoint = parts[1].replace("\\040", " ")
                yield mountpoint, parts[2]
    except OSError:
        return


def list_drives(cfg):
    """Return the list of drives this instance exposes."""
    drives = []
    seen_paths = set()

    def add(drive_id, label, path, kind):
        real = os.path.realpath(path)
        if real in seen_paths or not os.path.isdir(real):
            return
        seen_paths.add(real)
        total, used, free = _usage(real)
        drives.append({
            "id": drive_id,
            "label": label,
            "path": real,
            "kind": kind,  # internal | external | extra
            "total": total,
            "used": used,
            "free": free,
        })

    add("internal", "Internal Storage", cfg.get("internal_root") or os.path.expanduser("~"), "internal")

    for mountpoint, fstype in _mounts():
        if fstype not in REAL_FS_TYPES:
            continue
        if not mountpoint.startswith(EXTERNAL_MOUNT_PREFIXES):
            continue
        label = os.path.basename(mountpoint.rstrip("/")) or mountpoint
        add("ext-" + _slug(mountpoint), label, mountpoint, "external")

    for extra in cfg.get("extra_paths", []):
        path = os.path.expanduser(str(extra))
        label = os.path.basename(path.rstrip("/")) or path
        add("extra-" + _slug(path), label, path, "extra")

    return drives


def find_drive(cfg, drive_id):
    for drive in list_drives(cfg):
        if drive["id"] == drive_id:
            return drive
    return None


def resolve(drive, rel_path):
    """Resolve rel_path inside a drive, refusing anything that escapes it.

    Returns the absolute path, or raises ValueError.
    """
    root = drive["path"]
    rel = (rel_path or "").strip("/")
    candidate = os.path.realpath(os.path.join(root, rel))
    if candidate != root and not candidate.startswith(root + os.sep):
        raise ValueError("path escapes drive root")
    return candidate
