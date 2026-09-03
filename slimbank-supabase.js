/* =====================================================================
 * SlimBANK - мост между сайтом и Supabase (аккаунты + баланс на сервере)
 * Подключается ПОСЛЕ supabase-js и ПОСЛЕ slimbank-config.js
 * Работает прозрачно: если сервер недоступен - сайт работает локально
 * ===================================================================== */
(function () {
  "use strict";

  var CFG = window.SLIM_SUPABASE || {};
  var KU = "slimbank_users_v3";
  var KS = "slimbank_session_v3";
  var AUTH_DOMAIN = "@slimbank.local";

  var api = {
    online: false,
    ready: false,
    uid: null,
    loginId: null,
    error: null
  };
  window.SlimServer = api;

  /* ---------- маленькие утилиты ---------- */
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
    try { console.log.apply(console, ["[slim-server]"].concat([].slice.call(arguments))); } catch (e) {}
  }

  /* ---------- индикатор состояния ---------- */
  var pill = null;
  function badge(text, kind) {
    try {
      if (!pill) {
        pill = document.createElement("div");
        pill.id = "slimSrvPill";
        pill.style.cssText =
          "position:fixed;left:14px;bottom:14px;z-index:9999;font:600 12px/1 Inter,system-ui,sans-serif;" +
          "padding:8px 12px;border-radius:999px;display:flex;align-items:center;gap:7px;" +
          "background:rgba(12,18,26,.72);color:#e8f0ff;border:1px solid rgba(255,255,255,.12);" +
          "backdrop-filter:blur(10px);cursor:default;transition:opacity .3s";
        var dot = document.createElement("span");
        dot.className = "srv-dot";
        dot.style.cssText = "width:8px;height:8px;border-radius:50%;background:#7b8794";
        var lbl = document.createElement("span");
        lbl.className = "srv-lbl";
        pill.appendChild(dot);
        pill.appendChild(lbl);
        document.body.appendChild(pill);
      }
      pill.querySelector(".srv-lbl").textContent = text;
      pill.querySelector(".srv-dot").style.background =
        kind === "ok" ? "#31d0aa" : kind === "warn" ? "#ffbe4d" : "#7b8794";
      pill.style.boxShadow = kind === "ok" ? "0 0 0 4px rgba(49,208,170,.12)" : "none";
    } catch (e) {}
  }

  /* ---------- нет конфига = офлайн-режим ---------- */
  if (!CFG.url || !CFG.anonKey || String(CFG.url).indexOf("http") !== 0) {
    api.error = "no_config";
    document.addEventListener("DOMContentLoaded", function () {
      badge("\u041e\u0444\u043b\u0430\u0439\u043d (\u0431\u0435\u0437 \u0441\u0435\u0440\u0432\u0435\u0440\u0430)", "off");
    });
    return;
  }
  if (!window.supabase || !window.supabase.createClient) {
    api.error = "no_sdk";
    document.addEventListener("DOMContentLoaded", function () {
      badge("\u041e\u0444\u043b\u0430\u0439\u043d (SDK)", "off");
    });
    return;
  }

  var sb = window.supabase.createClient(CFG.url, CFG.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });
  api.client = sb;

  /* ---------- профиль: сервер <-> localStorage ---------- */
  function userToRow(u) {
    var state = {};
    for (var k in u) if (Object.prototype.hasOwnProperty.call(u, k)) state[k] = u[k];
    return {
      login_id: digits(u.id || u.phone),
      phone: u.phone || null,
      email: u.email || null,
      first_name: u.first || null,
      last_name: u.last || null,
      city: u.city || null,
      birth: u.birth || null,
      plan: u.plan || "basic",
      balance: Number(u.balance || 0),
      last_accrual: Number(u.lastAccrual || 0),
      state: state
    };
  }

  function rowToUser(row) {
    var u = row.state && typeof row.state === "object" ? row.state : {};
    u.id = u.id || row.login_id;
    u.phone = u.phone || row.phone || "";
    u.email = u.email || row.email || "";
    u.first = u.first || row.first_name || "";
    u.last = u.last || row.last_name || "";
    u.city = u.city || row.city || "";
    u.birth = u.birth || row.birth || "";
    u.plan = row.plan || u.plan || "basic";
    u.balance = Number(row.balance != null ? row.balance : u.balance || 0);
    if (row.last_accrual) u.lastAccrual = Number(row.last_accrual);
    if (row.username) u.username = row.username;
    return u;
  }

  function saveLocal(u, makeSession) {
    var map = readUsers();
    map[u.id] = u;
    writeUsers(map);
    if (makeSession) {
      try { localStorage.setItem(KS, u.id); } catch (e) {}
    }
  }

  /* забрать свой профиль с сервера */
  api.pull = function (opts) {
    opts = opts || {};
    return sb
      .from("profiles")
      .select("*")
      .limit(1)
      .maybeSingle()
      .then(function (r) {
        if (r.error || !r.data) return null;
        var u = rowToUser(r.data);
        api.loginId = u.id;
        saveLocal(u, opts.session !== false);
        log("pull ok", u.id, u.balance);
        return u;
      });
  };

  /* отправить свой профиль на сервер */
  api.push = function (u) {
    if (!api.uid || !u) return Promise.resolve(false);
    var row = userToRow(u);
    row.id = api.uid;
    return sb
      .from("profiles")
      .upsert(row, { onConflict: "id" })
      .then(function (r) {
        if (r.error) { log("push error", r.error.message); return false; }
        badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u043e", "ok");
        return true;
      });
  };

  /* отложенная синхронизация (не чаще раза в 1.5 с) */
  var syncTimer = null;
  var pendingId = null;
  function scheduleSync(id) {
    pendingId = id;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(function () {
      syncTimer = null;
      var map = readUsers();
      var u = map[pendingId] || map[api.loginId];
      if (u) api.push(u);
    }, 1500);
  }

  /* ---------- регистрация / вход ---------- */
  function authEmail(id) { return digits(id) + AUTH_DOMAIN; }

  api.signUp = function (u) {
    var id = digits(u.id || u.phone);
    var pass = String(u.pass || "");
    if (id.length < 5 || pass.length < 6) return Promise.resolve({ ok: false, error: "weak" });
    return sb.auth
      .signUp({ email: authEmail(id), password: pass })
      .then(function (r) {
        if (r.error) {
          if (/already/i.test(r.error.message)) return api.signIn(id, pass);
          return { ok: false, error: r.error.message };
        }
        if (!r.data.session) {
          return sb.auth.signInWithPassword({ email: authEmail(id), password: pass }).then(function (r2) {
            if (r2.error) return { ok: false, error: "confirm_email" };
            api.uid = r2.data.user.id;
            api.online = true;
            api.loginId = id;
            return api.push(u).then(function () { return { ok: true }; });
          });
        }
        api.uid = r.data.user.id;
        api.online = true;
        api.loginId = id;
        badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u0430\u043a\u043a\u0430\u0443\u043d\u0442 \u0441\u043e\u0437\u0434\u0430\u043d", "ok");
        return api.push(u).then(function () { return { ok: true }; });
      });
  };

  api.signIn = function (login, pass) {
    return sb.rpc("find_login", { p_login: String(login || "") }).then(function (r) {
      var mail = r && !r.error && r.data ? r.data : authEmail(login);
      return sb.auth.signInWithPassword({ email: mail, password: String(pass || "") }).then(function (r2) {
        if (r2.error) return { ok: false, error: r2.error.message };
        api.uid = r2.data.user.id;
        api.online = true;
        return api.pull().then(function (u) {
          return { ok: true, user: u };
        });
      });
    });
  };

  api.signOut = function () {
    return sb.auth.signOut().then(function () {
      api.uid = null;
      api.online = false;
      badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u0432\u044b\u0445\u043e\u0434", "off");
    });
  };

  /* ---------- общие данные: юзернеймы, топ, промокоды, начисления ---------- */
  api.usernameFree = function (name) {
    return sb.rpc("username_free", { p_name: String(name || "") }).then(function (r) {
      return r.error ? null : !!r.data;
    });
  };
  api.claimUsername = function (name) {
    return sb.rpc("claim_username", { p_name: String(name || "") }).then(function (r) {
      return r.error ? { ok: false, error: r.error.message } : r.data;
    });
  };
  api.leaderboard = function (limit) {
    return sb.rpc("leaderboard", { p_limit: limit || 20 }).then(function (r) {
      return r.error ? [] : r.data || [];
    });
  };
  api.redeemPromo = function (code) {
    return sb.rpc("redeem_promo", { p_code: String(code || "") }).then(function (r) {
      return r.error ? { ok: false, error: r.error.message } : r.data;
    });
  };
  api.claimAccruals = function () {
    return sb.rpc("claim_accruals", {}).then(function (r) {
      return r.error ? { ok: false, error: r.error.message } : r.data;
    });
  };

  /* ---------- перехват записи в localStorage -> автосинк ---------- */
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
        if (api.uid) {
          api.loginId = id;
          scheduleSync(id);
        } else if (u && u.pass && u.pin && CFG.autoRegister !== false) {
          api.loginId = id;
          api.signUp(u).then(function (res) {
            if (res && res.ok) scheduleSync(id);
            else log("signUp", res && res.error);
          });
        }
      } catch (e) { log("hook error", e.message); }
    };
  } catch (e) { log("cannot hook localStorage"); }

  /* ---------- перехват формы входа: сначала сервер, потом сайт ---------- */
  document.addEventListener(
    "submit",
    function (e) {
      var f = e.target;
      if (!f || f.id !== "loginForm") return;
      if (f.dataset.slimBypass === "1") { f.dataset.slimBypass = ""; return; }

      var idEl = document.getElementById("loginId");
      var passEl = document.getElementById("loginPass");
      var login = idEl ? idEl.value : "";
      var pass = passEl ? passEl.value : "";
      var map = readUsers();
      var known = !!map[digits(login)];

      if (known && !navigator.onLine) return;   /* офлайн - пусть работает локально */

      e.preventDefault();
      e.stopPropagation();
      badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0430...", "warn");

      api.signIn(login, pass)
        .then(function (res) {
          if (res && res.ok) badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u043e\u043d\u043b\u0430\u0439\u043d", "ok");
          else badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u043b\u043e\u043a\u0430\u043b\u044c\u043d\u043e", "off");
        })
        .catch(function () { badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u043d\u0435\u0442 \u0441\u0432\u044f\u0437\u0438", "off"); })
        .then(function () {
          f.dataset.slimBypass = "1";
          f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        });
    },
    true
  );

  /* ---------- старт: есть сессия -> подтянуть профиль и начисления ---------- */
  function boot() {
    badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u0435...", "warn");
    sb.auth
      .getSession()
      .then(function (r) {
        var s = r && r.data ? r.data.session : null;
        api.ready = true;
        if (!s) { badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u0433\u043e\u0442\u043e\u0432 \u043a \u0432\u0445\u043e\u0434\u0443", "warn"); return null; }
        api.uid = s.user.id;
        api.online = true;
        return (CFG.serverAccruals === false ? Promise.resolve(null) : api.claimAccruals())
          .then(function () { return api.pull({ session: true }); })
          .then(function (u) {
            badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u043e\u043d\u043b\u0430\u0439\u043d", "ok");
            if (u && window.SLIM_HOOKS && window.SLIM_HOOKS.reload) window.SLIM_HOOKS.reload(u);
            return u;
          });
      })
      .catch(function (err) {
        api.error = err && err.message;
        badge("\u0421\u0435\u0440\u0432\u0435\u0440: \u043e\u0444\u043b\u0430\u0439\u043d", "off");
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  /* сохранить при закрытии вкладки */
  window.addEventListener("beforeunload", function () {
    if (!api.uid || !syncTimer) return;
    clearTimeout(syncTimer);
    var map = readUsers();
    var u = map[pendingId || api.loginId];
    if (u) api.push(u);
  });
})();

/* =====================================================================
 * Связка с интерфейсом сайта: промокоды и юзернеймы через сервер
 * ===================================================================== */
(function () {
  "use strict";
  var CFG = window.SLIM_SUPABASE || {};
  var srv = window.SlimServer;
  if (!srv || !srv.client) return;

  function hint(text, kind) {
    var el = document.getElementById("pmHint");
    if (!el) return;
    el.textContent = text;
    el.style.color = kind === "ok" ? "#31d0aa" : kind === "err" ? "#ff6b7d" : "";
  }

  function wire() {
    var hooks = window.SLIM_HOOKS;
    if (!hooks) return setTimeout(wire, 500);

    /* промокоды: сервер решает, сколько начислить и не был ли код уже использован */
    if (CFG.serverPromos !== false) {
      hooks.promoServer = function (raw) {
        if (!srv.online) { hint("\u041d\u0435\u0442 \u0441\u0432\u044f\u0437\u0438 \u0441 \u0441\u0435\u0440\u0432\u0435\u0440\u043e\u043c, \u043a\u043e\u0434 \u043f\u0440\u043e\u0432\u0435\u0440\u0435\u043d \u043b\u043e\u043a\u0430\u043b\u044c\u043d\u043e", ""); return false; }
        hint("\u041f\u0440\u043e\u0432\u0435\u0440\u044f\u0435\u043c \u043a\u043e\u0434...", "");
        srv.redeemPromo(raw).then(function (r) {
          if (!r || !r.ok) {
            var e = r && r.error;
            hint(
              e === "used" ? "\u042d\u0442\u043e\u0442 \u043a\u043e\u0434 \u0443\u0436\u0435 \u0430\u043a\u0442\u0438\u0432\u0438\u0440\u043e\u0432\u0430\u043d" :
              e === "limit" ? "\u041b\u0438\u043c\u0438\u0442 \u0430\u043a\u0442\u0438\u0432\u0430\u0446\u0438\u0439 \u0438\u0441\u0447\u0435\u0440\u043f\u0430\u043d" :
              "\u041a\u043e\u0434 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d",
              "err"
            );
            return;
          }
          var money = Number(r.money || 0);
          if (money > 0 && hooks.credit) hooks.credit(money, "\u041f\u0440\u043e\u043c\u043e\u043a\u043e\u0434 " + r.code, r.note || "");
          else srv.pull({ session: false }).then(function (u) { if (u && hooks.reload) hooks.reload(u); });
          hint("\u041a\u043e\u0434 " + r.code + " \u0430\u043a\u0442\u0438\u0432\u0438\u0440\u043e\u0432\u0430\u043d" + (r.note ? ": " + r.note : ""), "ok");
          var inp = document.getElementById("pmInput");
          if (inp) inp.value = "";
        });
        return true;
      };
    }

    /* свободен ли юзернейм — проверка по общей базе всех игроков */
    hooks.usernameCheck = function (name) { return srv.usernameFree(name); };

    var save = document.getElementById("unSave");
    if (save && !save.dataset.slimWired) {
      save.dataset.slimWired = "1";
      save.addEventListener("click", function () {
        var inp = document.getElementById("unInput");
        if (!inp || !srv.online) return;
        setTimeout(function () { srv.claimUsername(inp.value || ""); }, 400);
      });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
