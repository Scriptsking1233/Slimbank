/* =====================================================================
 * SlimBANK - server bridge v2 (own auth via RPC, no Supabase Auth)
 * Load AFTER supabase-js and AFTER slimbank-config.js
 * Falls back to local-only mode if server is unreachable.
 * ===================================================================== */
(function () {
  "use strict";
​
  var CFG = window.SLIM_SUPABASE || {};
  var KU = "slimbank_users_v3";
  var KS = "slimbank_session_v3";
  var KT = "slimbank_token_v2";
​
  var api = {
    online: false,
    ready: false,
    token: null,
    loginId: null,
    error: null,
    lastPush: 0
  };
  window.SlimServer = api;
​
  /* ---------- utils ---------- */
  function digits(s) { return String(s == null ? "" : s).replace(/\D/g, ""); }
  function readUsers() {
    try { return JSON.parse(localStorage.getItem(KU) || "{}") || {}; } catch (e) { return {}; }
  }
  var suppress = false;
  function writeUsers(map) {
    suppress = true;
    try { localStorage.setItem(KU, JSON.stringify(map)); } catch (e) {}
    suppress = false;
  }
  function log() {
    if (!CFG.debug) return;
    try { console.log.apply(console, ["[slim]"].concat([].slice.call(arguments))); } catch (e) {}
  }
  function getToken() {
    if (api.token) return api.token;
    try { api.token = localStorage.getItem(KT) || null; } catch (e) {}
    return api.token;
  }
  function setToken(t) {
    api.token = t || null;
    try {
      if (t) localStorage.setItem(KT, t);
      else localStorage.removeItem(KT);
    } catch (e) {}
  }
​
  /* ---------- status pill ---------- */
  var pill = null;
  function badge(text, kind) {
    try {
      if (!document.body) return;
      if (!pill) {
        pill = document.createElement("div");
        pill.id = "slimSrvPill";
        pill.style.cssText =
          "position:fixed;left:14px;bottom:14px;z-index:99999;font:600 12px/1 Inter,system-ui,sans-serif;" +
          "padding:8px 12px;border-radius:999px;display:flex;align-items:center;gap:7px;" +
          "background:rgba(12,18,26,.78);color:#e8f0ff;border:1px solid rgba(255,255,255,.12);" +
          "backdrop-filter:blur(10px);cursor:pointer;max-width:70vw";
        var dot = document.createElement("span");
        dot.className = "srv-dot";
        dot.style.cssText = "width:8px;height:8px;border-radius:50%;background:#7b8794;flex:0 0 auto";
        var lbl = document.createElement("span");
        lbl.className = "srv-lbl";
        lbl.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
        pill.appendChild(dot);
        pill.appendChild(lbl);
        document.body.appendChild(pill);
      }
      pill.querySelector(".srv-lbl").textContent = text;
      pill.querySelector(".srv-dot").style.background =
        kind === "ok" ? "#31d0aa" : kind === "warn" ? "#ffbe4d" : kind === "err" ? "#ff6b7d" : "#7b8794";
    } catch (e) {}
  }
  api.badge = badge;
​
  /* ---------- no config = local mode ---------- */
  function offlineOnly(reason) {
    api.error = reason;
    var show = function () { badge("\u041e\u0444\u043b\u0430\u0439\u043d (" + reason + ")", "off"); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", show);
    else show();
  }
  if (!CFG.url || !CFG.anonKey || String(CFG.url).indexOf("http") !== 0) { offlineOnly("no config"); return; }
  if (!window.supabase || !window.supabase.createClient) { offlineOnly("no sdk"); return; }
​
  var sb = window.supabase.createClient(CFG.url, CFG.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  api.client = sb;
​
  function rpc(name, args) {
    return sb.rpc(name, args || {}).then(function (r) {
      if (r.error) {
        api.error = r.error.message;
        log("rpc error", name, r.error.message);
        return { ok: false, error: r.error.message, rpcFailed: true };
      }
      return r.data;
    });
  }
  api.rpc = rpc;
​
  /* ---------- state mapping ---------- */
  function applyServer(res) {
    if (!res || res.ok === false) return null;
    var u = res.state && typeof res.state === "object" ? res.state : {};
    u.id = u.id || res.login_id;
    if (res.balance != null) u.balance = Number(res.balance);
    if (res.plan) u.plan = res.plan;
    if (res.username) u.username = res.username;
    if (res.last_accrual) u.lastAccrual = Number(res.last_accrual);
​
    var map = readUsers();
    map[u.id] = u;
    writeUsers(map);
    try { localStorage.setItem(KS, u.id); } catch (e) {}
    api.loginId = u.id;
    api.online = true;
    return u;
  }
​
  /* ---------- public api ---------- */
  api.pull = function () {
    if (!getToken()) return Promise.resolve(null);
    return rpc("sb_pull", { p_token: getToken() }).then(function (res) {
      if (!res || res.ok === false) {
        if (res && res.error === "no_session") { setToken(null); api.online = false; }
        return null;
      }
      return applyServer(res);
    });
  };
​
  api.push = function (u) {
    if (!getToken() || !u) return Promise.resolve(false);
    api.lastPush = Date.now();
    return rpc("sb_push", { p_token: getToken(), p_state: u }).then(function (res) {
      if (!res || res.ok === false) {
        if (res && res.error === "no_session") { setToken(null); api.online = false; badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u043d\u0443\u0436\u0435\u043d \u0432\u0445\u043e\u0434", "warn"); }
        return false;
      }
      api.online = true;
      badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u043e", "ok");
      return true;
    });
  };
​
  api.register = function (u) {
    var id = digits(u.id || u.phone);
    var pass = String(u.pass || "");
    if (id.length < 5 || pass.length < 4) return Promise.resolve({ ok: false, error: "bad_input" });
    badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u0441\u043e\u0437\u0434\u0430\u0451\u043c \u0430\u043a\u043a\u0430\u0443\u043d\u0442...", "warn");
    return rpc("sb_register", { p_login: id, p_pass: pass, p_state: u }).then(function (res) {
      if (!res || res.ok === false) {
        badge("\u0421\u0435\u0440\u0432\u0435\u0440: " + errText(res && res.error), "err");
        return { ok: false, error: res && res.error };
      }
      setToken(res.token);
      applyServer(res);
      badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u0430\u043a\u043a\u0430\u0443\u043d\u0442 \u0441\u043e\u0437\u0434\u0430\u043d", "ok");
      return { ok: true, user: readUsers()[api.loginId] };
    });
  };
​
  api.signIn = function (login, pass) {
    return rpc("sb_login", { p_login: String(login || ""), p_pass: String(pass || "") }).then(function (res) {
      if (res && res.ok !== false) {
        setToken(res.token);
        var u = applyServer(res);
        badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u043e\u043d\u043b\u0430\u0439\u043d", "ok");
        return { ok: true, user: u };
      }
      /* no server account yet: migrate the local one */
      var map = readUsers();
      var uL = map[digits(login)];
      if (!uL) {
        var keys = Object.keys(map);
        for (var i = 0; i < keys.length; i++) {
          var c = map[keys[i]];
          if (c && (c.phone === login || c.email === login || c.username === String(login).replace(/^@/, ""))) { uL = c; break; }
        }
      }
      if (uL && String(uL.pass || "") === String(pass || "") && CFG.autoRegister !== false) {
        return api.register(uL);
      }
      badge("\u0421\u0435\u0440\u0432\u0435\u0440: " + errText(res && res.error), "err");
      return { ok: false, error: res && res.error };
    });
  };
​
  api.signOut = function () {
    setToken(null);
    api.online = false;
    badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u0433\u043e\u0442\u043e\u0432 \u043a \u0432\u0445\u043e\u0434\u0443", "warn");
    return Promise.resolve(true);
  };
​
  api.usernameFree = function (name) {
    return rpc("sb_username_free", { p_name: String(name || "") }).then(function (r) {
      return typeof r === "boolean" ? r : null;
    });
  };
  api.claimUsername = function (name) {
    if (!getToken()) return Promise.resolve({ ok: false, error: "no_session" });
    return rpc("sb_claim_username", { p_token: getToken(), p_name: String(name || "") });
  };
  api.redeemPromo = function (code) {
    if (!getToken()) return Promise.resolve({ ok: false, error: "no_session" });
    return rpc("sb_redeem_promo", { p_token: getToken(), p_code: String(code || "") });
  };
  api.claimAccruals = function () {
    if (!getToken()) return Promise.resolve({ ok: false, error: "no_session" });
    return rpc("sb_claim_accruals", { p_token: getToken() });
  };
  api.leaderboard = function (limit) {
    return rpc("sb_leaderboard", { p_limit: limit || 20 }).then(function (r) {
      return r && r.ok === false ? [] : r || [];
    });
  };
​
  function errText(e) {
    return e === "exists" ? "\u0442\u0430\u043a\u043e\u0439 \u043d\u043e\u043c\u0435\u0440 \u0443\u0436\u0435 \u0437\u0430\u043d\u044f\u0442" :
           e === "bad_pass" ? "\u043d\u0435\u0432\u0435\u0440\u043d\u044b\u0439 \u043f\u0430\u0440\u043e\u043b\u044c" :
           e === "not_found" ? "\u0430\u043a\u043a\u0430\u0443\u043d\u0442 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d" :
           e === "weak" ? "\u043f\u0430\u0440\u043e\u043b\u044c \u043a\u043e\u0440\u043e\u0442\u043a\u0438\u0439" :
           e === "no_session" ? "\u043d\u0443\u0436\u0435\u043d \u0432\u0445\u043e\u0434" :
           /sb_/i.test(String(e || "")) ? "\u0441\u0445\u0435\u043c\u0430 \u043d\u0435 \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d\u0430" :
           String(e || "\u043e\u0448\u0438\u0431\u043a\u0430").slice(0, 46);
  }
​
  /* ---------- adopt an account that already exists in this browser ---------- */
  api.adoptLocal = function () {
    if (getToken() || CFG.autoRegister === false) return Promise.resolve(null);
    var map = readUsers();
    var sid = null;
    try { sid = localStorage.getItem(KS); } catch (e) {}
    var ids = Object.keys(map);
    var id = sid && map[sid] ? sid : ids[ids.length - 1];
    var u = id ? map[id] : null;
    if (!u || !u.pass) return Promise.resolve(null);
    api.loginId = id;
    return api.register(u).then(function (res) {
      if (res && res.ok) return api.push(readUsers()[id] || u);
      if (res && res.error === "exists") {
        return api.signIn(id, u.pass);
      }
      return null;
    }).catch(function () { return null; });
  };
​
  /* ---------- auto sync ---------- */
  var lastJson = "";
  var timer = null;
  function pushSoon(force) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; syncNow(force); }, 1200);
  }
  function syncNow(force) {
    if (!getToken()) return;
    var map = readUsers();
    var u = map[api.loginId] || map[Object.keys(map)[0]];
    if (!u) return;
    var j = JSON.stringify(u);
    if (!force && j === lastJson) return;
    lastJson = j;
    api.push(u);
  }
  api.syncNow = syncNow;
  setInterval(function () { syncNow(false); }, 20000);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") syncNow(true);
  });
  window.addEventListener("beforeunload", function () { syncNow(true); });
​
  /* ---------- hook localStorage writes ---------- */
  var rawSet = localStorage.setItem.bind(localStorage);
  try {
    localStorage.setItem = function (key, value) {
      rawSet(key, value);
      if (suppress || key !== KU) return;
      try {
        var map = JSON.parse(value || "{}") || {};
        var ids = Object.keys(map);
        var id = api.loginId && map[api.loginId] ? api.loginId : ids[ids.length - 1];
        if (!id) return;
        var u = map[id];
        if (getToken()) { api.loginId = id; pushSoon(false); }
        else if (u && u.pass && CFG.autoRegister !== false) {
          api.loginId = id;
          api.register(u);
        }
      } catch (e) { log("hook", e.message); }
    };
  } catch (e) { log("cannot hook storage"); }
​
  /* ---------- login form: ask server first ---------- */
  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (!f || f.id !== "loginForm") return;
    if (f.dataset.slimBypass === "1") { f.dataset.slimBypass = ""; return; }
​
    var idEl = document.getElementById("loginId");
    var passEl = document.getElementById("loginPass");
    var login = idEl ? idEl.value : "";
    var pass = passEl ? passEl.value : "";
​
    e.preventDefault();
    e.stopPropagation();
    badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0430...", "warn");
​
    api.signIn(login, pass)
      .catch(function () { badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u043d\u0435\u0442 \u0441\u0432\u044f\u0437\u0438", "off"); })
      .then(function () {
        f.dataset.slimBypass = "1";
        f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
  }, true);
​
  /* ---------- logout: drop the token too ---------- */
  document.addEventListener("click", function (e) {
    var t = e.target;
    while (t && t !== document.body) {
      var txt = (t.textContent || "").trim();
      if (t.id === "logout" || t.dataset.logout != null || txt === "\u0412\u044b\u0439\u0442\u0438") {
        syncNow(true);
        setTimeout(function () { setToken(null); api.online = false; badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u0433\u043e\u0442\u043e\u0432 \u043a \u0432\u0445\u043e\u0434\u0443", "warn"); }, 300);
        return;
      }
      t = t.parentElement;
    }
  }, true);
​
  /* ---------- tap the pill = diagnostics ---------- */
  document.addEventListener("click", function (e) {
    var t = e.target;
    while (t && t.id !== "slimSrvPill") t = t.parentElement;
    if (!t) return;
    var lines = [
      "SlimBANK / \u0441\u0435\u0440\u0432\u0435\u0440",
      "\u0441\u0432\u044f\u0437\u044c: " + (api.online ? "\u0435\u0441\u0442\u044c" : "\u043d\u0435\u0442"),
      "\u0442\u043e\u043a\u0435\u043d: " + (getToken() ? "\u0435\u0441\u0442\u044c" : "\u043d\u0435\u0442"),
      "\u043b\u043e\u0433\u0438\u043d: " + (api.loginId || "-"),
      "\u043e\u0448\u0438\u0431\u043a\u0430: " + (api.error || "-")
    ];
    if (getToken()) { syncNow(true); lines.push("\u2192 \u0431\u0430\u043b\u0430\u043d\u0441 \u043e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d \u043d\u0430 \u0441\u0435\u0440\u0432\u0435\u0440"); }
    else { api.adoptLocal(); lines.push("\u2192 \u043f\u0440\u043e\u0431\u0443\u044e \u0437\u0430\u0432\u0435\u0441\u0442\u0438 \u0430\u043a\u043a\u0430\u0443\u043d\u0442"); }
    try { alert(lines.join("\n")); } catch (err) {}
  }, false);
​
  /* ---------- boot ---------- */
  function boot() {
    badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u0435...", "warn");
    api.ready = true;
    if (!getToken()) {
      badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u0433\u043e\u0442\u043e\u0432 \u043a \u0432\u0445\u043e\u0434\u0443", "warn");
      api.adoptLocal();
      return;
    }
    (CFG.serverAccruals === false ? Promise.resolve(null) : api.claimAccruals())
      .then(function () { return api.pull(); })
      .then(function (u) {
        if (!u) { badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u0433\u043e\u0442\u043e\u0432 \u043a \u0432\u0445\u043e\u0434\u0443", "warn"); return; }
        badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u043e\u043d\u043b\u0430\u0439\u043d", "ok");
        if (window.SLIM_HOOKS && window.SLIM_HOOKS.reload) {
          try { window.SLIM_HOOKS.reload(u); } catch (e) {}
        }
      })
      .catch(function (err) {
        api.error = err && err.message;
        badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u043e\u0444\u043b\u0430\u0439\u043d", "off");
      });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
​
/* =====================================================================
 * UI wiring: promo codes and usernames go through the server
 * ===================================================================== */
(function () {
  "use strict";
  var CFG = window.SLIM_SUPABASE || {};
  var srv = window.SlimServer;
  if (!srv || !srv.client) return;
​
  function hint(text, kind) {
    var el = document.getElementById("pmHint");
    if (!el) return;
    el.textContent = text;
    el.style.color = kind === "ok" ? "#31d0aa" : kind === "err" ? "#ff6b7d" : "";
  }
​
  function wire() {
    var hooks = window.SLIM_HOOKS;
​
    if (hooks && CFG.serverPromos !== false && !hooks.__slimPromo) {
      hooks.__slimPromo = true;
      hooks.promoServer = function (raw) {
        if (!srv.token) { hint("\u041d\u0435\u0442 \u0441\u0432\u044f\u0437\u0438 \u0441 \u0441\u0435\u0440\u0432\u0435\u0440\u043e\u043c \u2014 \u043a\u043e\u0434 \u043f\u0440\u043e\u0432\u0435\u0440\u0435\u043d \u043b\u043e\u043a\u0430\u043b\u044c\u043d\u043e", ""); return false; }
        hint("\u041f\u0440\u043e\u0432\u0435\u0440\u044f\u0435\u043c \u043a\u043e\u0434...", "");
        srv.redeemPromo(raw).then(function (r) {
          if (!r || r.ok === false) {
            var e = r && r.error;
            hint(e === "used" ? "\u042d\u0442\u043e\u0442 \u043a\u043e\u0434 \u0443\u0436\u0435 \u0430\u043a\u0442\u0438\u0432\u0438\u0440\u043e\u0432\u0430\u043d" :
                 e === "limit" ? "\u041b\u0438\u043c\u0438\u0442 \u0430\u043a\u0442\u0438\u0432\u0430\u0446\u0438\u0439 \u0438\u0441\u0447\u0435\u0440\u043f\u0430\u043d" :
                 e === "no_session" ? "\u0421\u043d\u0430\u0447\u0430\u043b\u0430 \u0432\u043e\u0439\u0434\u0438\u0442\u0435 \u0432 \u0430\u043a\u043a\u0430\u0443\u043d\u0442" :
                 "\u041a\u043e\u0434 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d", "err");
            return;
          }
          var money = Number(r.money || 0);
          if (money > 0 && hooks.credit) hooks.credit(money, "\u041f\u0440\u043e\u043c\u043e\u043a\u043e\u0434 " + r.code, r.note || "");
          hint("\u041a\u043e\u0434 " + r.code + " \u0430\u043a\u0442\u0438\u0432\u0438\u0440\u043e\u0432\u0430\u043d" + (r.note ? ": " + r.note : ""), "ok");
          var inp = document.getElementById("pmInput");
          if (inp) inp.value = "";
          setTimeout(function () { srv.syncNow && srv.syncNow(true); }, 800);
        });
        return true;
      };
      hooks.usernameCheck = function (name) { return srv.usernameFree(name); };
    }
​
    /* hard username reservation: intercept the claim button */
    if (document.body && !document.body.dataset.slimUnWired) {
      document.body.dataset.slimUnWired = "1";
      document.addEventListener("click", function (e) {
        var btn = e.target;
        while (btn && btn.id !== "unSave") btn = btn.parentElement;
        if (!btn) return;
        if (btn.dataset.slimPass === "1") { btn.dataset.slimPass = ""; return; }
        if (!srv.token) return;
​
        var inp = document.getElementById("unInput");
        var name = inp ? String(inp.value || "").replace(/^@/, "").trim() : "";
        if (!name) return;
​
        e.preventDefault();
        e.stopPropagation();
​
        var un = document.getElementById("unHint");
        if (un) { un.textContent = "\u041f\u0440\u043e\u0432\u0435\u0440\u044f\u0435\u043c \u043d\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u0435..."; un.style.color = ""; }
​
        srv.claimUsername(name).then(function (r) {
          if (r && r.ok) {
            if (un) { un.textContent = "\u042e\u0437\u0435\u0440\u043d\u0435\u0439\u043c \u0437\u0430\u043a\u0440\u0435\u043f\u043b\u0451\u043d \u0437\u0430 \u0432\u0430\u043c\u0438"; un.style.color = "#31d0aa"; }
            btn.dataset.slimPass = "1";
            btn.click();
            setTimeout(function () { srv.syncNow && srv.syncNow(true); }, 600);
          } else if (un) {
            var err = r && r.error;
            un.textContent = err === "taken" ? "\u0423\u0436\u0435 \u0437\u0430\u043d\u044f\u0442 \u0434\u0440\u0443\u0433\u0438\u043c \u0438\u0433\u0440\u043e\u043a\u043e\u043c" :
                              err === "bad_format" ? "4-20 \u0441\u0438\u043c\u0432\u043e\u043b\u043e\u0432: \u0431\u0443\u043a\u0432\u044b, \u0446\u0438\u0444\u0440\u044b, _" :
                              "\u0421\u0435\u0440\u0432\u0435\u0440 \u043d\u0435 \u043e\u0442\u0432\u0435\u0442\u0438\u043b, \u043f\u043e\u0432\u0442\u043e\u0440\u0438\u0442\u0435";
            un.style.color = "#ff6b7d";
          }
        }).catch(function () {
          if (un) { un.textContent = "\u0421\u0435\u0440\u0432\u0435\u0440 \u043d\u0435 \u043e\u0442\u0432\u0435\u0442\u0438\u043b, \u043f\u043e\u0432\u0442\u043e\u0440\u0438\u0442\u0435"; un.style.color = "#ff6b7d"; }
        });
      }, true);
    }
  }
​
  function pump() { try { wire(); } catch (e) {} setTimeout(pump, 3000); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", pump);
  else pump();
})();
​
