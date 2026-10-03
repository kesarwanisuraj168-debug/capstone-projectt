/* Smart Campus — Frontend Controller */
(function () {
  "use strict";

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const API = "/api";
  const HOURS = Array.from({ length: 13 }, (_, i) => i + 8);

  /* ---------------- State Management ---------------- */
  let currentUser = null;
  let token = localStorage.getItem("campus_token") || null;
  let buildings = [];
  let courses = [];

  /* ---------------- API Helper ---------------- */
  async function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers || {});
    if (token) {
      opts.headers["Authorization"] = "Bearer " + token;
    }
    if (opts.body && typeof opts.body === "object" && !(opts.body instanceof FormData)) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(API + path, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok) {
      const msg = (data && (data.detail || data.message)) || res.statusText;
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    return data;
  }
  window.api = api;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function todayStr() {
    const dt = new Date();
    return dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");
  }

  /* ---------------- CSV Export Helper ---------------- */
  window.exportTableToCSV = function (tableId, filename) {
    const table = document.getElementById(tableId);
    if (!table) return;
    const rows = Array.from(table.querySelectorAll("tr"));
    if (!rows.length) return;

    const csvContent = rows.map(r => {
      const cols = Array.from(r.querySelectorAll("th, td"));
      return cols.map(c => '"' + c.innerText.replace(/"/g, '""').trim() + '"').join(",");
    }).join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.setAttribute("download", filename || "export.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  /* ---------------- Auth Handling & Screen Gateway ---------------- */
  function showApp() {
    const loginScreen = $("#loginScreen");
    const app = $("#app");
    if (loginScreen) {
      loginScreen.style.setProperty("display", "none", "important");
      loginScreen.classList.add("hidden");
    }
    if (app) {
      app.style.setProperty("display", "flex", "important");
      app.classList.remove("hidden");
    }
    renderAuthBadge();
  }

  function showLoginScreen() {
    const loginScreen = $("#loginScreen");
    const app = $("#app");
    if (app) {
      app.style.setProperty("display", "none", "important");
      app.classList.add("hidden");
    }
    if (loginScreen) {
      loginScreen.style.setProperty("display", "flex", "important");
      loginScreen.classList.remove("hidden");
    }
    renderAuthBadge();
  }

  async function initAuth() {
    if (token) {
      try {
        currentUser = await api("/auth/me");
        showApp();
        try { await loadDashboard(); } catch (e) { /* ignore */ }
      } catch (e) {
        token = null;
        currentUser = null;
        localStorage.removeItem("campus_token");
        showLoginScreen();
      }
    } else {
      showLoginScreen();
    }
  }

  function renderAuthBadge() {
    const badge = $("#userBadge");
    const btn = $("#authBtn");
    if (currentUser) {
      if (badge) {
        badge.textContent = `👤 ${currentUser.username} (${currentUser.role === "admin" ? "Administrator" : "Student/User"})`;
        badge.className = currentUser.role === "admin" ? "badge measured" : "badge imported";
      }
      if (btn) {
        btn.textContent = "Logout";
        btn.onclick = () => {
          token = null;
          currentUser = null;
          localStorage.removeItem("campus_token");
          showLoginScreen();
        };
      }
    } else {
      if (badge) {
        badge.textContent = "Authentication Required";
        badge.className = "badge synthetic";
      }
      if (btn) {
        btn.textContent = "Sign In";
        btn.onclick = () => showLoginScreen();
      }
    }
  }

  // Unified login executor
  async function doLogin(username, password) {
    const msg = $("#loginMsg");
    const submitBtn = $("#loginSubmitBtn");
    if (msg) msg.textContent = "";
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = `<span>Authenticating…</span>`;
    }

    try {
      const res = await api("/auth/login", {
        method: "POST",
        body: { username: (username || "").trim(), password: password || "" }
      });
      token = res.token;
      currentUser = res.user;
      localStorage.setItem("campus_token", token);
      showApp();

      // Load data asynchronously without blocking UI transition
      try {
        await loadBuildings();
        await loadDashboard();
      } catch (err) {
        console.warn("Post-login data refresh:", err);
      }
    } catch (err) {
      if (msg) msg.textContent = err.message || "Invalid username or password. Please try again.";
      showLoginScreen();
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `<span>Sign In to CampusPulse</span><span class="btn-arrow">→</span>`;
      }
    }
  }

  // Login / Register Tabs
  const tabLogin = $("#tabLogin");
  const tabRegister = $("#tabRegister");
  const loginForm = $("#loginForm");
  const regForm = $("#regForm");

  if (tabLogin && tabRegister) {
    tabLogin.addEventListener("click", () => {
      tabLogin.classList.add("active");
      tabRegister.classList.remove("active");
      if (loginForm) loginForm.classList.remove("hidden");
      if (regForm) regForm.classList.add("hidden");
    });

    tabRegister.addEventListener("click", () => {
      tabRegister.classList.add("active");
      tabLogin.classList.remove("active");
      if (regForm) regForm.classList.remove("hidden");
      if (loginForm) loginForm.classList.add("hidden");
    });
  }

  // 1-Click Instant Demo Login
  const fillAdmin = $("#fillAdmin");
  const fillUser = $("#fillUser");
  if (fillAdmin) {
    fillAdmin.addEventListener("click", () => {
      $("#loginUser").value = "admin";
      $("#loginPass").value = "admin123";
      if (tabLogin && !tabLogin.classList.contains("active")) tabLogin.click();
      doLogin("admin", "admin123");
    });
  }
  if (fillUser) {
    fillUser.addEventListener("click", () => {
      $("#loginUser").value = "user";
      $("#loginPass").value = "user123";
      if (tabLogin && !tabLogin.classList.contains("active")) tabLogin.click();
      doLogin("user", "user123");
    });
  }

  // Login Form Submission
  if (loginForm) {
    loginForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const u = $("#loginUser").value;
      const p = $("#loginPass").value;
      doLogin(u, p);
    });
  }

  // Register Form Submission
  if (regForm) {
    regForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = $("#regMsg");
      const submitBtn = $("#regSubmitBtn");
      if (msg) msg.textContent = "";
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<span>Registering Account…</span>`;
      }

      try {
        const res = await api("/auth/register", {
          method: "POST",
          body: {
            username: $("#regUser").value.trim(),
            full_name: $("#regName").value.trim(),
            password: $("#regPass").value
          }
        });
        token = res.token;
        currentUser = res.user;
        localStorage.setItem("campus_token", token);
        showApp();
        try {
          await loadBuildings();
          await loadDashboard();
        } catch (err) {
          console.warn("Post-register data refresh:", err);
        }
      } catch (err) {
        if (msg) msg.textContent = err.message || "Registration failed. Try another username.";
        showLoginScreen();
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = `<span>Create Account &amp; Sign In</span><span class="btn-arrow">→</span>`;
        }
      }
    });
  }

  /* ---------------- Navigation Router ---------------- */
  const titles = {
    dashboard: "Campus Overview Dashboard",
    explorer: "Campus Location Explorer (Spatial 2D)",
    forecast: "Occupancy Forecasting & Confidence Intervals",
    analytics: "Spatiotemporal Analytics & Heatmaps",
    capacity: "Capacity & Room Stress Analysis",
    optimizer: "Capacity Optimization Engine (PuLP MILP)",
    history: "Recommendation Logs & Historical Runs",
    dataset: "Dataset Pipeline & Ingestion Management",
    models: "Forecasting Model Benchmarks & Comparison",
    admin: "Administrative Console & Server Health",
  };

  $$(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      $$(".nav-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const view = btn.dataset.view;
      $$(".view").forEach(v => v.classList.remove("active"));
      const targetView = $("#view-" + view);
      if (targetView) targetView.classList.add("active");
      $("#pageTitle h2").textContent = titles[view] || "Campus Pulse";

      // Trigger lazy view loaders
      if (view === "dashboard") loadDashboard();
      if (view === "explorer") loadSpatialMap();
      if (view === "analytics") loadAnalytics();
      if (view === "capacity") loadCapacityAnalysis();
      if (view === "history") loadHistory();
      if (view === "dataset") loadDatasetView();
      if (view === "models") loadModelBenchmarks();
      if (view === "admin") loadAdminConsole();
    });
  });

  /* ---------------- Canvas Helpers ---------------- */
  function resizeCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    return ctx;
  }

  function drawBars(canvas, items) {
    const { ctx, w, h } = resizeCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    const padL = 40, padR = 12, padT = 12, padB = 40;
    const max = 100;
    const n = items.length;
    const slotW = (w - padL - padR) / n;
    const barW = Math.min(slotW * 0.6, 42);

    ctx.strokeStyle = "#cbd5e1";
    ctx.fillStyle = "#64748b";
    ctx.font = "11px system-ui";
    ctx.fillText("100%", 4, padT + 8);
    ctx.fillText("0%", 10, h - padB);

    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, h - padB);
    ctx.lineTo(w - padR, h - padB);
    ctx.stroke();

    items.forEach((it, i) => {
      const cx = padL + slotW * i + slotW / 2;
      const bh = (Math.min(it.value, 100) / max) * (h - padT - padB);
      ctx.fillStyle = it.color || "#4f8cff";
      if (bh > 0) roundRect(ctx, cx - barW / 2, h - padB - bh, barW, bh, 4).fill();
      ctx.fillStyle = "#1f2a37";
      ctx.textAlign = "center";
      ctx.fillText(it.value + "%", cx, h - padB - bh - 6);
      ctx.fillStyle = "#64748b";
      ctx.fillText(it.label, cx, h - padB + 16);
    });
  }

  function utilColor(u) { return u >= 80 ? "#ef4444" : u >= 50 ? "#f59e0b" : "#10b981"; }
  function utilTag(u) { return u >= 80 ? "high" : u >= 50 ? "med" : "low"; }

  /* ---------------- 1. Dashboard ---------------- */
  async function loadDashboard(reqDate, reqHour) {
    let d;
    const dateVal = reqDate !== undefined ? reqDate : ($("#dashDate")?.value || "");
    const hourVal = reqHour !== undefined ? reqHour : ($("#dashHour")?.value || "");

    const params = [];
    if (dateVal) params.push(`date=${encodeURIComponent(dateVal)}`);
    if (hourVal !== "" && hourVal !== null && hourVal !== undefined) params.push(`hour=${encodeURIComponent(hourVal)}`);
    const qStr = params.length ? `?${params.join("&")}` : "";

    try {
      d = await api(`/dashboard${qStr}`);
    } catch (e) {
      $("#kpiRow").innerHTML = `<div class="kpi"><div class="sub">${esc(e.message)}</div></div>`;
      return;
    }

    if ($("#dashDate")) {
      $("#dashDate").value = d.date;
    }
    if ($("#dashHour")) {
      $("#dashHour").value = String(d.hour);
    }
    if ($("#dashSnapshotNotice")) {
      const ampm = d.hour >= 12 ? (d.hour === 12 ? "12:00 PM (Noon)" : `${d.hour - 12}:00 PM`) : `${d.hour}:00 AM`;
      $("#dashSnapshotNotice").innerHTML = `Active: <strong style="color:#1d4ed8;">${d.date} at ${ampm}</strong>`;
    }
    if ($("#buildBarHint")) {
      const ampm = d.hour >= 12 ? (d.hour === 12 ? "12:00 PM" : `${d.hour - 12}:00 PM`) : `${d.hour}:00 AM`;
      $("#buildBarHint").textContent = `Snapshot at ${ampm} (${String(d.hour).padStart(2, "0")}:00)`;
    }

    const k = d.kpis;
    const kpis = [
      { label: "Recorded Occupancy", value: k.current_occupancy, sub: `${d.date} @${String(d.hour).padStart(2, "0")}:00` },
      { label: "Predicted Occupancy", value: k.predicted_occupancy, sub: `ML Forecast @${String(d.hour).padStart(2, "0")}:00` },
      { label: "Total Campus Capacity", value: k.capacity, sub: "Available Seats" },
      { label: "Campus Utilization", value: k.utilization + "%", sub: "Ratio at this hour" },
      { label: "Overcapacity Alerts", value: k.overcapacity_areas, sub: "Buildings ≥ 80%" },
      { label: "Free Rooms", value: k.available_rooms, sub: `≥ 15 free seats @${String(d.hour).padStart(2, "0")}:00` },
      { label: "Peak Forecast Hour", value: k.peak_hour + ":00", sub: `${k.peak_value} expected` },
    ];
    if (d.latest_data_date) {
      ["anDate", "capDate"].forEach(id => {
        const el = $(`#${id}`);
        if (el && (!el.value || el.value === todayStr())) {
          el.value = d.latest_data_date;
        }
      });
    }

    $("#kpiRow").innerHTML = kpis.map(x => `<div class="kpi"><div class="label">${x.label}</div><div class="value">${x.value}</div><div class="sub">${x.sub}</div></div>`).join("");

    drawBars($("#buildBar"), d.buildings.map(b => ({
      label: b.building, value: b.utilization, color: utilColor(b.utilization)
    })));

    // Plotly Actual vs Predicted Line Chart
    if (window.Plotly && $("#plotlyTrend")) {
      const traceActual = {
        x: d.trend.map(t => `${t.hour}:00`),
        y: d.trend.map(t => t.actual),
        name: "Actual Recorded",
        type: "scatter",
        mode: "lines+markers",
        line: { color: "#64748b", width: 2 }
      };
      const tracePred = {
        x: d.trend.map(t => `${t.hour}:00`),
        y: d.trend.map(t => t.predicted),
        name: "ML Predicted",
        type: "scatter",
        mode: "lines+markers",
        line: { color: "#4f8cff", width: 3 }
      };
      const layout = {
        margin: { l: 40, r: 20, t: 10, b: 35 },
        legend: { orientation: "h", y: 1.15 },
        paper_bgcolor: "transparent",
        plot_bgcolor: "transparent",
        xaxis: { gridcolor: "#e2e8f0" },
        yaxis: { gridcolor: "#e2e8f0" }
      };
      Plotly.newPlot("plotlyTrend", [traceActual, tracePred], layout, { responsive: true, displayModeBar: false });
    }

    $("#freeRooms").innerHTML = `<thead><tr><th>Room</th><th>Building</th><th>Type</th><th>Capacity</th><th>Forecast</th><th>Free Seats</th></tr></thead><tbody>` +
      d.free_rooms.map(f => `<tr><td><b>${esc(f.room)}</b></td><td>${esc(f.building)}</td><td>${esc(f.type)}</td><td>${f.capacity}</td><td>${f.predicted}</td><td><span class="tag low"><b>${f.free}</b></span></td></tr>`).join("") +
      (d.free_rooms.length ? "" : `<tr><td colspan=6>No rooms with 15+ free seats at this slot.</td></tr>`) + "</tbody>";

    const over = d.buildings.filter(b => b.utilization >= 80);
    $("#overcap").innerHTML = over.length ?
      over.map(b => `<div class="tag high" style="margin:4px 6px;padding:6px 12px;font-size:13px">⚠️ <b>${esc(b.building)} — ${esc(b.building_name)}</b>: ${b.utilization}% occupied (${b.predicted_occupancy}/${b.capacity})</div>`).join("") :
      `<p class="hint">✅ Normal campus levels. No buildings currently exceeding 80% stress threshold.</p>`;

    $("#modelChip").textContent = "Model: " + (d.model?.name || "XGBRegressor");
  }

  /* ---------------- 2. Location Explorer (Spatial 2D) ---------------- */
  async function loadSpatialMap() {
    const dt = $("#mapDate").value || todayStr();
    const hr = +$("#mapHour").value || 12;
    try {
      const data = await api(`/analytics/spatial?date=${dt}&hour=${hr}`);
      renderSpatialNodes(data.buildings);
    } catch (e) {
      $("#campusMapContainer").innerHTML = `<p class="err" style="padding:20px">${esc(e.message)}</p>`;
    }
  }

  function renderSpatialNodes(bldgs) {
    const box = $("#campusMapContainer");
    box.innerHTML = "";
    bldgs.forEach(b => {
      const node = document.createElement("div");
      let nodeClass = "node-low";
      if (b.status === "Overcrowded") nodeClass = "node-over";
      else if (b.utilization >= 80) nodeClass = "node-high";
      else if (b.utilization >= 50) nodeClass = "node-med";

      node.className = `map-building-node ${nodeClass}`;
      node.style.left = b.x + "%";
      node.style.top = b.y + "%";
      node.innerHTML = `
        <div class="b-code">${esc(b.code)}</div>
        <div class="b-util">${b.utilization}%</div>
        <div class="b-stat">${esc(b.status)}</div>
      `;
      node.title = `${b.name} (${b.actual_occupancy}/${b.capacity} seats)`;
      node.onclick = () => showBuildingDrawer(b);
      box.appendChild(node);
    });
  }

  function showBuildingDrawer(b) {
    const drawer = $("#buildingDetailDrawer");
    drawer.style.display = "block";
    $("#drawerTitle").textContent = `Building ${b.code} — ${b.name} (${b.room_count} Rooms)`;
    let html = `
      <div class="kpis" style="margin-bottom:12px">
        <div class="kpi"><div class="label">Total Capacity</div><div class="value">${b.capacity}</div></div>
        <div class="kpi"><div class="label">Current Occupancy</div><div class="value">${b.actual_occupancy}</div></div>
        <div class="kpi"><div class="label">Utilization</div><div class="value">${b.utilization}%</div></div>
        <div class="kpi"><div class="label">Status</div><div class="value" style="font-size:16px">${b.status}</div></div>
      </div>
      <h4>Room Inventory:</h4>
      <table><thead><tr><th>Room Code</th><th>Type</th><th>Floor</th><th>Capacity</th></tr></thead><tbody>
    `;
    b.rooms.forEach(r => {
      html += `<tr><td><b>${esc(r.code)}</b></td><td>${esc(r.type)}</td><td>Floor ${r.floor}</td><td>${r.capacity} seats</td></tr>`;
    });
    html += `</tbody></table>`;
    $("#drawerContent").innerHTML = html;
  }

  $("#mapRefresh").addEventListener("click", loadSpatialMap);

  /* ---------------- 3. Forecasting ---------------- */
  async function loadBuildings() {
    if (buildings.length) return buildings;
    buildings = await api("/buildings");
    const opts = buildings.map(b => `<option value="${b.code}">${b.code} — ${esc(b.name)}</option>`).join("");
    $("#fcBuilding").innerHTML = opts;
    $("#anBuilding").innerHTML = `<option value="">All Campus Buildings</option>` + opts;
    $("#capBldgFilter").innerHTML = `<option value="">All Buildings</option>` + opts;
    return buildings;
  }

  $("#fcHour").addEventListener("input", function () {
    $("#fcHourVal").textContent = this.value + ":00";
  });

  $("#fcRun").addEventListener("click", async function () {
    const b = $("#fcBuilding").value;
    const d = $("#fcDate").value;
    const h = +$("#fcHour").value;
    const m = $("#fcModel").value;

    const btn = this; btn.disabled = true; btn.textContent = "Forecasting…";
    const out = $("#fcResult");
    $("#fcPlotlyCard").style.display = "none";

    try {
      const r = await api("/predict", { method: "POST", body: { building: b, date: d, hour: h, model: m } });
      const statusClass = r.status === "Overcrowded" ? "high" : utilTag(r.utilization);
      const interval = r.prediction_interval || { lower: r.predicted_occupancy, upper: r.predicted_occupancy };

      out.innerHTML = `
        <div class="card">
          <div class="table-header-actions">
            <h3>Forecast Result: ${esc(r.building)} (${esc(r.building_name)}) · ${esc(r.date)} @${r.hour}:00</h3>
            <span class="badge ${statusClass}">Status: ${esc(r.status)}</span>
          </div>
          <div class="kpis">
            <div class="kpi"><div class="label">Predicted Occupancy</div><div class="value">${r.predicted_occupancy}</div><div class="sub">Point estimate</div></div>
            <div class="kpi"><div class="label">95% Confidence Band</div><div class="value" style="font-size:18px">${interval.lower} – ${interval.upper}</div><div class="sub">±${interval.margin_of_error || 12} occupants</div></div>
            <div class="kpi"><div class="label">Capacity</div><div class="value">${r.capacity}</div><div class="sub">Total building seats</div></div>
            <div class="kpi"><div class="label">Utilization</div><div class="value ${statusClass}">${r.utilization}%</div><div class="sub">${esc(r.status)}</div></div>
            <div class="kpi"><div class="label">Weather &amp; Context</div><div class="value" style="font-size:16px">${esc(r.context.weather)}</div><div class="sub">${r.context.temperature}°C · Sem ${r.context.semester}</div></div>
          </div>
          <h4>Room-by-Room Breakdown:</h4>
          <table><thead><tr><th>Room Code</th><th>Type</th><th>Capacity</th><th>Predicted</th><th>Utilization</th></tr></thead><tbody>
          ${(r.rooms || []).map(rm => `<tr><td><b>${esc(rm.room)}</b></td><td>${esc(rm.type)}</td><td>${rm.capacity}</td><td>${rm.predicted}</td><td><span class="tag ${utilTag(rm.utilization)}">${rm.utilization}%</span></td></tr>`).join("")}
          </tbody></table>
        </div>
      `;
    } catch (e) {
      out.innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`;
    } finally {
      btn.disabled = false; btn.textContent = "Generate Forecast";
    }
  });

  $("#fcDay").addEventListener("click", async function () {
    const b = $("#fcBuilding").value;
    const d = $("#fcDate").value;
    const out = $("#fcResult");

    try {
      const r = await api(`/predict/day?building=${encodeURIComponent(b)}&date=${encodeURIComponent(d)}`);
      $("#fcPlotlyCard").style.display = "block";
      const hours = r.curve.map(c => `${c.hour}:00`);
      const vals = r.curve.map(c => c.predicted);

      const trace = {
        x: hours,
        y: vals,
        type: "scatter",
        mode: "lines+markers",
        name: `Building ${r.building}`,
        fill: "tozeroy",
        fillcolor: "rgba(79, 140, 255, 0.12)",
        line: { color: "#4f8cff", width: 3 }
      };

      const layout = {
        title: `Full Operating Day Curve: ${r.building} (${r.date})`,
        margin: { l: 40, r: 20, t: 40, b: 35 },
        paper_bgcolor: "transparent",
        plot_bgcolor: "transparent",
        xaxis: { title: "Time of Day", gridcolor: "#e2e8f0" },
        yaxis: { title: "Predicted Occupancy", gridcolor: "#e2e8f0" }
      };

      Plotly.newPlot("fcPlotlyDiv", [trace], layout, { responsive: true });
      if (!out.innerHTML.trim() || out.innerHTML.includes("Day curve")) {
        out.innerHTML = `<div class="tag low" style="margin-bottom:12px">✅ Operating day curve generated below. Peak expected: <b>${Math.max(...vals)} occupants</b>.</div>`;
      }
      $("#fcPlotlyCard").scrollIntoView({ behavior: "smooth" });
    } catch (e) {
      out.innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`;
    }
  });

  /* ---------------- 4. Spatiotemporal Analytics ---------------- */
  async function loadAnalytics() {
    const b = $("#anBuilding").value;
    const dt = $("#anDate").value || todayStr();

    // 1. DOW Heatmap
    try {
      const dowData = await api(`/analytics/heatmap/dow-hour` + (b ? `?building=${encodeURIComponent(b)}` : ""));
      const traceDOW = {
        z: dowData.matrix,
        x: dowData.hours,
        y: dowData.days,
        type: "heatmap",
        colorscale: "Viridis",
        hoverongaps: false
      };
      const layoutDOW = {
        margin: { l: 80, r: 20, t: 10, b: 40 },
        paper_bgcolor: "transparent",
        xaxis: { title: "Operating Hours" },
        yaxis: { title: "Day of Week" }
      };
      Plotly.newPlot("heatmapDOW", [traceDOW], layoutDOW, { responsive: true });
    } catch (e) {
      $("#heatmapDOW").innerHTML = `<p class="err">${esc(e.message)}</p>`;
    }

    // 2. Building Heatmap
    try {
      const bldgData = await api(`/analytics/heatmap/building-time?date=${encodeURIComponent(dt)}` + (b ? `&building=${encodeURIComponent(b)}` : ""));
      const traceBldg = {
        z: bldgData.matrix,
        x: bldgData.hours,
        y: bldgData.buildings,
        type: "heatmap",
        colorscale: "Plasma",
        colorbar: { title: "% Util" },
        hoverongaps: false
      };
      const layoutBldg = {
        margin: { l: b ? 120 : 180, r: 20, t: 10, b: 40 },
        paper_bgcolor: "transparent",
        xaxis: { title: "Operating Hours" },
        yaxis: { automargin: true }
      };
      Plotly.newPlot("heatmapBuilding", [traceBldg], layoutBldg, { responsive: true });

      const bldgHint = $("#heatmapBuilding")?.parentElement?.querySelector(".hint");
      if (bldgHint) {
        bldgHint.textContent = (bldgData.level === "room"
          ? `Room-level spatial intensity for Building ${esc(bldgData.building || b)}`
          : "Comparative spatial intensity across operating hours") +
          (bldgData.is_predicted ? " · (ML Forecasted)" : " · (Actual Records)");
      }
    } catch (e) {
      $("#heatmapBuilding").innerHTML = `<p class="err">${esc(e.message)}</p>`;
    }

    // 3. Historical vs Predicted
    try {
      const hData = await api(`/analytics/historical-vs-predicted?building=${encodeURIComponent(b || "A")}&days=14`);
      const traceAct = {
        x: hData.series.map(s => s.date),
        y: hData.series.map(s => s.actual_person_hours),
        name: "Actual Recorded",
        type: "scatter",
        mode: "lines+markers",
        line: { color: "#64748b", width: 2 }
      };
      const tracePred = {
        x: hData.series.map(s => s.date),
        y: hData.series.map(s => s.predicted_person_hours),
        name: "Forecasted",
        type: "scatter",
        mode: "lines+markers",
        line: { color: "#4f8cff", width: 2, dash: "dot" }
      };
      const layoutH = {
        margin: { l: 50, r: 20, t: 10, b: 40 },
        paper_bgcolor: "transparent",
        plot_bgcolor: "transparent",
        xaxis: { gridcolor: "#e2e8f0" },
        yaxis: { title: "Total Person-Hours", gridcolor: "#e2e8f0" }
      };
      Plotly.newPlot("histVsPredChart", [traceAct, tracePred], layoutH, { responsive: true });
    } catch (e) {
      $("#histVsPredChart").innerHTML = `<p class="err">${esc(e.message)}</p>`;
    }
  }

  $("#anRefresh").addEventListener("click", loadAnalytics);

  /* ---------------- 5. Capacity Analysis ---------------- */
  async function loadCapacityAnalysis() {
    const b = $("#capBldgFilter").value;
    const dt = $("#capDate").value || todayStr();
    try {
      const res = await api(`/analytics/room-comparison?date=${encodeURIComponent(dt)}` + (b ? `&building=${encodeURIComponent(b)}` : ""));
      const tbody = $("#capTable tbody");
      tbody.innerHTML = res.rooms.map(r => `
        <tr>
          <td><b>${esc(r.room)}</b></td>
          <td>${esc(r.building)} (${esc(r.building_name)})</td>
          <td>${esc(r.type)}</td>
          <td>Floor ${r.floor}</td>
          <td>${r.capacity}</td>
          <td>${r.avg_occupancy}</td>
          <td>${r.peak_occupancy}</td>
          <td>${r.utilization}%</td>
          <td><span class="tag ${utilTag(r.utilization)}">${esc(r.status)}</span></td>
        </tr>
      `).join("");
    } catch (e) {
      $("#capTable tbody").innerHTML = `<tr><td colspan=9 class="err">${esc(e.message)}</td></tr>`;
    }
  }

  $("#capRefresh").addEventListener("click", loadCapacityAnalysis);

  /* ---------------- 6. Capacity Optimizer (MILP) ---------------- */
  async function loadCourses() {
    if (courses.length) return courses;
    try { courses = await api("/optimize/courses"); } catch (e) { courses = []; }
    return courses;
  }

  function reqRow(course, students) {
    const tr = document.createElement("tr");
    const courseOptions = '<option value="">Select course / custom</option>' +
      courses.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join("");
    tr.innerHTML = `
      <td><select class="r-course">${courseOptions}</select></td>
      <td><input class="r-students" type="number" min="1" value="${students || 30}"></td>
      <td>
        <select class="r-equip" multiple size="3" style="width:130px">
          <option value="computers">computers</option>
          <option value="projector">projector</option>
          <option value="whiteboard">whiteboard</option>
          <option value="sound_system">sound_system</option>
          <option value="lab_equipment">lab_equipment</option>
        </select>
      </td>
      <td>
        <select class="r-pref">
          <option value="">Any Building</option>
          ${(buildings || []).map(b => `<option value="${b.code}">${b.code} — ${esc(b.name)}</option>`).join("")}
        </select>
      </td>
      <td><button class="btn ghost r-del">&times;</button></td>
    `;
    $("#reqTable tbody").appendChild(tr);
    if (course) tr.querySelector(".r-course").value = course;
    tr.querySelector(".r-del").addEventListener("click", () => tr.remove());
  }

  $("#optAdd").addEventListener("click", () => reqRow("", 30));

  $("#optRun").addEventListener("click", async function () {
    const rows = $$("#reqTable tbody tr");
    const requests = rows.map(tr => {
      const eq = Array.from(tr.querySelector(".r-equip").selectedOptions).map(o => o.value);
      return {
        course: tr.querySelector(".r-course").value || "Course Request",
        students: Math.max(1, parseInt(tr.querySelector(".r-students").value, 10) || 1),
        equipment: eq,
        preferred_building: tr.querySelector(".r-pref").value || null,
      };
    });
    if (!requests.length) { alert("Please add at least one class request."); return; }

    const body = { date: $("#optDate").value, hour: +$("#optHour").value, requests, save: true };
    const out = $("#optResult");
    out.innerHTML = `<div class="card"><p>Solving Mixed-Integer Linear Program (CBC/PuLP)…</p></div>`;

    try {
      const r = await api("/optimize", { method: "POST", body });
      const s = r.summary;
      out.innerHTML = `
        <div class="card">
          <div class="table-header-actions">
            <h3>Allocation Results — ${s.date} @${s.hour}:00 (${s.solver})</h3>
            <span class="badge ${s.unmet > 0 ? "synthetic" : "imported"}">${s.accommodated}/${s.total_requests} Accommodated</span>
          </div>
          <div class="kpis">
            <div class="kpi"><div class="label">Accommodated</div><div class="value">${s.accommodated}/${s.total_requests}</div></div>
            <div class="kpi"><div class="label">New Assignments</div><div class="value">${s.new}</div></div>
            <div class="kpi"><div class="label">Moved</div><div class="value">${s.moved}</div></div>
            <div class="kpi"><div class="label">Unmet Requests</div><div class="value" style="color:var(--red)">${s.unmet}</div></div>
            <div class="kpi"><div class="label">Solve Time</div><div class="value" style="font-size:16px">${s.solve_time_s}s</div></div>
          </div>
          <table>
            <thead>
              <tr><th>Course</th><th>Students</th><th>Assigned Room</th><th>Building</th><th>Status</th><th>Capacity</th><th>Free Seats</th><th>Equipment OK</th><th>Reason / Constraints</th></tr>
            </thead>
            <tbody>
              ${r.results.map(x => `
                <tr>
                  <td><b>${esc(x.course)}</b></td>
                  <td>${x.students}</td>
                  <td>${x.recommended_room ? `<b>${esc(x.recommended_room)}</b>` : "—"}</td>
                  <td>${esc(x.recommended_building || "—")}</td>
                  <td><span class="tag ${x.status === 'no feasible room' ? 'high' : 'low'}">${esc(x.status)}</span></td>
                  <td>${x.capacity || "—"}</td>
                  <td>${x.free_seats != null ? x.free_seats : "—"}</td>
                  <td>${x.equipment_ok ? "✓" : "✗"}</td>
                  <td class="hint">${esc(x.reason || "")}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      `;
    } catch (e) {
      out.innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`;
    }
  });

  /* ---------------- 7. History & Logs ---------------- */
  async function loadHistory() {
    try {
      const recs = await api("/recommendations?limit=25");
      $("#recList").innerHTML = recs.length ? `
        <table id="recListTable">
          <thead><tr><th>#ID</th><th>Date</th><th>Slot</th><th>Requests</th><th>Accommodated</th><th>Moved</th><th>Unmet</th><th>Timestamp</th></tr></thead>
          <tbody>
            ${recs.map(r => `
              <tr>
                <td>#${r.id}</td><td>${esc(r.date)}</td><td>${r.hour}:00</td>
                <td>${r.summary?.total_requests || "-"}</td>
                <td>${r.summary?.accommodated || "-"}</td>
                <td>${r.summary?.moved || "-"}</td>
                <td>${r.summary?.unmet || "-"}</td>
                <td>${esc(r.created_at ? r.created_at.slice(0, 16).replace("T", " ") : "-")}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      ` : `<p class="hint">No past recommendation runs found.</p>`;
    } catch (e) { $("#recList").innerHTML = `<p class="err">${esc(e.message)}</p>`; }

    try {
      const preds = await api("/predictions?limit=25");
      $("#predList").innerHTML = preds.length ? `
        <table id="predListTable">
          <thead><tr><th>#ID</th><th>Date</th><th>Hour</th><th>Building</th><th>Predicted Occupancy</th><th>Model</th><th>Recorded At</th></tr></thead>
          <tbody>
            ${preds.map(p => `
              <tr>
                <td>#${p.id}</td><td>${esc(p.date)}</td><td>${p.hour}:00</td>
                <td><b>${esc(p.building || "—")}</b></td>
                <td>${p.predicted_occupancy}</td>
                <td><span class="badge synthetic">${esc(p.model)}</span></td>
                <td>${esc(p.created_at ? p.created_at.slice(0, 16).replace("T", " ") : "-")}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      ` : `<p class="hint">No prediction logs found.</p>`;
    } catch (e) { $("#predList").innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  }

  /* ---------------- 8. Dataset Management ---------------- */
  async function loadDatasetView() {
    try {
      const summary = await api("/dataset/summary");
      $("#datasetSummaryBox").innerHTML = `
        <div class="kpis" style="margin-bottom:0">
          <div class="kpi"><div class="label">Total Records</div><div class="value">${summary.total_records.toLocaleString()}</div></div>
          <div class="kpi"><div class="label">Synthetic Data</div><div class="value">${(summary.origins.synthetic || 0).toLocaleString()}</div><div class="sub">Demonstration</div></div>
          <div class="kpi"><div class="label">Imported Logs</div><div class="value">${(summary.origins.imported || 0).toLocaleString()}</div><div class="sub">User CSV/Excel</div></div>
          <div class="kpi"><div class="label">Measured Feeds</div><div class="value">${(summary.origins.measured || 0).toLocaleString()}</div><div class="sub">Sensor Stream</div></div>
        </div>
        <p class="hint" style="margin-top:10px">${esc(summary.description)}</p>
      `;
    } catch (e) {
      $("#datasetSummaryBox").innerHTML = `<p class="err">${esc(e.message)}</p>`;
    }

    // Populate simulation room dropdown
    if (buildings.length) {
      const allRooms = [];
      buildings.forEach(b => {
        allRooms.push(`${b.code}-101`, `${b.code}-102`, `${b.code}-Lab1`);
      });
      $("#simRoomSelect").innerHTML = Array.from(new Set(allRooms)).map(r => `<option value="${r}">${r}</option>`).join("");
    }

    // Load preview table
    try {
      const rows = await api("/dataset/preview?limit=50");
      $("#previewTable tbody").innerHTML = rows.map(r => `
        <tr>
          <td>${r.id}</td><td>${r.date}</td><td>${r.hour}:00</td>
          <td><b>${esc(r.room)}</b></td><td>${esc(r.building)}</td>
          <td>${r.occupancy}</td><td>${r.capacity}</td>
          <td>${r.utilization}%</td>
          <td><span class="badge ${r.data_origin}">${esc(r.data_origin)}</span></td>
        </tr>
      `).join("");
    } catch (e) {
      $("#previewTable tbody").innerHTML = `<tr><td colspan=9 class="err">${esc(e.message)}</td></tr>`;
    }
  }

  // Upload handler
  $("#uploadForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    const fileInput = $("#uploadFile");
    if (!fileInput.files.length) return;
    const file = fileInput.files[0];

    const formData = new FormData();
    formData.append("file", file);
    formData.append("origin", $("#uploadOrigin").value);
    formData.append("replace_duplicates", $("#uploadReplace").checked ? "true" : "false");

    const feedback = $("#uploadFeedback");
    const submitBtn = $("#uploadSubmit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Ingesting File…";
    feedback.innerHTML = `<p class="hint">Parsing and validating dataset…</p>`;

    try {
      const res = await api("/dataset/upload", { method: "POST", body: formData });
      feedback.innerHTML = `
        <div class="disclaimer-banner" style="background:#f0fdf4">
          <div>
            <b>${esc(res.message)}</b><br>
            Rows Processed: ${res.total_rows} · Inserted: ${res.inserted} · Updated: ${res.updated} · Skipped: ${res.skipped}
          </div>
        </div>
      `;
      loadDatasetView();
    } catch (err) {
      feedback.innerHTML = `<p class="err">${esc(err.message)}</p>`;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Upload & Ingest";
    }
  });

  // Sensor Simulation trigger
  $("#simSubmit").addEventListener("click", async function () {
    const room = $("#simRoomSelect").value;
    const count = +$("#simCount").value;
    const fb = $("#simFeedback");
    try {
      const res = await api(`/dataset/simulate-stream?room_code=${encodeURIComponent(room)}&occupancy_count=${count}`, { method: "POST" });
      fb.innerHTML = `
        <div class="tag low" style="margin-top:8px">
          📡 Stream Packet Received: Room ${esc(res.room)} observed count set to <b>${res.recorded_occupancy}</b> (${res.date} @${res.hour}:00). Mode: <em>${res.mode}</em>.
        </div>
      `;
      loadDatasetView();
    } catch (e) {
      fb.innerHTML = `<p class="err">${esc(e.message)}</p>`;
    }
  });

  // Synthetic Dataset Generator trigger
  $("#btnGenSynth").addEventListener("click", async function () {
    const start = $("#synthStart").value;
    const end = $("#synthEnd").value;
    const scenario = $("#synthScenario").value;
    const noise = $("#synthNoise").value;
    const fb = $("#synthFeedback");
    const btn = this;

    if (!start || !end) {
      fb.innerHTML = `<p class="err">Please select valid start and end dates.</p>`;
      return;
    }

    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Generating Synthetic Data…`;
    fb.innerHTML = `<p class="hint">Synthesizing realistic diurnal curves, course schedules, and noise patterns…</p>`;

    try {
      const url = `/dataset/generate-synthetic?start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}&scenario=${encodeURIComponent(scenario)}&noise_level=${encodeURIComponent(noise)}&seed_db=true`;
      const res = await api(url, { method: "POST" });
      fb.innerHTML = `
        <div class="disclaimer-banner" style="background:#eff6ff;border-color:#93c5fd">
          <div>
            <b>✅ ${esc(res.message)}</b><br>
            Time Span: ${esc(res.start_date)} to ${esc(res.end_date)} · Scenario: <b>${esc(res.scenario.toUpperCase())}</b> · Rooms: ${res.rooms_covered} · Origin: <code>synthetic</code>
          </div>
        </div>
      `;
      loadDatasetView();
    } catch (e) {
      fb.innerHTML = `<p class="err">${esc(e.message)}</p>`;
    } finally {
      btn.disabled = false;
      btn.innerHTML = `⚡ Generate &amp; Seed Database`;
    }
  });

  // Synthetic CSV Download trigger
  $("#btnDownloadSynth").addEventListener("click", function () {
    const start = $("#synthStart").value || "2026-09-01";
    const end = $("#synthEnd").value || "2026-09-24";
    const scenario = $("#synthScenario").value || "normal";
    const noise = $("#synthNoise").value || "0.08";
    window.location.href = `/api/dataset/download-synthetic?start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}&scenario=${encodeURIComponent(scenario)}&noise_level=${encodeURIComponent(noise)}`;
  });


  /* ---------------- 9. Model Performance ---------------- */
  async function loadModelBenchmarks() {
    try {
      const res = await api("/model/compare");
      const tbody = $("#modelCompareTable tbody");
      tbody.innerHTML = res.models.map(m => `
        <tr>
          <td><b>${esc(m.model)}</b> ${m.model.includes("XGB") || m.model.includes("LightGBM") ? '<span class="badge synthetic">Recommended</span>' : ''}</td>
          <td>${typeof m.MAE === 'number' ? m.MAE.toFixed(2) : m.MAE}</td>
          <td>${typeof m.RMSE === 'number' ? m.RMSE.toFixed(2) : m.RMSE}</td>
          <td>${m.MAPE}</td>
          <td><b>${typeof m.R2 === 'number' ? m.R2.toFixed(4) : m.R2}</b></td>
          <td>${m.training_time_s}s</td>
          <td><span class="tag low">${esc(m.status)}</span></td>
        </tr>
      `).join("");
    } catch (e) {
      $("#modelCompareTable tbody").innerHTML = `<tr><td colspan=7 class="err">${esc(e.message)}</td></tr>`;
    }
  }

  $("#btnRetrain").addEventListener("click", async function () {
    if (!currentUser || currentUser.role !== "admin") {
      alert("Admin authorization required to trigger model retraining. Please sign in as admin (admin/admin123).");
      showLoginScreen();
      return;
    }
    const btn = this;
    const status = $("#retrainStatus");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Retraining Pipeline…`;
    status.innerHTML = `<p class="hint">Executing chronological feature generation & training baseline models…</p>`;

    try {
      const res = await api("/model/retrain", { method: "POST" });
      status.innerHTML = `<div class="tag low">✅ ${esc(res.message)}</div>`;
      loadModelBenchmarks();
    } catch (e) {
      status.innerHTML = `<p class="err">${esc(e.message)}</p>`;
    } finally {
      btn.disabled = false;
      btn.innerHTML = `⚡ Retrain Models (Admin)`;
    }
  });

  /* ---------------- 10. Admin Console ---------------- */
  async function loadAdminConsole() {
    try {
      const health = await api("/health");
      const datasetSummary = await api("/dataset/summary");
      $("#adminSummary").innerHTML = `
        <div class="kpis">
          <div class="kpi"><div class="label">API Engine</div><div class="value" style="color:var(--green)">Online</div><div class="sub">FastAPI 0.116</div></div>
          <div class="kpi"><div class="label">Loaded Forecaster</div><div class="value" style="font-size:18px">${esc(health.model || "XGBoost")}</div><div class="sub">Active ML Engine</div></div>
          <div class="kpi"><div class="label">Total DB Records</div><div class="value">${datasetSummary.total_records.toLocaleString()}</div><div class="sub">SQLite Database</div></div>
          <div class="kpi"><div class="label">Campus Rooms</div><div class="value">${datasetSummary.coverage.rooms}</div><div class="sub">Across ${datasetSummary.coverage.buildings} Buildings</div></div>
        </div>
      `;

      $("#adminHealthBox").innerHTML = `
        <table style="margin-top:10px">
          <tr><th>Endpoint</th><th>Status</th></tr>
          <tr><td>Swagger Interactive Docs</td><td><a href="/docs" target="_blank">/docs</a></td></tr>
          <tr><td>Model Health Check</td><td><a href="/api/health" target="_blank">/api/health</a></td></tr>
          <tr><td>Dataset Summary API</td><td><a href="/api/dataset/summary" target="_blank">/api/dataset/summary</a></td></tr>
          <tr><td>Algorithm Comparison API</td><td><a href="/api/model/compare" target="_blank">/api/model/compare</a></td></tr>
        </table>
      `;
    } catch (e) {
      $("#adminSummary").innerHTML = `<p class="err">${esc(e.message)}</p>`;
    }
  }

  /* ---------------- App Initialization ---------------- */
  document.addEventListener("DOMContentLoaded", async function () {
    // Fill hours select dropdowns
    const hourOpts = HOURS.map(h => `<option value="${h}" ${h === 12 ? "selected" : ""}>${String(h).padStart(2, "0")}:00</option>`).join("");
    const all24Opts = Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === 12 ? "selected" : ""}>${String(h).padStart(2, "0")}:00 ${h < 8 || h > 20 ? "(closed)" : ""}</option>`).join("");

    // Fill hours select dropdowns for explorer & optimizer
    $("#mapHour").innerHTML = hourOpts;
    $("#optHour").innerHTML = all24Opts;

    // Set default dates to today
    const def = todayStr();
    ["fcDate", "mapDate", "optDate", "anDate", "capDate"].forEach(id => {
      const el = $(`#${id}`);
      if (el) { el.value = def; }
    });

    // Dashboard Interactive Controls
    if ($("#dashRefresh")) {
      $("#dashRefresh").addEventListener("click", () => {
        loadDashboard($("#dashDate")?.value, $("#dashHour")?.value);
      });
    }
    if ($("#dashDate")) {
      $("#dashDate").addEventListener("change", () => {
        loadDashboard($("#dashDate").value, $("#dashHour")?.value);
      });
    }
    if ($("#dashHour")) {
      $("#dashHour").addEventListener("change", () => {
        loadDashboard($("#dashDate")?.value, $("#dashHour").value);
      });
    }
    if ($("#dashReset")) {
      $("#dashReset").addEventListener("click", () => {
        if ($("#dashHour")) $("#dashHour").value = "12";
        loadDashboard(null, 12);
      });
    }

    await initAuth();
    try { await loadBuildings(); } catch (e) { /* offline */ }
    try { await loadCourses(); } catch (e) { /* offline */ }

    // Seed 2 default rows in optimizer table
    reqRow("CS301 - Data Structures", 35);
    reqRow("AI & ML", 40);

    // Initial Auth Check (loads Dashboard only if authenticated)
    await initAuth();
  });

})();