import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Auth from "./Auth";
import { api, apiUrl, authHeaders, CREDENTIALS } from "./api";
import { DEPARTMENTS } from "./departments";
import Icon from "./components/Icon";
import logo from "./assets/ethin-mark.png";
import Ring from "./components/Ring";

const STATUSES = ["Open", "Queued", "In Progress", "Resolved"];
const PRIORITIES = ["Low", "Medium", "High", "Critical"];
const CATEGORIES = ["Hardware", "Software", "Network", "Account Access", "Other"];
const ASSET_STATUSES = ["Available", "Assigned", "Under Repair", "Retired"];
const ASSET_TYPES = ["Laptop", "Mouse", "Keyboard", "Charger"];
const slug = (v) => String(v || "").toLowerCase().replace(/\s+/g, "-");
// Placeholder / test addresses are not real mailboxes.
const realEmail = (email) => Boolean(email) && !/@(example|test|invalid|localhost)(\.[a-z]+)?$/i.test(String(email).trim());
const emptyAsset = { employeeName: "", employeeId: "", department: "", items: [] };
const emptyProfile = { name: "", employeeId: "", email: "", department: "" };

// Centre-crop an image/video frame to a small square JPEG so it stays light.
function toSquareJpeg(source, width, height, mirror = false, size = 256) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const side = Math.min(width, height);
  if (mirror) {
    ctx.translate(size, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(source, (width - side) / 2, (height - side) / 2, side, side, 0, 0, size, size);
  return canvas.toDataURL("image/jpeg", 0.85);
}

function timeAgo(value) {
  const diff = (Date.now() - new Date(value).getTime()) / 1000;
  if (!Number.isFinite(diff)) return "";
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + " min ago";
  if (diff < 86400) return Math.floor(diff / 3600) + " h ago";
  return new Date(value).toLocaleDateString();
}

function App({ user, onUserChange, onLogout }) {
  const [tickets, setTickets] = useState([]),
    [view, setView] = useState("overview"),
    [department, setDepartment] = useState(null),
    [deptTickets, setDeptTickets] = useState([]),
    [deptStats, setDeptStats] = useState([]),
    [search, setSearch] = useState(""),
    [priority, setPriority] = useState("All"),
    [status, setStatus] = useState("All"),
    [category, setCategory] = useState("All"),
    [selected, setSelected] = useState(null),
    [notice, setNotice] = useState(""),
    [notifications, setNotifications] = useState([]),
    [bellOpen, setBellOpen] = useState(false),
    [assets, setAssets] = useState([]),
    [employees, setEmployees] = useState([]),
    [settings, setSettings] = useState({ system_name: "IT Support Portal", notification_email_enabled: "false" }),
    [assetDraft, setAssetDraft] = useState(emptyAsset),
    [assetSearch, setAssetSearch] = useState(""),
    [assetFormOpen, setAssetFormOpen] = useState(false),
    [profiles, setProfiles] = useState([]),
    [profileDraft, setProfileDraft] = useState(emptyProfile),
    [fading, setFading] = useState([]),
    [live, setLive] = useState(false);
  // Always holds the latest notifications so timers/streams can read them.
  const notificationsRef = useRef([]);
  notificationsRef.current = notifications;

  // A resolved issue no longer needs attention: fade its notification out,
  // then remove it. The unread count ignores fading items straight away.
  function dismissResolved(ticketIds) {
    const ids = notificationsRef.current.filter((n) => ticketIds.includes(n.ticket_id)).map((n) => n.id);
    if (!ids.length) return;
    setFading((previous) => [...new Set([...previous, ...ids])]);
    setTimeout(() => {
      setNotifications((previous) => previous.filter((n) => !ids.includes(n.id)));
      setFading((previous) => previous.filter((id) => !ids.includes(id)));
    }, 450);
  }

  // Tickets (and department data) refresh every 5 seconds.
  useEffect(() => {
    let active = true;
    const refresh = () =>
      Promise.all([
        api("/tickets"),
        view === "departments" ? api("/admin/departments") : null,
        // Department tickets are filtered by the server, not in the browser.
        view === "departments" && department ? api("/tickets?department=" + encodeURIComponent(department)) : null,
      ])
        .then(([data, stats, byDept]) => {
          if (!active) return;
          setTickets(data);
          // Safety net: if the live event was missed, resolved tickets still clear their notifications.
          dismissResolved(data.filter((t) => t.status === "Resolved").map((t) => t.id));
          if (stats) setDeptStats(stats);
          setDeptTickets(byDept || []);
          setSelected((previous) => (previous ? data.find((t) => t.id === previous.id) || null : null));
        })
        .catch((e) => active && setNotice(e.message));
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [view, department]);

  // Live notifications: server-sent events with automatic reconnect, plus a
  // periodic re-sync so nothing is missed if the stream is interrupted
  // (serverless hosting closes long requests after about a minute).
  useEffect(() => {
    let active = true;
    let controller = null;
    let retry = null;
    let attempt = 0;
    const sync = () => api("/admin/notifications").then((rows) => active && setNotifications(rows)).catch(() => {});
    sync();
    const poll = setInterval(sync, 30000);
    async function connect() {
      controller = new AbortController();
      try {
        const response = await fetch(apiUrl("/admin/events"), {
          credentials: CREDENTIALS,
          headers: authHeaders(),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error("stream unavailable");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (active) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() || "";
          for (const chunk of chunks) {
            if (chunk.startsWith("event: ready")) {
              attempt = 0;
              setLive(true);
              sync();
              continue;
            }
            if (chunk.startsWith("event: resolved")) {
              const resolvedLine = chunk.split("\n").find((line) => line.startsWith("data: "));
              if (resolvedLine && active) dismissResolved([JSON.parse(resolvedLine.slice(6)).ticketId]);
              continue;
            }
            if (!chunk.startsWith("event: ticket")) continue;
            const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
            if (!dataLine) continue;
            const event = JSON.parse(dataLine.slice(6));
            if (!active) continue;
            setNotifications((previous) =>
              previous.some((n) => n.id === event.id)
                ? previous
                : [
                    { id: event.id, ticket_id: event.ticketId, employee_name: event.employeeName, ticket_title: event.title, created_at: event.submittedAt, read_at: null },
                    ...previous,
                  ],
            );
            setNotice(`New ticket ${event.ticketId} submitted by ${event.employeeName}.`);
          }
        }
      } catch (error) {
        if (error.name === "AbortError") return;
      }
      if (!active) return;
      setLive(false);
      attempt += 1;
      retry = setTimeout(connect, Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)));
    }
    connect();
    return () => {
      active = false;
      clearInterval(poll);
      clearTimeout(retry);
      controller?.abort();
    };
  }, []);

  useEffect(() => {
    if (view === "assets") {
      api("/admin/assets").then(setAssets).catch((e) => setNotice(e.message));
      api("/admin/employee-profiles").then(setProfiles).catch(() => {});
    }
    if (view === "employeeCreate") api("/admin/employee-profiles").then(setProfiles).catch((e) => setNotice(e.message));
    if (view === "employees") api("/admin/employees").then(setEmployees).catch((e) => setNotice(e.message));
    if (view === "settings") api("/admin/settings").then(setSettings).catch((e) => setNotice(e.message));
    if (view === "notifications") api("/admin/notifications").then(setNotifications).catch((e) => setNotice(e.message));
  }, [view]);

  async function createAsset(e) {
    e.preventDefault();
    try {
      const { assets: created } = await api("/admin/assets", { method: "POST", body: JSON.stringify(assetDraft) });
      setAssets((previous) => [...created, ...previous]);
      setAssetDraft(emptyAsset);
      setAssetFormOpen(false);
      setNotice(`${created.map((a) => a.name).join(", ")} assigned to ${assetDraft.employeeName.trim()}.`);
    } catch (error) {
      setNotice(error.message);
    }
  }
  function changeAssetEmployeeId(value) {
    // A known Employee ID fills in the name and department automatically.
    const match = profiles.find((p) => p.employee_id === value.trim().toUpperCase());
    setAssetDraft((draft) => ({ ...draft, employeeId: value, ...(match ? { employeeName: match.name, department: match.department } : {}) }));
  }
  const toggleAssetItem = (item) =>
    setAssetDraft((draft) => ({ ...draft, items: draft.items.includes(item) ? draft.items.filter((x) => x !== item) : [...draft.items, item] }));
  async function createProfile(e) {
    e.preventDefault();
    try {
      const { profile, invitation } = await api("/admin/employee-profiles", { method: "POST", body: JSON.stringify(profileDraft) });
      setProfiles((previous) => [profile, ...previous]);
      setProfileDraft(emptyProfile);
      setNotice(`Employee profile created for ${profile.name} (${profile.employee_id}). ` + (invitation?.sent === false ? `The invitation email could not be sent: ${invitation.message} Use Resend invite once email is working.` : `Invitation email sent to ${profile.email}.`));
    } catch (error) {
      setNotice(error.message);
    }
  }
  async function resendInvite(id) {
    try {
      const { profile, message } = await api(`/admin/employee-profiles/${id}/resend-invite`, { method: "POST" });
      setProfiles((previous) => previous.map((p) => (p.id === id ? profile : p)));
      setNotice(message);
    } catch (error) {
      setNotice(error.message);
    }
  }
  async function updateAsset(id, changes) {
    try {
      const { asset } = await api("/admin/assets/" + id, { method: "PATCH", body: JSON.stringify(changes) });
      setAssets((previous) => previous.map((item) => (item.id === id ? asset : item)));
    } catch (error) {
      setNotice(error.message);
    }
  }
  async function deleteAsset(id) {
    if (!window.confirm("Delete this asset record?")) return;
    try {
      await api("/admin/assets/" + id, { method: "DELETE" });
      setAssets((previous) => previous.filter((item) => item.id !== id));
    } catch (error) {
      setNotice(error.message);
    }
  }
  async function saveSettings(e) {
    e.preventDefault();
    try {
      await api("/admin/settings", { method: "PUT", body: JSON.stringify(settings) });
      setNotice("Settings saved.");
    } catch (error) {
      setNotice(error.message);
    }
  }
  // Opening a notification marks that one as read, so the count drops by one.
  function markNotificationRead(id) {
    setNotifications((previous) => previous.map((n) => (n.id === id && !n.read_at ? { ...n, read_at: new Date().toISOString() } : n)));
    api(`/admin/notifications/${id}/read`, { method: "PATCH" }).catch((error) => {
      setNotice(error.message);
      api("/admin/notifications").then(setNotifications).catch(() => {});
    });
  }
  async function markNotificationsRead() {
    try {
      await api("/admin/notifications/read", { method: "PATCH" });
      setNotifications((previous) => previous.map((item) => ({ ...item, read_at: item.read_at || new Date().toISOString() })));
    } catch (error) {
      setNotice(error.message);
    }
  }

  const matches = (t) =>
    (status === "All" || t.status === status) &&
    (priority === "All" || t.priority === priority) &&
    (category === "All" || t.category === category) &&
    [t.id, t.name, t.email, t.employeeId, t.title, t.category, t.description].some((v) =>
      String(v || "").toLowerCase().includes(search.toLowerCase()),
    );
  const shown = useMemo(
    () => tickets.filter(matches),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tickets, status, priority, category, search],
  );
  const deptShown = deptTickets.filter(matches);
  const shownAssets = assets.filter((a) =>
    [a.name, a.asset_tag, a.category, a.assigned_to, a.employee_name, a.employee_id, a.department, a.status].some((v) =>
      String(v || "").toLowerCase().includes(assetSearch.trim().toLowerCase()),
    ),
  );
  const unread = notifications.filter((n) => !n.read_at && !fading.includes(n.id)).length;

  function applyTicket(ticket) {
    const swap = (prev) => prev.map((t) => (t.id === ticket.id ? ticket : t));
    setTickets(swap);
    // A ticket moved to another department leaves the current department list.
    setDeptTickets((prev) => swap(prev).filter((t) => t.department === department));
    setSelected((prev) => (prev?.id === ticket.id ? ticket : prev));
  }
  // Updates the ticket in place: the status is replaced, no extra history
  // entries or repeated notices are created.
  async function update(id, changes) {
    try {
      const { ticket, changed } = await api("/tickets/" + id, { method: "PATCH", body: JSON.stringify(changes) });
      applyTicket(ticket);
      if (changed && ticket.status === "Resolved") dismissResolved([ticket.id]);
      if (changed && view === "departments") api("/admin/departments").then(setDeptStats).catch(() => {});
      if (changed)
        setNotice(changes.department !== undefined ? `${id} moved to ${ticket.department}.` : `${id} is now ${ticket.status}.`);
    } catch (e) {
      setNotice(e.message);
    }
  }
  async function sendMessage(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const message = new FormData(form).get("message");
    try {
      const { ticket } = await api("/tickets/" + selected.id + "/messages", { method: "POST", body: JSON.stringify({ message }) });
      applyTicket(ticket);
      form.reset();
      setNotice("Message sent to employee.");
    } catch (err) {
      setNotice(err.message);
    }
  }
  function openTicketFromNotification(item) {
    setBellOpen(false);
    if (!item.read_at) markNotificationRead(item.id);
    const found = tickets.find((ticket) => ticket.id === item.ticket_id);
    if (found) setSelected(found);
    else go("overview");
  }

  const count = (s) => tickets.filter((t) => t.status === s).length;
  const go = (next) => {
    setView(next);
    setDepartment(null);
    setNotice("");
  };
  // Plain render helper (not a component) so buttons are not remounted each render.
  const navItem = (name, icon, children, badge, hot = false) => (
    <button key={name} className={view === name ? "nav active" : "nav"} onClick={() => go(name)} aria-current={view === name ? "page" : undefined}>
      <Icon name={icon} /> {children}
      {badge !== undefined && <span className={"nav-count" + (hot && badge ? " hot" : "")}>{badge}</span>}
    </button>
  );
  const resetFilters = () => {
    setSearch("");
    setPriority("All");
    setStatus("All");
    setCategory("All");
  };
  const filters = (
    <div className="controls">
      <div className="search">
        <Icon name="search" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search ID, employee, title, email…" aria-label="Search tickets" />
      </div>
      <select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority">
        <option value="All">All priorities</option>
        {PRIORITIES.map((v) => (
          <option key={v}>{v}</option>
        ))}
      </select>
      <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
        <option value="All">All statuses</option>
        {STATUSES.map((v) => (
          <option key={v}>{v}</option>
        ))}
      </select>
      <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
        <option value="All">All categories</option>
        {CATEGORIES.map((v) => (
          <option key={v}>{v}</option>
        ))}
      </select>
      <button className="btn btn-ghost" onClick={resetFilters}>
        <Icon name="refresh" /> Reset
      </button>
    </div>
  );
  const heading = {
    overview: ["Overview", "Ticket management", "Review incoming requests, search issues and update their progress."],
    departments: [
      department ? "Departments / " + department : "Departments",
      department ? department + " tickets" : "Departments",
      department ? "Only tickets raised by this department. Update status or open details to manage them." : "Choose a department to see and manage only its tickets.",
    ],
    profile: ["My profile", "My profile", "Your administrator account details."],
    assets: ["Assets", "Assets management", "Register, assign and track company IT assets."],
    employees: ["Employee profiles", "Employee profiles", "Registered employee accounts and department details."],
    employeeCreate: ["Employee profile creation", "Employee profile creation", "Create an employee profile with a name, Employee ID, email and department. An invitation email is sent automatically."],
    settings: ["Settings", "Settings", "Manage basic support portal preferences."],
    notifications: ["Notifications", "Notifications", "New employee ticket submissions and their details."],
  }[view];

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-logo" src={logo} alt="Ethin" />
          <div>
            <b>Ethin Support</b>
            <small>IT Administration</small>
          </div>
        </div>
        <div className="user-card">
          <span className="avatar">{user.avatar ? <img src={user.avatar} alt="" /> : (user.name || "A").trim().charAt(0).toUpperCase()}</span>
          <div>
            <b>{user.name || "IT Administrator"}</b>
            <small>Administrator · {user.employeeId}</small>
          </div>
        </div>
        <p className="nav-label">Management</p>
        {navItem("overview", "grid", "Ticket overview", tickets.length)}
        {navItem("departments", "building", "Departments")}
        {navItem("profile", "user", "My profile")}
        <p className="nav-label">Admin tools</p>
        {navItem("assets", "laptop", "Assets management")}
        {navItem("employees", "users", "Employee profiles")}
        {navItem("employeeCreate", "userPlus", "Employee profile creation")}
        {navItem("settings", "settings", "Settings")}
        {navItem("notifications", "bell", "Notifications", unread, true)}
        <div className="side-note">
          <b>Support operations</b>
          <span>Review employee requests, inspect attachments and keep ticket status current.</span>
          <button className="btn btn-sm btn-ghost side-signout" onClick={onLogout}>
            <Icon name="logout" /> Sign out
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="crumbs">
            <span>Admin</span>
            <span className="sep">/</span>
            <b>{heading[0]}</b>
          </div>
          <div className="topbar-actions">
            <span className="status-dot">{live ? "Live" : "Connecting…"}</span>
            <NotificationBell
              open={bellOpen}
              setOpen={setBellOpen}
              items={notifications}
              fading={fading}
              unread={unread}
              onOpenItem={openTicketFromNotification}
              onMarkRead={markNotificationsRead}
              onViewAll={() => {
                setBellOpen(false);
                go("notifications");
              }}
            />
            <button className="btn btn-ghost" onClick={onLogout} title="Sign out">
              <Icon name="logout" /> <span>Sign out</span>
            </button>
          </div>
        </header>
        <div className="content">
          <div className="page-head">
            <div>
              <p className="eyebrow">Admin panel</p>
              <h1>{heading[1]}</h1>
              <p>{heading[2]}</p>
            </div>
          </div>
          {notice && (
            <div className="notice" role="status">
              <span><Icon name="checkCircle" /> {notice}</span>
              <button onClick={() => setNotice("")} aria-label="Dismiss">×</button>
            </div>
          )}

          {view === "overview" && (
            <>
              <section className="hero-row">
                <OverviewHero tickets={tickets} unread={unread} onReview={() => setStatus("Open")} />
                <div className="stats two">
                  <Stat label="Open" value={count("Open")} total={tickets.length} icon="inbox" tone="sky" />
                  <Stat label="Queued" value={count("Queued")} total={tickets.length} icon="layers" tone="violet" />
                  <Stat label="In progress" value={count("In Progress")} total={tickets.length} icon="clock" tone="amber" />
                  <Stat label="Resolved" value={count("Resolved")} total={tickets.length} icon="checkCircle" tone="green" />
                </div>
              </section>
              <section className="card">
                <div className="section-head">
                  <div>
                    <h2>All support tickets</h2>
                    <p>Search and filter requests submitted by employees.</p>
                  </div>
                  <span className="chip">{shown.length} of {tickets.length} tickets</span>
                </div>
                {filters}
                {shown.length ? (
                  <TicketTable tickets={shown} onUpdate={update} onSelect={setSelected} />
                ) : (
                  <Empty title="No matching tickets" text="Try changing your search or filters." />
                )}
              </section>
            </>
          )}

          {view === "departments" && (
            <>
              <section className="dept-grid">
                {deptStats.map((d) => (
                  <button
                    key={d.name}
                    className={"dept-card" + (department === d.name ? " active" : "")}
                    onClick={() => {
                      setDepartment(d.name);
                      setDeptTickets([]);
                      setNotice("");
                    }}
                  >
                    <div className="dept-card-top">
                      <p>{d.name}</p>
                      <b>{d.total}</b>
                    </div>
                    <div className="dept-bar" aria-hidden="true">
                      {d.total > 0 &&
                        [
                          [d.open, "var(--sky)"],
                          [d.queued, "var(--violet)"],
                          [d.inProgress, "var(--amber)"],
                          [d.resolved, "var(--green)"],
                        ].map(([n, c], i) => <span key={i} style={{ width: (n / d.total) * 100 + "%", background: c }} />)}
                    </div>
                    <div className="dept-meta">
                      <span><i style={{ background: "var(--sky)" }} />{d.open} open</span>
                      <span><i style={{ background: "var(--violet)" }} />{d.queued} queued</span>
                      <span><i style={{ background: "var(--amber)" }} />{d.inProgress} in progress</span>
                      <span><i style={{ background: "var(--green)" }} />{d.resolved} resolved</span>
                    </div>
                  </button>
                ))}
              </section>
              {department && (
                <section className="card">
                  <div className="section-head">
                    <div>
                      <h2>{department}</h2>
                      <p>Tickets raised by employees in this department.</p>
                    </div>
                    <span className="chip">{deptShown.length} of {deptTickets.length} tickets</span>
                  </div>
                  {filters}
                  {deptShown.length ? (
                    <TicketTable tickets={deptShown} onUpdate={update} onSelect={setSelected} />
                  ) : (
                    <Empty title={`No tickets in ${department}`} text="Tickets appear here as soon as employees raise them." />
                  )}
                </section>
              )}
            </>
          )}

          {view === "notifications" && (
            <section className="card">
              <div className="section-head">
                <div>
                  <h2>Ticket notifications</h2>
                  <p>New employee requests appear here instantly.</p>
                </div>
                <button className="btn" onClick={markNotificationsRead} disabled={!unread}>
                  <Icon name="check" /> Mark all as read
                </button>
              </div>
              {notifications.length ? (
                notifications.map((item) => (
                  <article className={"notification-row" + (!item.read_at ? " unread" : "") + (fading.includes(item.id) ? " fading" : "")} key={item.id}>
                    <div className="meta">
                      <span className="stat-icon"><Icon name="inbox" /></span>
                      <div>
                        <p><b className="ticket-id">{item.ticket_id}</b> · {item.employee_name}</p>
                        <p className="muted">{item.ticket_title}</p>
                        <small>{new Date(item.created_at).toLocaleString()}</small>
                      </div>
                    </div>
                    <button className="btn btn-sm" onClick={() => openTicketFromNotification(item)}>View ticket</button>
                  </article>
                ))
              ) : (
                <Empty icon="bell" title="No notifications yet" text="New ticket submissions will appear here." />
              )}
            </section>
          )}

          {view === "assets" && (
            <section className="card">
              <div className="section-head">
                <div>
                  <h2>Asset register</h2>
                  <p>Add and manage laptops, desktops and other company assets.</p>
                </div>
                <span className="chip">{assets.length} assets</span>
              </div>
              <div className="controls">
                <div className="search">
                  <Icon name="search" />
                  <input value={assetSearch} onChange={(e) => setAssetSearch(e.target.value)} placeholder="Search asset, employee, ID or department…" aria-label="Search assets" />
                </div>
                <button className="btn btn-primary" type="button" onClick={() => setAssetFormOpen(true)}><Icon name="plus" /> Add asset</button>
              </div>
              {shownAssets.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>Asset</th><th>Tag</th><th>Category</th><th>Assigned to</th><th>Status</th><th>Action</th></tr>
                    </thead>
                    <tbody>
                      {shownAssets.map((asset) => (
                        <tr key={asset.id}>
                          <td><b>{asset.name}</b></td>
                          <td className="mono">{asset.asset_tag}</td>
                          <td>{asset.category}</td>
                          <td>
                            {asset.employee_name ? (
                              <>
                                <b>{asset.employee_name}</b>
                                <small>{asset.employee_id} · {asset.department}</small>
                              </>
                            ) : (
                              asset.assigned_to || <span className="muted">Unassigned</span>
                            )}
                          </td>
                          <td>
                            <div className="cell-actions">
                              <span className={"pill asset " + slug(asset.status)}>{asset.status}</span>
                              <select value={asset.status} onChange={(e) => updateAsset(asset.id, { status: e.target.value })} aria-label={`Status for ${asset.name}`}>
                                {ASSET_STATUSES.map((s) => (
                                  <option key={s}>{s}</option>
                                ))}
                              </select>
                            </div>
                          </td>
                          <td><button className="btn btn-sm btn-danger" onClick={() => deleteAsset(asset.id)}>Delete</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  icon="laptop"
                  title={assets.length ? "No matching assets" : "No assets registered"}
                  text={assets.length ? "Try a different search." : "Click Add asset to assign the first one."}
                />
              )}
            </section>
          )}

          {view === "employees" && (
            <section className="card">
              <div className="section-head">
                <div>
                  <h2>Employee directory</h2>
                  <p>Registered employee and administrator accounts.</p>
                </div>
                <span className="chip">{employees.filter((e) => realEmail(e.email) && e.email_verified).length} profiles</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Name</th><th>Email</th><th>Employee ID</th><th>Department</th><th>Company</th><th>Email verified</th></tr>
                  </thead>
                  <tbody>
                    {employees.filter((e) => realEmail(e.email) && e.email_verified).map((employee) => (
                      <tr key={employee.id}>
                        <td><b>{employee.name}</b>{employee.role === "admin" && <small>Administrator</small>}</td>
                        <td>{employee.email}</td>
                        <td className="mono">{employee.employee_id}</td>
                        <td>{employee.department || "—"}</td>
                        <td>{employee.company || "—"}</td>
                        <td>
                          <span className={"pill " + (employee.email_verified ? "status resolved" : "priority high")}>
                            {employee.email_verified ? "Verified" : "Pending"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {view === "employeeCreate" && (
            <>
              <section className="card">
                <div className="section-head">
                  <div>
                    <h2>Create employee profile</h2>
                    <p>Add an employee with their name, Employee ID, email and department. An invitation email is sent automatically.</p>
                  </div>
                </div>
                <form className="card-pad" onSubmit={createProfile}>
                  <div className="form-grid">
                    <label className="field">
                      Employee name *
                      <input value={profileDraft.name} maxLength={100} required placeholder="Jane Doe" onChange={(e) => setProfileDraft({ ...profileDraft, name: e.target.value })} />
                    </label>
                    <label className="field">
                      Employee ID *
                      <input value={profileDraft.employeeId} maxLength={30} required placeholder="EMP1005" onChange={(e) => setProfileDraft({ ...profileDraft, employeeId: e.target.value })} />
                    </label>
                    <label className="field">
                      Employee email *
                      <input type="email" value={profileDraft.email} maxLength={254} required placeholder="jane.doe@company.com" onChange={(e) => setProfileDraft({ ...profileDraft, email: e.target.value })} />
                    </label>
                    <label className="field">
                      Employee department *
                      <select value={profileDraft.department} required onChange={(e) => setProfileDraft({ ...profileDraft, department: e.target.value })}>
                        <option value="" disabled>Select department</option>
                        {DEPARTMENTS.map((d) => (
                          <option key={d}>{d}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="form-actions" style={{ marginTop: 16 }}>
                    <button className="btn btn-primary" type="submit"><Icon name="plus" /> Create profile &amp; send invite</button>
                  </div>
                </form>
              </section>
              <section className="card">
                <div className="section-head">
                  <div>
                    <h2>Created profiles</h2>
                    <p>Employee profiles added by the administrator.</p>
                  </div>
                  <span className="chip">{profiles.filter((p) => realEmail(p.email) && p.status === "Registered").length} profiles</span>
                </div>
                {profiles.some((p) => realEmail(p.email) && p.status === "Registered") ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr><th>Name</th><th>Employee ID</th><th>Email</th><th>Department</th><th>Invitation</th><th>Created</th></tr>
                      </thead>
                      <tbody>
                        {profiles.filter((p) => realEmail(p.email) && p.status === "Registered").map((p) => (
                          <tr key={p.id}>
                            <td><b>{p.name}</b></td>
                            <td className="mono">{p.employee_id}</td>
                            <td>{p.email || <span className="muted">—</span>}</td>
                            <td>{p.department}</td>
                            <td>
                              <div className="cell-actions">
                                <span className={"pill " + (p.status === "Registered" ? "status resolved" : p.status === "Invited" ? "status queued" : "priority high")}>{p.status}</span>
                                {p.status !== "Registered" && p.email && (
                                  <button type="button" className="btn btn-sm" onClick={() => resendInvite(p.id)}>Resend invite</button>
                                )}
                              </div>
                            </td>
                            <td className="nowrap">{new Date(p.created_at).toLocaleDateString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty icon="users" title="No profiles created yet" text="Use the form above to create the first employee profile." />
                )}
              </section>
            </>
          )}

          {view === "settings" && (
            <section className="card">
              <div className="section-head">
                <div>
                  <h2>Portal settings</h2>
                  <p>Configure the display name and notification preference.</p>
                </div>
              </div>
              <form className="card-pad" onSubmit={saveSettings} style={{ display: "grid", gap: 16, maxWidth: 560 }}>
                <label className="field">
                  System name
                  <input value={settings.system_name || ""} maxLength={120} onChange={(e) => setSettings({ ...settings, system_name: e.target.value })} />
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={settings.notification_email_enabled === "true"}
                    onChange={(e) => setSettings({ ...settings, notification_email_enabled: String(e.target.checked) })}
                  />
                  Email the administrator when a new ticket is submitted (SMTP configuration required)
                </label>
                <div>
                  <button className="btn btn-primary" type="submit">Save settings</button>
                </div>
              </form>
            </section>
          )}

          {view === "profile" && (
            <AdminProfile
              user={user}
              totals={{ total: tickets.length, open: count("Open"), inProgress: count("In Progress"), resolved: count("Resolved") }}
              onSaved={(next, message) => {
                onUserChange(next);
                setNotice(message || "Profile updated.");
              }}
              onError={setNotice}
            />
          )}
        </div>
        <footer className="footer">
          <span>IT Support Portal · Admin</span>
          <span>{live ? "Connected · Live ticket notifications enabled" : "Reconnecting to live notifications…"}</span>
        </footer>
      </main>

      {assetFormOpen &&
        createPortal(
          <div className="modal-backdrop center" onMouseDown={(e) => e.target === e.currentTarget && setAssetFormOpen(false)}>
            <section className="modal dialog-sm" role="dialog" aria-modal="true" aria-label="Add asset">
              <button type="button" className="icon-button close" onClick={() => setAssetFormOpen(false)} aria-label="Close">
                <Icon name="x" />
              </button>
              <p className="eyebrow">Assets management</p>
              <h2>Add asset</h2>
              <form className="asset-form" onSubmit={createAsset}>
                <label className="field">
                  Employee name
                  <input value={assetDraft.employeeName} required maxLength={100} placeholder="Employee name" onChange={(e) => setAssetDraft({ ...assetDraft, employeeName: e.target.value })} />
                </label>
                <label className="field">
                  Employee ID
                  <input list="employee-ids" value={assetDraft.employeeId} required maxLength={30} placeholder="EMP1005" onChange={(e) => changeAssetEmployeeId(e.target.value)} />
                  <datalist id="employee-ids">
                    {profiles.map((p) => (
                      <option key={p.id} value={p.employee_id}>{p.name}</option>
                    ))}
                  </datalist>
                </label>
                <label className="field">
                  Employee department
                  <select value={assetDraft.department} required onChange={(e) => setAssetDraft({ ...assetDraft, department: e.target.value })}>
                    <option value="" disabled>Select department</option>
                    {DEPARTMENTS.map((d) => (
                      <option key={d}>{d}</option>
                    ))}
                  </select>
                </label>
                <div className="field">
                  Asset
                  <div className="asset-picks" role="group" aria-label="Select assets">
                    {ASSET_TYPES.map((item) => (
                      <button
                        key={item}
                        type="button"
                        className={"btn btn-sm" + (assetDraft.items.includes(item) ? " btn-primary" : "")}
                        aria-pressed={assetDraft.items.includes(item)}
                        onClick={() => toggleAssetItem(item)}
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                  <small>Select one or more.</small>
                </div>
                <button className="btn btn-primary" type="submit" disabled={!assetDraft.items.length}>Add</button>
              </form>
            </section>
          </div>,
          document.body,
        )}

      {selected && (
        <div className="modal-backdrop" onClick={() => setSelected(null)}>
          <section className="modal" role="dialog" aria-modal="true" aria-label={`Ticket ${selected.id}`} onClick={(e) => e.stopPropagation()}>
            <button className="icon-button close" onClick={() => setSelected(null)} aria-label="Close">
              <Icon name="x" />
            </button>
            <p className="eyebrow">Ticket details · <span className="mono">{selected.id}</span></p>
            <h2>{selected.title}</h2>
            <p className="muted">{selected.name} · {selected.employeeId} · {selected.email}</p>
            <div className="detail-grid">
              <div><small>Category</small><b>{selected.category}</b></div>
              <div><small>Priority</small><span className={"pill priority " + slug(selected.priority)}>{selected.priority}</span></div>
              <div>
                <small>Status</small>
                <select value={selected.status} onChange={(e) => update(selected.id, { status: e.target.value })} aria-label={`Status for ${selected.id}`}>
                  {STATUSES.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </div>
              <div><small>Submitted</small><b>{selected.createdAt}</b></div>
              <div><small>Employee ID</small><b>{selected.employeeId || "—"}</b></div>
              <div>
                <small>Department</small>
                <select
                  value={selected.department || ""}
                  onChange={(e) => update(selected.id, { department: e.target.value })}
                  aria-label={`Department for ${selected.id}`}
                >
                  {DEPARTMENTS.map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </select>
              </div>
            </div>
            <h3>Description</h3>
            <p className="description">{selected.description}</p>
            <h3>Attachment</h3>
            {selected.attachment ? (
              selected.attachment.type?.startsWith("image/") ? (
                <img className="preview" src={selected.attachment.dataUrl} alt={selected.attachment.name} />
              ) : (
                <a className="attachment-link" href={selected.attachment.dataUrl} target="_blank" rel="noreferrer" download={selected.attachment.name}>
                  <Icon name="paperclip" /> Open {selected.attachment.name}
                </a>
              )
            ) : (
              <p className="muted">No attachment uploaded.</p>
            )}
            <h3>Send an update</h3>
            <form onSubmit={sendMessage}>
              <textarea name="message" placeholder="Write a message for this employee…" required maxLength={2000} rows={3} />
              <button className="btn btn-primary" type="submit">Send message</button>
            </form>
            <h3>Update history</h3>
            <ul className="timeline">
              {(selected.updates?.length ? selected.updates : ["Ticket submitted"]).map((u, i) => (
                <li key={i}>{u}</li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}

function NotificationBell({ open, setOpen, items, fading = [], unread, onOpenItem, onMarkRead, onViewAll }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button
        className="icon-button"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen(!open)}
      >
        <Icon name="bell" />
        {unread > 0 && <span className="badge">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="dropdown" role="menu">
          <div className="dropdown-head">
            <b>Notifications</b>
            <button className="link-button" onClick={onMarkRead} disabled={!unread}>Mark all as read</button>
          </div>
          <div className="dropdown-list">
            {items.length ? (
              items.slice(0, 8).map((item) => (
                <button key={item.id} className={"dropdown-item" + (!item.read_at ? " unread" : "") + (fading.includes(item.id) ? " fading" : "")} onClick={() => onOpenItem(item)} role="menuitem">
                  <span className="dot" />
                  <div>
                    <p><b className="ticket-id">{item.ticket_id}</b> · {item.employee_name}</p>
                    <small>{item.ticket_title}</small>
                    <small>{timeAgo(item.created_at)}</small>
                  </div>
                </button>
              ))
            ) : (
              <div className="dropdown-empty">You're all caught up.</div>
            )}
          </div>
          <div className="dropdown-foot">
            <button className="link-button" onClick={onViewAll}>View all notifications</button>
          </div>
        </div>
      )}
    </div>
  );
}

function TicketTable({ tickets, onUpdate, onSelect }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Ticket / Employee</th>
            <th>Issue details</th>
            <th>Category</th>
            <th>Priority</th>
            <th>Status</th>
            <th>Created</th>
            <th>Attachment</th>
            <th>Update status</th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((t) => (
            <tr key={t.id}>
              <td>
                <b className="ticket-id">{t.id}</b>
                <small>{t.name || "Employee"} · {t.employeeId || "—"}</small>
                <small>{t.email}</small>
                <small>{t.department || "—"}</small>
              </td>
              <td>
                <b>{t.title}</b>
                <p>{t.description}</p>
              </td>
              <td>{t.category}</td>
              <td><span className={"pill priority " + slug(t.priority)}>{t.priority}</span></td>
              <td><span className={"pill status " + slug(t.status)}>{t.status}</span></td>
              <td className="nowrap">{t.createdAt}</td>
              <td>
                {t.attachment ? (
                  t.attachment.type?.startsWith("image/") ? (
                    <button className="attachment-link" onClick={() => onSelect(t)}>
                      <Icon name="image" /> View image
                    </button>
                  ) : (
                    <a className="attachment-link" href={t.attachment.dataUrl || "#"} target="_blank" rel="noreferrer" download={t.attachment.name}>
                      <Icon name="paperclip" /> {t.attachment.name}
                    </a>
                  )
                ) : (
                  <span className="muted">No file</span>
                )}
              </td>
              <td>
                <div className="cell-actions">
                  <select value={t.status} onChange={(e) => onUpdate(t.id, { status: e.target.value })} aria-label={`Update status ${t.id}`}>
                    {STATUSES.map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                  <button className="btn btn-sm" onClick={() => onSelect(t)}>Details</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdminProfile({ user, totals, onSaved, onError }) {
  const [busy, setBusy] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const data = Object.fromEntries(new FormData(e.currentTarget));
      const result = await api("/auth/profile", { method: "PATCH", body: JSON.stringify(data) });
      onSaved(result.user);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function savePhoto(dataUrl) {
    try {
      const result = await api("/auth/profile", { method: "PATCH", body: JSON.stringify({ avatar: dataUrl || null }) });
      onSaved(result.user, dataUrl ? "Profile photo updated." : "Profile photo removed.");
      setPhotoOpen(false);
    } catch (err) {
      onError(err.message);
    }
  }
  return (
    <>
      <section className="card">
        <div className="profile-hero">
          <span className="avatar-edit">
            <span className="avatar lg">{user.avatar ? <img src={user.avatar} alt="Profile photo" /> : (user.name || "A").trim().charAt(0).toUpperCase()}</span>
            <button type="button" className="avatar-camera" onClick={() => setPhotoOpen(true)} aria-label="Change profile photo" title="Take or upload a photo">
              <Icon name="camera" />
            </button>
          </span>
          <div>
            <h2>{user.name}</h2>
            <p>{user.employeeId} · {user.email}</p>
          </div>
          <span className="chip"><Icon name="shield" /> Administrator</span>
        </div>
        <div className="detail-grid">
          <div><small>Full name</small><b>{user.name}</b></div>
          <div><small>Email</small><b>{user.email}</b></div>
          <div><small>Employee ID</small><b>{user.employeeId}</b></div>
          <div><small>Role</small><b>Administrator</b></div>
          <div><small>Department</small><b>{user.department || "IT Administration"}</b></div>
          <div><small>Company</small><b>{user.company || "—"}</b></div>
          <div><small>Member since</small><b>{user.joinedAt || "—"}</b></div>
          <div>
            <small>Tickets managed</small>
            <b>{totals.total} total · {totals.open} open · {totals.inProgress} in progress · {totals.resolved} resolved</b>
          </div>
        </div>
      </section>
      <section className="card">
        <div className="section-head">
          <div>
            <h2>Edit details</h2>
            <p>Email and Employee ID are fixed.</p>
          </div>
        </div>
        <form className="card-pad" onSubmit={save} key={user.name + user.department + user.company}>
          <div className="form-grid">
            <label className="field">
              Full name
              <input name="name" defaultValue={user.name} maxLength={100} required />
            </label>
            <label className="field">
              Company
              <input name="company" defaultValue={user.company || ""} maxLength={100} />
            </label>
          </div>
          <div className="form-actions" style={{ marginTop: 16 }}>
            <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save profile"}</button>
          </div>
        </form>
      </section>
      {photoOpen && <PhotoDialog hasPhoto={Boolean(user.avatar)} onClose={() => setPhotoOpen(false)} onSave={savePhoto} />}
    </>
  );
}

// Take a photo with the camera or upload one, preview it, then save.
function PhotoDialog({ hasPhoto, onClose, onSave }) {
  const [mode, setMode] = useState("choose"); // choose | camera | preview
  const [preview, setPreview] = useState("");
  const [problem, setProblem] = useState("");
  const [saving, setSaving] = useState(false);
  const videoRef = useRef(null);
  const streamRef = useRef(null);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      stopCamera();
    };
  }, [onClose]);

  useEffect(() => {
    if (mode !== "camera") return;
    let cancelled = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      setProblem("Camera is not available in this browser. You can upload a photo instead.");
      setMode("choose");
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "user" }, audio: false })
      .then((stream) => {
        if (cancelled) return stream.getTracks().forEach((track) => track.stop());
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch((error) => {
        if (cancelled) return;
        setProblem(
          error.name === "NotAllowedError"
            ? "Camera access was blocked. Allow it in your browser, or upload a photo instead."
            : "No camera was found. You can upload a photo instead.",
        );
        setMode("choose");
      });
    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [mode]);

  function capture() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    setPreview(toSquareJpeg(video, video.videoWidth, video.videoHeight, true));
    stopCamera();
    setMode("preview");
  }
  function upload(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) return setProblem("Please choose a PNG, JPG, GIF or WebP image.");
    if (file.size > 5_000_000) return setProblem("Please choose an image smaller than 5 MB.");
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setPreview(toSquareJpeg(img, img.naturalWidth, img.naturalHeight));
      URL.revokeObjectURL(url);
      setProblem("");
      setMode("preview");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setProblem("That image could not be read. Try another file.");
    };
    img.src = url;
  }
  async function save(dataUrl) {
    setSaving(true);
    await onSave(dataUrl);
    setSaving(false);
  }

  return createPortal(
    <div className="modal-backdrop center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal dialog-sm" role="dialog" aria-modal="true" aria-label="Profile photo">
        <button type="button" className="icon-button close" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        <p className="eyebrow">Profile photo</p>
        <h2>{mode === "camera" ? "Take a photo" : mode === "preview" ? "Looks good?" : "Update your photo"}</h2>
        {problem && <p className="photo-problem" role="alert"><Icon name="alert" /> {problem}</p>}

        {mode === "camera" && (
          <>
            <div className="photo-frame"><video ref={videoRef} autoPlay playsInline muted className="mirror" /></div>
            <div className="photo-actions">
              <button type="button" className="btn btn-primary" onClick={capture}><Icon name="camera" /> Capture</button>
              <button type="button" className="btn" onClick={() => setMode("choose")}>Cancel</button>
            </div>
          </>
        )}
        {mode === "preview" && (
          <>
            <div className="photo-frame round"><img src={preview} alt="New profile photo preview" /></div>
            <div className="photo-actions">
              <button type="button" className="btn btn-primary" disabled={saving} onClick={() => save(preview)}>{saving ? "Saving…" : "Use photo"}</button>
              <button type="button" className="btn" disabled={saving} onClick={() => { setPreview(""); setMode("choose"); }}>Choose another</button>
            </div>
          </>
        )}
        {mode === "choose" && (
          <div className="photo-actions col">
            <button type="button" className="btn btn-primary" onClick={() => { setProblem(""); setMode("camera"); }}><Icon name="camera" /> Take a photo</button>
            <label className="btn">
              <Icon name="image" /> Upload a photo
              <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={upload} hidden />
            </label>
            {hasPhoto && <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => save("")}>Remove photo</button>}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function Stat({ label, value, icon, tone, total }) {
  const pct = total ? Math.round((value / total) * 100) : null;
  return (
    <div className="stat">
      <div className="stat-top">
        <p>{label}</p>
        <span className={"stat-icon " + (tone || "")}><Icon name={icon} /></span>
      </div>
      <div>
        <b>{value}</b>
        {pct !== null && (
          <div className="stat-bar" title={`${pct}% of all tickets`}><span style={{ width: pct + "%" }} /></div>
        )}
      </div>
    </div>
  );
}

// Big ring card modelled on the reference design: resolution rate + a
// plain-language summary computed from the live ticket list.
function OverviewHero({ tickets, unread, onReview }) {
  const total = tickets.length;
  const resolved = tickets.filter((t) => t.status === "Resolved").length;
  const active = tickets.filter((t) => t.status !== "Resolved");
  const critical = active.filter((t) => t.priority === "Critical").length;
  const high = active.filter((t) => t.priority === "High").length;
  const rate = total ? (resolved / total) * 100 : 0;
  const headline = !total
    ? "No tickets yet — the queue is clear."
    : critical
      ? `${critical} critical ticket${critical > 1 ? "s need" : " needs"} attention right now.`
      : active.length
        ? `Queue is stable — ${active.length} active request${active.length > 1 ? "s" : ""}, none critical.`
        : "All tickets are resolved — great work.";
  return (
    <div className="hero">
      <div className="hero-body">
        <Ring value={rate} label="Tickets resolved" />
        <div className="hero-text">
          <p className="eyebrow"><Icon name="activity" /> Live summary</p>
          <h2>{headline}</h2>
          <div className="hero-facts">
            <div><span>Total tickets</span><b>{total}</b></div>
            <div><span>Active · high priority</span><b>{high}</b></div>
            <div><span>Unread notifications</span><b>{unread}</b></div>
          </div>
        </div>
      </div>
      <div className="hero-foot">
        <span>Clearing open tickets first keeps response times low.</span>
        <button className="btn btn-primary" onClick={onReview}>Review open tickets</button>
      </div>
    </div>
  );
}

function Empty({ icon = "inbox", title, text }) {
  return (
    <div className="empty">
      <span className="empty-icon"><Icon name={icon} /></span>
      <b>{title}</b>
      <p>{text}</p>
    </div>
  );
}

export default function AdminPortal() {
  return (
    <Auth admin>
      {(user, setUser, logout) => <App user={user} onUserChange={setUser} onLogout={logout} />}
    </Auth>
  );
}
