/* JIO storage console frontend. Plain JS, no frameworks. */

var state = {
  drive: null,
  path: "",
  drives: [],
};

function $(id) { return document.getElementById(id); }

function api(url, opts) {
  return fetch(url, opts).then(function (resp) {
    return resp.json().then(function (body) {
      if (!resp.ok) throw new Error(body.error || ("HTTP " + resp.status));
      return body;
    });
  });
}

function fmtSize(bytes) {
  if (bytes === 0) return "0 B";
  var units = ["B", "KB", "MB", "GB", "TB"];
  var i = Math.floor(Math.log(bytes) / Math.log(1024));
  i = Math.min(i, units.length - 1);
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + " " + units[i];
}

function pad2(n) { return String(n).padStart(2, "0"); }

function fmtDate(ts) {
  var d = new Date(ts * 1000);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
    " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

function esc(text) {
  var div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function sysmsg(text) {
  $("sysmsg").textContent = text.toUpperCase();
}

/* ============ views ============ */

function showView(name) {
  ["files", "peers", "settings"].forEach(function (v) {
    $("view-" + v).style.display = v === name ? "" : "none";
  });
  document.querySelectorAll(".modekey").forEach(function (btn) {
    btn.classList.toggle("active", btn.dataset.view === name);
  });
  if (name === "peers") loadPeers();
  if (name === "settings") { loadSettings(); loadUpdateStatus(); }
}

document.querySelectorAll(".modekey").forEach(function (btn) {
  btn.addEventListener("click", function () {
    showView(btn.dataset.view);
  });
});

/* ============ status ============ */

function loadStatus() {
  api("/api/status").then(function (st) {
    $("led").classList.add("on");
    $("link-state").textContent = "OK";
    $("device-name").textContent = st.name.toUpperCase();
    $("mode-tag").textContent = st.host_mode ? "HOST" : "NODE";
    $("tele-version").textContent = st.version;
    $("tele-peers").textContent = st.peers.length;
  }).catch(function () {
    $("led").classList.remove("on");
    $("link-state").textContent = "DOWN";
  });
}

function tickClock() {
  var d = new Date();
  $("tele-clock").textContent = pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

/* ============ volumes ============ */

function meterHtml(used, total) {
  var segments = 12;
  var lit = total ? Math.round((used / total) * segments) : 0;
  var hot = total && used / total > 0.9;
  var html = '<div class="drive-meter">';
  for (var i = 0; i < segments; i++) {
    html += "<i" + (i < lit ? ' class="lit' + (hot ? " hot" : "") + '"' : "") + "></i>";
  }
  return html + "</div>";
}

function loadDrives() {
  api("/api/drives").then(function (body) {
    state.drives = body.drives;
    $("tele-drives").textContent = body.drives.length;
    var box = $("drive-list");
    box.innerHTML = "";
    if (!body.drives.length) {
      box.innerHTML = '<div class="dim">NO VOLUMES DETECTED</div>';
      return;
    }
    body.drives.forEach(function (drive) {
      var btn = document.createElement("button");
      btn.className = "drive" + (state.drive === drive.id ? " selected" : "");
      btn.innerHTML =
        '<span class="drive-label">' + esc(drive.label.toUpperCase()) + "</span>" +
        (drive.remote ? '<span class="drive-remote">REMOTE &middot; ' + esc(drive.device.toUpperCase()) + "</span>" : "") +
        meterHtml(drive.used, drive.total) +
        '<span class="drive-space">' + fmtSize(drive.free) + " FREE / " + fmtSize(drive.total) + "</span>";
      btn.addEventListener("click", function () {
        state.drive = drive.id;
        state.path = "";
        showView("files");
        loadDrives();
        loadFiles();
      });
      box.appendChild(btn);
    });
  }).catch(function (err) {
    $("drive-list").innerHTML = '<div class="dim">ERROR: ' + esc(err.message) + "</div>";
  });
}

/* ============ files ============ */

function crumbs() {
  var drive = state.drives.find(function (d) { return d.id === state.drive; });
  var label = drive ? drive.label : state.drive;
  return "/" + label.toUpperCase().replace(/ /g, "_") + (state.path ? "/" + state.path : "");
}

function loadFiles() {
  if (!state.drive) return;
  $("crumbs").textContent = crumbs();
  sysmsg("reading " + crumbs());
  api("/api/list?drive=" + encodeURIComponent(state.drive) + "&path=" + encodeURIComponent(state.path))
    .then(function (body) {
      var rows = $("file-rows");
      rows.innerHTML = "";
      sysmsg(crumbs() + " // " + body.entries.length + " item(s)");
      if (!body.entries.length) {
        rows.innerHTML = '<tr><td colspan="4" class="empty-msg">DIRECTORY EMPTY</td></tr>';
        return;
      }
      body.entries.forEach(function (entry) {
        var tr = document.createElement("tr");
        var glyph = entry.is_dir ? "&#9654;" : "&#9642;";
        var nameCls = "entry-name" + (entry.is_dir ? " entry-dir" : "");
        tr.innerHTML =
          '<td><span class="' + nameCls + '"><span class="glyph">' + glyph + "</span>" + esc(entry.name) + "</span></td>" +
          "<td>" + (entry.is_dir ? "DIR" : fmtSize(entry.size)) + "</td>" +
          "<td>" + fmtDate(entry.mtime) + "</td>" +
          "<td>" +
          (entry.is_dir ? "" : '<button class="rowbtn" data-act="dl">GET</button>') +
          '<button class="rowbtn" data-act="mv">REN</button>' +
          '<button class="rowbtn" data-act="del">DEL</button>' +
          "</td>";
        tr.querySelector(".entry-name").addEventListener("click", function () {
          if (entry.is_dir) {
            state.path = joinPath(state.path, entry.name);
            loadFiles();
          } else {
            download(entry.name);
          }
        });
        tr.querySelectorAll(".rowbtn").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var act = btn.dataset.act;
            if (act === "dl") download(entry.name);
            if (act === "del") remove(entry.name);
            if (act === "mv") rename(entry.name);
          });
        });
        rows.appendChild(tr);
      });
    })
    .catch(function (err) {
      $("file-rows").innerHTML = '<tr><td colspan="4" class="empty-msg">ERROR: ' + esc(err.message) + "</td></tr>";
    });
}

function joinPath(base, name) {
  return base ? base + "/" + name : name;
}

function download(name) {
  sysmsg("transmitting " + name);
  window.location.href = "/api/download?drive=" + encodeURIComponent(state.drive) +
    "&path=" + encodeURIComponent(joinPath(state.path, name));
}

function remove(name) {
  if (!confirm("DELETE '" + name + "'?\nThis operation is irreversible.")) return;
  api("/api/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ drive: state.drive, path: joinPath(state.path, name) }),
  }).then(function () { loadFiles(); loadDrives(); }).catch(alertErr);
}

function rename(name) {
  var next = prompt("New designation for '" + name + "':", name);
  if (!next || next === name) return;
  api("/api/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      drive: state.drive,
      path: joinPath(state.path, name),
      dest: joinPath(state.path, next),
    }),
  }).then(loadFiles).catch(alertErr);
}

function alertErr(err) {
  sysmsg("fault // " + err.message);
  alert("FAULT: " + err.message);
}

$("btn-up").addEventListener("click", function () {
  if (!state.path) return;
  var parts = state.path.split("/");
  parts.pop();
  state.path = parts.join("/");
  loadFiles();
});

$("btn-refresh").addEventListener("click", function () { loadFiles(); loadDrives(); });

$("btn-newfolder").addEventListener("click", function () {
  if (!state.drive) return alert("Select a volume first.");
  var name = prompt("New directory name:");
  if (!name) return;
  api("/api/mkdir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ drive: state.drive, path: joinPath(state.path, name) }),
  }).then(loadFiles).catch(alertErr);
});

$("btn-upload").addEventListener("click", function () {
  if (!state.drive) return alert("Select a volume first.");
  $("file-input").click();
});

$("file-input").addEventListener("change", function () {
  var files = Array.prototype.slice.call($("file-input").files);
  if (!files.length) return;
  sysmsg("receiving " + files.length + " file(s)");
  var done = 0;
  files.forEach(function (file) {
    var form = new FormData();
    form.append("drive", state.drive);
    form.append("path", state.path);
    form.append("file", file);
    fetch("/api/upload", { method: "POST", body: form })
      .then(function (resp) {
        if (!resp.ok) return resp.json().then(function (b) { throw new Error(b.error || "upload failed"); });
      })
      .catch(alertErr)
      .finally(function () {
        done += 1;
        if (done === files.length) { loadFiles(); loadDrives(); }
      });
  });
  $("file-input").value = "";
});

/* ============ network ============ */

function loadPeers() {
  api("/api/status").then(function (st) {
    var box = $("peer-list");
    if (!st.peers.length) {
      box.innerHTML = '<div class="dim">NO REMOTE UNITS ON BROADCAST CHANNEL. ' +
        "START JIO ON ANOTHER MACHINE AND IT WILL REGISTER HERE.</div>";
      return;
    }
    box.innerHTML = "";
    st.peers.forEach(function (peer) {
      var div = document.createElement("div");
      div.className = "peer";
      div.innerHTML =
        '<div class="peer-name">' + esc(peer.name.toUpperCase()) + "</div>" +
        '<div class="peer-row"><span>ADDR</span><span>' + esc(peer.ip) + ":" + peer.port + "</span></div>" +
        '<div class="peer-row"><span>MODE</span><span>' + (peer.host_mode ? "HOST" : "NODE") + "</span></div>" +
        '<div class="peer-row"><span>STATE</span><span class="peer-online">ONLINE</span></div>';
      box.appendChild(div);
    });
  });
}

/* ============ config ============ */

function loadSettings() {
  api("/api/settings").then(function (st) {
    $("set-name").value = st.device_name || "";
    $("set-host").checked = !!st.host_mode;
    $("set-extra").value = (st.extra_paths || []).join("\n");
  });
}

$("btn-save").addEventListener("click", function () {
  var extra = $("set-extra").value.split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
  api("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_name: $("set-name").value,
      host_mode: $("set-host").checked,
      extra_paths: extra,
    }),
  }).then(function () {
    $("save-msg").textContent = "PARAMETERS COMMITTED";
    setTimeout(function () { $("save-msg").textContent = ""; }, 4000);
    loadStatus();
    loadDrives();
  }).catch(alertErr);
});

/* ============ self-update ============ */

var UPDATE_MESSAGES = {
  update_checking: "CHECKING GITHUB FOR UPDATES",
  update_available: "UPDATE AVAILABLE",
  update_none: "SOFTWARE UP TO DATE",
  update_downloading: "PULLING UPDATE FROM GITHUB",
  update_installing: "INSTALLING DEPENDENCIES",
  update_restarting: "RESTARTING SYSTEM",
  update_error: "UPDATE FAILED",
};

var banner = $("update-banner");

function showBanner(text, cls, hideAfter) {
  banner.textContent = text;
  banner.className = "show" + (cls ? " " + cls : "");
  if (hideAfter) {
    setTimeout(function () {
      if (banner.textContent === text) banner.className = "";
    }, hideAfter);
  }
}

function setUpdateLamp(pending) {
  var lamp = document.querySelector('.modekey[data-view="settings"] .modekey-lamp');
  if (lamp) lamp.classList.toggle("pending", !!pending);
}

function handleUpdateEvent(msg) {
  var text = UPDATE_MESSAGES[msg.type];
  if (!text) return;
  if (msg.type === "update_error") {
    showBanner(text + ": " + (msg.message || "unknown error").toUpperCase(), "danger", 8000);
    return;
  }
  if (msg.type === "update_none") {
    showBanner(text, "ok", 3000);
    setUpdateLamp(false);
    return;
  }
  if (msg.type === "update_available") {
    showBanner(text + " (" + (msg.sha || "").toUpperCase() + ")", "", 6000);
    setUpdateLamp(true);
    return;
  }
  showBanner(text, "");
  if (msg.type === "update_restarting") waitForRestart();
}

function waitForRestart() {
  var tries = 0;
  var poll = setInterval(function () {
    tries += 1;
    fetch("/api/status").then(function (r) {
      if (!r.ok) throw new Error();
      return r.json();
    }).then(function () {
      clearInterval(poll);
      showBanner("UPDATE COMPLETE // RELOADING", "ok");
      setTimeout(function () { window.location.reload(); }, 1200);
    }).catch(function () {
      if (tries > 150) clearInterval(poll); // ~5 min ceiling
    });
  }, 2000);
}

function connectUpdateChannel() {
  var source = new EventSource("/api/events");
  source.onmessage = function (ev) {
    try {
      handleUpdateEvent(JSON.parse(ev.data));
    } catch (e) { /* ignore malformed event */ }
  };
}

function loadUpdateStatus() {
  return api("/api/update/status").then(function (st) {
    $("upd-current").textContent = st.current ? st.current.slice(0, 8).toUpperCase() : "N/A";
    $("upd-latest").textContent = st.latest ? st.latest.slice(0, 8).toUpperCase() : "-------";
    $("upd-status").textContent = st.error ? "ERROR" : (st.update_available ? "UPDATE AVAILABLE" : "UP TO DATE");
    $("upd-checked").textContent = st.last_checked ? fmtDate(st.last_checked) : "NEVER";
    $("set-autoupdate").checked = !!st.auto_update;
    $("btn-apply-update").disabled = !st.enabled;
    setUpdateLamp(st.update_available);
    return st;
  }).catch(function (err) {
    $("upd-status").textContent = "ERROR: " + err.message.toUpperCase();
  });
}

$("btn-check-update").addEventListener("click", function () {
  sysmsg("checking github for updates");
  api("/api/update/check", { method: "POST" }).then(loadUpdateStatus).catch(alertErr);
});

$("btn-apply-update").addEventListener("click", function () {
  if (!confirm("Install the latest update now?\nThe system will restart when finished.")) return;
  api("/api/update/apply", { method: "POST" }).catch(alertErr);
});

$("set-autoupdate").addEventListener("change", function () {
  api("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ auto_update: $("set-autoupdate").checked }),
  }).catch(alertErr);
});

/* ============ boot ============ */

loadStatus();
loadDrives();
showView("files");
tickClock();
connectUpdateChannel();
loadUpdateStatus();
setInterval(tickClock, 1000);
setInterval(loadStatus, 10000);
setInterval(loadUpdateStatus, 60000);
