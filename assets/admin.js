// admin.js — shared client for admin.easierlet.com
//
// Wraps Supabase auth, the admin-auth and admin-api Edge Functions, and
// provides a small set of UI helpers (mountHeader, requireSession, esc, etc.)
// that every page uses.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL  = "https://ffzknvcptqjlkxmkdxuk.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZmemtudmNwdHFqbGt4bWtkeHVrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyNTQ0ODQsImV4cCI6MjA5MDgzMDQ4NH0.YRdkBgoVm7cpUJlsK8T4nP6iNE3vgfOmODImiAkPhr4";

// Use a separate localStorage key from the public landlord/tenant portals so
// admin sessions never collide with a user who's also an admin under another
// account. (And to be defensive — admin sessions live on a different domain.)
const STORAGE_KEY = "elp-admin-session";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { storageKey: STORAGE_KEY, persistSession: true, autoRefreshToken: true },
});

const ADMIN = {
  supabase,
  SUPABASE_URL,
  SUPABASE_ANON,

  esc(s) {
    if (s === null || s === undefined) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  },

  fmtDate(s) {
    if (!s) return "";
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  },
  fmtDateTime(s) {
    if (!s) return "";
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  },
  relTime(s) {
    if (!s) return "";
    const d = new Date(s);
    const diffSec = (Date.now() - d.getTime()) / 1000;
    if (diffSec < 60) return "Just now";
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return ADMIN.fmtDate(s);
  },

  /**
   * Check we have a valid admin session at AAL2. Otherwise redirect to login.
   * Returns the admin profile when valid, or null after redirect.
   */
  async requireAdminSession() {
    const { data: sessRes } = await supabase.auth.getSession();
    if (!sessRes?.session) {
      window.location.replace("/index.html");
      return null;
    }
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel !== "aal2") {
      window.location.replace("/index.html");
      return null;
    }
    // Fetch admin profile via admin-api whoami — this also validates the
    // server-side admin_users gate.
    try {
      const me = await ADMIN.api("whoami", {});
      if (!me?.admin) { window.location.replace("/index.html"); return null; }
      return me.admin;
    } catch (_e) {
      window.location.replace("/index.html");
      return null;
    }
  },

  async signOut() {
    try { await supabase.auth.signOut(); } catch (_e) {}
    window.location.replace("/index.html");
  },

  /**
   * Call an admin-api action. Throws on non-2xx with `{ error, message }`.
   */
  async api(action, params = {}) {
    const { data: sess } = await supabase.auth.getSession();
    const accessToken = sess?.session?.access_token;
    if (!accessToken) throw Object.assign(new Error("Not signed in"), { error: "no_session" });

    const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-api`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON,
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ action, ...params }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      throw Object.assign(new Error(json.message || `HTTP ${res.status}`), {
        error: json.error || "http_error", status: res.status, payload: json,
      });
    }
    return json;
  },

  /**
   * Render the sticky admin header with nav links.
   */
  mountHeader(active, admin) {
    const nav = [
      { href: "/dashboard.html",  id: "dashboard",  label: "Dashboard"  },
      { href: "/audit.html",      id: "audit",      label: "Audit log"  },
      { href: "/retention.html",  id: "retention",  label: "Retention"  },
      { href: "/dsar.html",       id: "dsar",       label: "DSAR"       },
      { href: "/compliance.html", id: "compliance", label: "Compliance" },
      { href: "/settings.html",   id: "settings",   label: "Settings"   },
    ];
    const html = `
      <div class="admin-header">
        <div class="admin-header-inner">
          <div class="admin-brand">
            <span><span class="e">easier</span><span class="l">Let</span></span>
            <span class="admin-badge">ADMIN</span>
          </div>
          <nav class="admin-nav">
            ${nav.map((n) => `<a href="${n.href}" class="${n.id === active ? "active" : ""}">${n.label}</a>`).join("")}
          </nav>
          <div class="admin-user">
            <span>${ADMIN.esc(admin?.name ?? admin?.email ?? "")}</span>
            <button class="signout" id="adminSignOut">Sign out</button>
          </div>
        </div>
      </div>
    `;
    const host = document.getElementById("admin-header") || document.body;
    if (host.id === "admin-header") host.innerHTML = html;
    else host.insertAdjacentHTML("afterbegin", html);
    document.getElementById("adminSignOut")?.addEventListener("click", ADMIN.signOut);
  },

  /**
   * Render a status pill from a status string with sensible colour mapping.
   */
  statusPill(s) {
    if (!s) return `<span class="pill pill-grey">—</span>`;
    const map = {
      active: "green", trialing: "blue", past_due: "orange", cancelled: "grey", expired: "red",
      live: "green", let_agreed: "purple", draft: "grey", delisted: "grey",
      pending: "blue", confirmed: "green", proposed: "orange", declined: "red",
    };
    const cls = map[s] || "grey";
    const label = String(s).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return `<span class="pill pill-${cls}">${label}</span>`;
  },
};

window.ADMIN = ADMIN;
