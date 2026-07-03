/* ..::JiO::.. frontend logic. hand-crafted, no frameworks, just like 1999. */

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

function fmtDate(ts) {
  var d = new Date(ts * 1000);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString();
}

function esc(text) {
  var div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/* ============ views ============ */

function showView(name) {
  ["files", "peers", "settings"].forEach(function (v) {
    $("view-" + v).style.display = v === name ? "" : "none";
  });
  document.querySelectorAll(".orbbtn").forEach(function (btn) {
    btn.classList.toggle("active", btn.dataset.view === name);
  });
  if (name === "peers") loadPeers();
  if (name === "settings") loadSettings();
}

document.querySelectorAll(".orbbtn").forEach(function (btn) {
  btn.addEventListener("click", function (ev) {
    ev.preventDefault();
    showView(btn.dataset.view);
  });
});

/* ============ status ============ */

function loadStatus() {
  api("/api/status").then(function (st) {
    $("led").classList.add("on");
    $("device-name").textContent = st.name;
    $("mode-tag").textContent = st.host_mode ? "[HOST MODE]" : "[node]";
  }).catch(function () {
    $("led").classList.remove("on");
    $("device-name").textContent = "offline?!";
  });
}

/* ============ drives ============ */

function loadDrives() {
  api("/api/drives").then(function (body) {
    state.drives = body.drives;
    var box = $("drive-list");
    box.innerHTML = "";
    if (!body.drives.length) {
      box.innerHTML = '<span class="blink">no drives found :(</span>';
      return;
    }
    body.drives.forEach(function (drive) {
      var btn = document.createElement("button");
      btn.className = "drive" + (state.drive === drive.id ? " selected" : "");
      var pct = drive.total ? Math.round((drive.used / drive.total) * 100) : 0;
      btn.innerHTML =
        '<span class="drive-label">' + (drive.kind === "internal" ? "&#128190; " : "&#128191; ") + esc(drive.label) + "</span>" +
        (drive.remote ? ' <span class="drive-remote">@' + esc(drive.device) + "</span>" : "") +
        '<div class="drive-meter"><div class="drive-meter-fill" style="width:' + pct + '%"></div></div>' +
        '<span class="drive-space">' + fmtSize(drive.free) + " free of " + fmtSize(drive.total) + "</span>";
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
    $("drive-list").innerHTML = '<span class="c-yellow">error: ' + esc(err.message) + "</span>";
  });
}

/* ============ files ============ */

function crumbs() {
  var drive = state.drives.find(function (d) { return d.id === state.drive; });
  var label = drive ? drive.label : state.drive;
  return "C:\\" + label + (state.path ? "\\" + state.path.split("/").join("\\") : "") + "\\";
}

function loadFiles() {
  if (!state.drive) return;
  $("crumbs").textContent = crumbs();
  api("/api/list?drive=" + encodeURIComponent(state.drive) + "&path=" + encodeURIComponent(state.path))
    .then(function (body) {
      var rows = $("file-rows");
      rows.innerHTML = "";
      if (!body.entries.length) {
        rows.innerHTML = '<tr><td colspan="4" class="empty-msg">&lt;&lt; this folder is totally empty &gt;&gt;</td></tr>';
        return;
      }
      body.entries.forEach(function (entry) {
        var tr = document.createElement("tr");
        var icon = entry.is_dir ? "&#128193;" : "&#128196;";
        var nameCls = "entry-name" + (entry.is_dir ? " entry-dir" : "");
        tr.innerHTML =
          '<td><span class="' + nameCls + '">' + icon + " " + esc(entry.name) + "</span></td>" +
          "<td>" + (entry.is_dir ? "&lt;DIR&gt;" : fmtSize(entry.size)) + "</td>" +
          "<td>" + fmtDate(entry.mtime) + "</td>" +
          "<td>" +
          (entry.is_dir ? "" : '<button class="rowbtn" data-act="dl">get</button>') +
          '<button class="rowbtn" data-act="mv">ren</button>' +
          '<button class="rowbtn" data-act="del">del</button>' +
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
      $("file-rows").innerHTML = '<tr><td colspan="4" class="empty-msg">error: ' + esc(err.message) + "</td></tr>";
    });
}

function joinPath(base, name) {
  return base ? base + "/" + name : name;
}

function download(name) {
  var url = "/api/download?drive=" + encodeURIComponent(state.drive) +
    "&path=" + encodeURIComponent(joinPath(state.path, name));
  window.location.href = url;
}

function remove(name) {
  if (!confirm("R U SURE u want to delete '" + name + "'??? this cannot be undone!!")) return;
  api("/api/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ drive: state.drive, path: joinPath(state.path, name) }),
  }).then(function () { loadFiles(); loadDrives(); }).catch(alertErr);
}

function rename(name) {
  var next = prompt("new name for '" + name + "':", name);
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
  alert("!!! ERROR !!!\n\n" + err.message);
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
  if (!state.drive) return alert("pick a drive first!!");
  var name = prompt("name 4 ur new folder:");
  if (!name) return;
  api("/api/mkdir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ drive: state.drive, path: joinPath(state.path, name) }),
  }).then(loadFiles).catch(alertErr);
});

$("btn-upload").addEventListener("click", function () {
  if (!state.drive) return alert("pick a drive first!!");
  $("file-input").click();
});

$("file-input").addEventListener("change", function () {
  var files = Array.prototype.slice.call($("file-input").files);
  if (!files.length) return;
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

/* ============ peers ============ */

function loadPeers() {
  api("/api/status").then(function (st) {
    var box = $("peer-list");
    if (!st.peers.length) {
      box.innerHTML = '<div class="peer"><span class="blink">*</span> no other jio machines found on ur LAN... yet. ' +
        "fire up jio on another computer and it will show up here automagically!</div>";
      return;
    }
    box.innerHTML = "";
    st.peers.forEach(function (peer) {
      var div = document.createElement("div");
      div.className = "peer";
      div.innerHTML =
        '<div class="peer-name">&#128225; ' + esc(peer.name) + "</div>" +
        "<div>addr ..... " + esc(peer.ip) + ":" + peer.port + "</div>" +
        "<div>mode ..... " + (peer.host_mode ? "HOST" : "node") + "</div>" +
        "<div>status ... <span class='c-green'>ONLINE</span></div>";
      box.appendChild(div);
    });
  });
}

/* ============ settings ============ */

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
    $("save-msg").textContent = "SAVED!! ur settings r locked in B)";
    setTimeout(function () { $("save-msg").textContent = ""; }, 4000);
    loadStatus();
    loadDrives();
  }).catch(alertErr);
});

/* ============ hit counter (100% authentic fake) ============ */

var hits = parseInt(localStorage.getItem("jio-hits") || "31337", 10) + 1;
localStorage.setItem("jio-hits", String(hits));
$("counter").textContent = String(hits).padStart(6, "0");

/* ============ boot ============ */

loadStatus();
loadDrives();
showView("files");
setInterval(loadStatus, 10000);
