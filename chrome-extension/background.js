// ============================================================
// NewAPI 多站自动签到 · Chrome 扩展 background
// ============================================================

const STORAGE_KEY = "nac_sites";
const SETTINGS_KEY = "nac_settings";
const LOG_KEY = "nac_logs";
const LAST_DATE_KEY = "nac_last_date";

// 今天的日期（北京时间）
function todayBJ() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
async function isCheckedToday() {
  const d = await chrome.storage.local.get(LAST_DATE_KEY);
  return d[LAST_DATE_KEY] === todayBJ();
}
async function markCheckedToday() {
  await chrome.storage.local.set({ [LAST_DATE_KEY]: todayBJ() });
}

// ---------- 存储 ----------
async function getSites() {
  const d = await chrome.storage.local.get(STORAGE_KEY);
  return d[STORAGE_KEY] || [];
}
async function saveSites(sites) {
  await chrome.storage.local.set({ [STORAGE_KEY]: sites });
}
async function getSettings() {
  const d = await chrome.storage.local.get(SETTINGS_KEY);
  return d[SETTINGS_KEY] || { tg_bot_token: "", tg_chat_id: "", tg_enabled: false, random_hour: true };
}
async function saveSettings(s) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: s });
}
async function addLog(entry) {
  const d = await chrome.storage.local.get(LOG_KEY);
  const logs = d[LOG_KEY] || [];
  logs.unshift(entry);
  if (logs.length > 200) logs.length = 200;
  await chrome.storage.local.set({ [LOG_KEY]: logs });
}

// ---------- 工具 ----------
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const mask = n => n.length > 3 ? n.slice(0, 3) + "***" : n + "***";
const fmt = n => {
  const v = Number(n || 0);
  const d = Math.abs(v) >= 1 ? 2 : 4;
  return v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: d });
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 请求头 ----------
function buildHeaders(site) {
  const origin = site.base_url.replace(/\/+$/, "");
  const h = {
    "Authorization": "Bearer " + site.token,
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "Origin": origin,
    "Referer": origin + "/console",
    "X-Requested-With": "XMLHttpRequest",
  };
  if (site.user_id) h["new-api-user"] = String(site.user_id);
  return h;
}

// ---------- 方式1：直接 fetch ----------
async function checkinByFetch(site) {
  const url = site.base_url.replace(/\/+$/, "") + "/api/user/checkin";
  try {
    const r = await fetch(url, { method: "POST", headers: buildHeaders(site) });
    const text = await r.text();
    let d = {};
    try { d = JSON.parse(text); } catch (e) {}
    // 检测 Cloudflare 拦截页或 Turnstile 要求
    if (r.status === 403 || text.includes("Attention Required") || text.includes("cf-turnstile") || (d.message && d.message.includes("Turnstile"))) {
      return { needBrowser: true, raw: text.slice(0, 200) };
    }
    return { success: !!d.success, gained: d.data || 0, message: d.message || ("HTTP " + r.status) };
  } catch (e) {
    return { needBrowser: true, message: String(e) };
  }
}

// 等待标签页加载完成且 URL 稳定（应对 /console → /dashboard 重定向，避免 Frame removed）
async function waitTabStable(tabId) {
  await new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; try { chrome.tabs.onUpdated.removeListener(onUp); } catch (e) {} resolve(); } };
    const onUp = (id, info) => { if (id === tabId && info.status === "complete") setTimeout(fin, 1200); };
    chrome.tabs.onUpdated.addListener(onUp);
    setTimeout(fin, 15000);
  });
  let last = "", n = 0;
  for (let i = 0; i < 15; i++) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    const u = t ? t.url : "";
    if (u === last && /^https?:/.test(u)) { if (++n >= 2) break; } else n = 0;
    last = u;
    await sleep(700);
  }
  await sleep(1500); // 等 SPA 初始化
}

// 带重试的 MAIN world 注入（页面重定向会导致 Frame removed，自动重试）
async function injectWithRetry(tabId, func, args) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func, args });
      return r.result;
    } catch (e) {
      lastErr = e;
      if (/removed|frame|context|destroyed|cannot read/i.test(String(e)) && attempt < 2) { await sleep(2000); continue; }
      throw e;
    }
  }
  throw lastErr;
}

// ---------- 方式2：浏览器标签页（cookie 认证，过 Turnstile/WAF）----------
async function checkinByTab(site) {
  const base = site.base_url.replace(/\/+$/, "");
  let tab;
  try {
    // 打开同源控制台页（自动带 httpOnly cookie；新版会重定向到 /dashboard）
    tab = await chrome.tabs.create({ url: base + "/console", active: false });
    await waitTabStable(tab.id);
    // MAIN world 注入：与页面共享 window（turnstile 必须在主世界），带重定向重试
    const result = await injectWithRetry(tab.id, async (savedToken) => {
        const jget = async (url, opt) => {
          const r = await fetch(url, opt);
          return { status: r.status, text: await r.text() };
        };
        try {
          // ---------- 1. 获取访问令牌 ----------
          let token = savedToken || "";
          if (!token) {
            for (const store of [localStorage, sessionStorage]) {
              for (let i = 0; i < store.length; i++) {
                try {
                  const o = JSON.parse(store.getItem(store.key(i)));
                  if (o && o.token) { token = o.token; break; }
                } catch (e) {}
              }
              if (token) break;
            }
          }
          if (!token) {
            // 新版 NewAPI：httpOnly cookie + /api/user/auth/refresh 换 15 分钟 JWT
            try {
              const rr = await jget("/api/user/auth/refresh", {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" }, body: "{}",
              });
              const rj = JSON.parse(rr.text);
              if (rj.data && rj.data.access_token) token = rj.data.access_token;
            } catch (e) {}
          }
          if (!token) return { success: false, message: "未登录或登录已过期，请在浏览器里重新登录该站点" };

          const authH = () => ({
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "Accept": "application/json, text/plain, */*",
          });

          // ---------- 2. 读取站点配置，判断是否需要 Turnstile、取额度换算单位 ----------
          let needTs = false, siteKey = "", unit = 500000;
          try {
            const sr = await jget("/api/status", { credentials: "include" });
            const sd = JSON.parse(sr.text).data || {};
            needTs = !!sd.turnstile_check;
            siteKey = sd.turnstile_site_key || "";
            if (Number(sd.quota_per_unit) > 0) unit = Number(sd.quota_per_unit);
          } catch (e) {}

          // ---------- 3. 需要人机验证时，在页面内渲染 Turnstile 拿 token ----------
          let tsToken = "", tsStage = "";
          if (needTs) {
            if (!siteKey) return { success: false, message: "站点开启了人机验证但未返回 sitekey" };
            // 后台标签页会被浏览器标记为 hidden，Turnstile 可能因此不自动执行；伪装为可见
            try {
              const visDef = { get: () => "visible", configurable: true };
              const hidDef = { get: () => false, configurable: true };
              Object.defineProperty(document, "visibilityState", visDef);
              Object.defineProperty(document, "webkitVisibilityState", visDef);
              Object.defineProperty(document, "hidden", hidDef);
              Object.defineProperty(document, "webkitHidden", hidDef);
              document.hasFocus = () => true;
              window.dispatchEvent(new Event("visibilitychange"));
            } catch (e) {}
            const tsOutcome = await new Promise((resolve) => {
              let settled = false;
              const done = (token, stage) => { if (!settled) { settled = true; resolve({ token, stage }); } };
              const timer = setTimeout(() => done("", "timeout"), 24000);
              let rendered = false;
              const doRender = () => {
                if (rendered || !window.turnstile) return;
                rendered = true;
                try {
                  const old = document.querySelector("[data-nac-box]");
                  if (old) old.remove();
                  const box = document.createElement("div");
                  box.setAttribute("data-nac-box", "1");
                  // 放在视口内（移出屏幕会被 IntersectionObserver 判为不可见而不执行），近乎透明
                  box.style.cssText = "position:fixed;right:0;bottom:0;width:300px;height:70px;opacity:0.01;z-index:2147483647;pointer-events:none;";
                  document.body.appendChild(box);
                  const opts = {
                    sitekey: siteKey,
                    callback: (t) => { clearTimeout(timer); done(t, "ok"); },
                    "error-callback": () => { clearTimeout(timer); done("", "error"); },
                    "timeout-callback": () => { clearTimeout(timer); done("", "timeout"); },
                  };
                  // turnstile.ready 保证内部就绪后再 render，避免 render 时未初始化
                  if (typeof window.turnstile.ready === "function") window.turnstile.ready(() => {
                    try { window.turnstile.render(box, opts); } catch (e) { clearTimeout(timer); done("", "render_error"); }
                  });
                  else { try { window.turnstile.render(box, opts); } catch (e) { clearTimeout(timer); done("", "render_error"); } }
                } catch (e) { clearTimeout(timer); done("", "render_error"); }
              };
              // 已存在（页面自己加载过 turnstile）直接渲染
              if (window.turnstile) { doRender(); return; }
              // 动态加载官方脚本；不依赖 onload 时机（onload 触发时 window.turnstile 可能尚未挂载），
              // 改为加载后轮询等待 window.turnstile 出现，再 ready()->render()
              const old = document.querySelector("script[data-nac-ts],script#cf-turnstile");
              if (old) old.remove();
              const s = document.createElement("script");
              s.id = "cf-turnstile";
              s.setAttribute("data-nac-ts", "1");
              s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
              s.async = true;
              s.onerror = () => { clearTimeout(timer); done("", "script_error"); };
              document.head.appendChild(s);
              const deadline = Date.now() + 12000;
              const waitTs = setInterval(() => {
                if (window.turnstile) { clearInterval(waitTs); doRender(); }
                else if (Date.now() > deadline) { clearInterval(waitTs); clearTimeout(timer); done("", "script_timeout"); }
              }, 80);
            });
            tsToken = tsOutcome.token; tsStage = tsOutcome.stage;
            if (!tsToken) {
              let tip;
              if (tsStage === "script_error") tip = "验证脚本加载失败：浏览器无法连接 challenges.cloudflare.com，请开启代理后重试";
              else if (tsStage === "script_timeout") tip = "验证脚本加载后未初始化：网络无法稳定访问 Cloudflare，请开启代理（与手动签到同一网络）后重试";
              else if (tsStage === "render_error") tip = "人机验证组件渲染异常，请刷新站点页面后重试";
              else if (tsStage === "timeout") tip = "人机验证超时：多半是网络无法访问 Cloudflare 验证服务，请开启代理（与手动签到同一网络）后重试";
              else tip = "人机验证未通过（" + tsStage + "），请确认网络可访问 Cloudflare 后重试";
              return { success: false, message: tip, tsStage };
            }
          }

          // ---------- 4. 签到（turnstile 通过 URL query 传递）----------
          const url = "/api/user/checkin" + (tsToken ? "?turnstile=" + encodeURIComponent(tsToken) : "");
          const cr = await jget(url, { method: "POST", credentials: "include", headers: authH() });
          let cd = {};
          try { cd = JSON.parse(cr.text); } catch (e) {}
          let message = cd.message || ("HTTP " + cr.status);
          // “今日已签到/重复签到”视为成功（今天的签到目标已达成），不算失败
          const already = !cd.success && /已签到|已经签|重复签|already|checked/i.test(message);
          const success = !!cd.success || already;
          if (already) message = "今日已签到";

          // ---------- 5. 查询余额（按站点 quota_per_unit 换算成页面显示的额度单位）----------
          let remain = null;
          try {
            const q = await jget("/api/user/self", { credentials: "include", headers: authH() });
            const qd = JSON.parse(q.text);
            if (qd.success && qd.data) remain = (Number(qd.data.quota || 0) - Number(qd.data.used_quota || 0)) / unit;
          } catch (e) {}

          // 本次签到奖励同样换算单位
          const gained = (Number(cd.data) || 0) / unit;
          return { success, already, gained, message, remain };
        } catch (e) {
          return { success: false, message: String(e) };
        }
      }, [site.token || ""]);
    return { ...result, viaBrowser: true };
  } catch (e) {
    return { success: false, message: "标签页签到失败: " + String(e), viaBrowser: true };
  } finally {
    if (tab) try { await chrome.tabs.remove(tab.id); } catch (e) {}
  }
}

// ---------- 检测当前页面是否为 NewAPI 站点并提取信息 ----------
async function detectSite(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async () => {
        try {
          // 通用取 token：① localStorage/sessionStorage 长期 token（旧版）
          // ② POST /api/user/auth/refresh 换临时 JWT（新版 httpOnly cookie 机制）
          async function obtainToken() {
            // 1. 遍历 localStorage / sessionStorage
            for (const store of [localStorage, sessionStorage]) {
              for (let i = 0; i < store.length; i++) {
                const v = store.getItem(store.key(i));
                if (!v) continue;
                try {
                  const obj = JSON.parse(v);
                  if (obj && obj.token) return { token: obj.token, source: "storage" };
                } catch (e) {}
              }
            }
            // 2. refresh token 换取（依赖 httpOnly cookie，credentials 自动带）
            try {
              const rr = await fetch("/api/user/auth/refresh", {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              });
              const rj = await rr.json();
              if (rj && rj.data && rj.data.access_token) return { token: rj.data.access_token, source: "refresh" };
            } catch (e) {}
            return { token: "", source: "none" };
          }

          const got = await obtainToken();
          // 第一次：带 token 请求；失败则第二次去掉 Authorization 纯 cookie 再试
          let r, d = {};
          const trySelf = async (useToken) => {
            const h = { "Accept": "application/json" };
            if (useToken && got.token) h["Authorization"] = "Bearer " + got.token;
            const resp = await fetch("/api/user/self", { credentials: "include", headers: h });
            const text = await resp.text();
            let j = {};
            try { j = JSON.parse(text); } catch (e) {}
            return { resp, j };
          };
          let first = await trySelf(true);
          r = first.resp; d = first.j;
          if (!(d.success && d.data) && got.token) {
            const second = await trySelf(false);
            if (second.j && second.j.success) { r = second.resp; d = second.j; }
          }

          if (d.success && d.data) {
            return {
              ok: true,
              base_url: location.origin,
              user_id: d.data.id,
              username: d.data.username || d.data.display_name || "",
              // 仅旧版本地长期令牌才保存；refresh 得到的临时 JWT 15分钟过期，不保存
              token: got.source === "storage" ? got.token : "",
              authSource: got.source,
            };
          }
          const lsKeys = [];
          for (let i = 0; i < localStorage.length; i++) lsKeys.push(localStorage.key(i));
          return {
            ok: false,
            message: "接口返回: " + (d.message || ("HTTP " + r.status)),
            debug: { status: r.status, tokenSource: got.source, lsKeys: lsKeys.slice(0, 20) },
          };
        } catch (e) {
          return { ok: false, message: "请求异常: " + String(e) };
        }
      },
    });
    return result.result;
  } catch (e) {
    return { ok: false, message: "无法注入页面: " + String(e) };
  }
}

// ---------- 签到单个站点 ----------
async function checkinOne(site) {
  // 统一走标签页模式：真实浏览器环境，兼容 长期token / localStorage / refresh-JWT，
  // 并能在页面内完成 Turnstile 人机验证、绕过 WAF
  const r = await checkinByTab(site);
  return { id: site.id, name: site.name, ...r };
}

// ---------- 签到全部 ----------
async function runAll(manual = false) {
  const sites = (await getSites()).filter(s => s.enabled !== false);
  if (!sites.length) return { results: [] };
  const results = [];
  for (let i = 0; i < sites.length; i++) {
    if (i > 0) await sleep(3000 + Math.floor(Math.random() * 12000));
    const r = await checkinOne(sites[i]);
    results.push(r);
    await addLog({ time: new Date().toISOString(), name: r.name, success: r.success, already: r.already, message: r.message, gained: r.gained, remain: r.remain, manual });
  }
  // 推送 Telegram
  const settings = await getSettings();
  if (settings.tg_enabled && settings.tg_bot_token && settings.tg_chat_id) {
    await sendTG(settings, buildReport(results));
  }
  // 更新 badge
  updateBadge(results);
  // 自动签到后标记今天已签（手动签到不标记，方便反复测试）
  if (!manual) await markCheckedToday();
  return { results };
}

// ---------- Telegram ----------
async function sendTG(settings, text) {
  try {
    await fetch("https://api.telegram.org/bot" + settings.tg_bot_token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: settings.tg_chat_id, text, disable_web_page_preview: true }),
    });
  } catch (e) { console.error("TG 发送失败", e); }
}

function buildReport(results) {
  const ok = results.filter(r => r.success).length;
  const date = new Date().toISOString().slice(0, 10);
  let msg = "📋 签到报告 " + date + "\n";
  msg += "共 " + results.length + " 站，成功 " + ok + "，失败 " + (results.length - ok) + "\n\n";
  results.forEach(r => {
    const icon = r.success ? "✅" : "❌";
    const state = r.already ? "今日已签" : ((r.success && r.gained) ? "+" + fmt(r.gained) : "");
    const remain = r.remain != null ? "余额:" + fmt(r.remain) : "";
    msg += icon + " " + mask(r.name || "站点") + " " + state + " " + remain + "\n";
    if (!r.success) msg += "   ↳ " + r.message + "\n";
  });
  return msg;
}

// ---------- Badge ----------
function updateBadge(results) {
  if (!results.length) return;
  const fail = results.filter(r => !r.success).length;
  if (fail === 0) {
    chrome.action.setBadgeText({ text: "✓" });
    chrome.action.setBadgeBackgroundColor({ color: "#34c759" });
  } else {
    chrome.action.setBadgeText({ text: "✗" + fail });
    chrome.action.setBadgeBackgroundColor({ color: "#ff3b30" });
  }
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 10000);
}

// ---------- 定时：启动时检查 + 每小时兜底 ----------
async function ensureHourlyAlarm() {
  const alarms = await chrome.alarms.getAll();
  if (!alarms.find(a => a.name === "hourly-check")) {
    chrome.alarms.create("hourly-check", { periodInMinutes: 60 });
  }
}

async function tryAutoCheckin(reason) {
  if (await isCheckedToday()) {
    console.log("今天已签到，跳过（" + reason + "）");
    return false;
  }
  const sites = (await getSites()).filter(s => s.enabled !== false);
  if (!sites.length) return false;
  console.log("开始自动签到（" + reason + "）");
  await runAll(false);
  return true;
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "hourly-check") {
    await tryAutoCheckin("每小时兜底");
  }
});

// 安装时初始化
chrome.runtime.onInstalled.addListener(async () => {
  await ensureHourlyAlarm();
});

// 浏览器启动时：延迟 30~180 秒后检查今天是否已签，没签就自动签
chrome.runtime.onStartup.addListener(async () => {
  await ensureHourlyAlarm();
  const delay = 30000 + Math.floor(Math.random() * 150000); // 30~180秒
  console.log("浏览器启动，" + Math.round(delay / 1000) + "秒后检查签到");
  setTimeout(async () => {
    await tryAutoCheckin("浏览器启动");
  }, delay);
});

// ---------- 消息监听（与 popup 通信）----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.action) {
        case "getSites":
          sendResponse({ sites: await getSites() });
          break;
        case "detectSite": {
          const info = await detectSite(msg.tabId);
          sendResponse(info);
          break;
        }
        case "addSite": {
          const sites = await getSites();
          const dup = sites.find(s => s.base_url === msg.site.base_url && String(s.user_id || "") === String(msg.site.user_id || ""));
          if (dup) { sendResponse({ error: "该站点（网址+用户ID）已存在" }); break; }
          // 名称兜底：没填就用域名
          if (!msg.site.name || !msg.site.name.trim()) {
            try { msg.site.name = new URL(msg.site.base_url).hostname.replace(/^www\./, ""); } catch (e) { msg.site.name = "站点"; }
          }
          msg.site.id = uid();
          msg.site.enabled = true;
          sites.push(msg.site);
          await saveSites(sites);
          sendResponse({ ok: true });
          break;
        }
        case "updateSite": {
          const sites = await getSites();
          const i = sites.findIndex(s => s.id === msg.id);
          if (i < 0) { sendResponse({ error: "站点不存在" }); break; }
          const dup = sites.find(s => s.id !== msg.id && s.base_url === msg.site.base_url && String(s.user_id || "") === String(msg.site.user_id || ""));
          if (dup) { sendResponse({ error: "该站点（网址+用户ID）已存在" }); break; }
          sites[i] = { ...sites[i], ...msg.site };
          await saveSites(sites);
          sendResponse({ ok: true });
          break;
        }
        case "deleteSite": {
          const sites = (await getSites()).filter(s => s.id !== msg.id);
          await saveSites(sites);
          sendResponse({ ok: true });
          break;
        }
        case "toggleSite": {
          const sites = await getSites();
          const s = sites.find(x => x.id === msg.id);
          if (s) { s.enabled = !s.enabled; await saveSites(sites); }
          sendResponse({ ok: true });
          break;
        }
        case "checkinOne": {
          const sites = await getSites();
          const site = sites.find(s => s.id === msg.id);
          if (!site) { sendResponse({ error: "站点不存在" }); break; }
          const r = await checkinOne(site);
          await addLog({ time: new Date().toISOString(), name: r.name, success: r.success, already: r.already, message: r.message, gained: r.gained, remain: r.remain, manual: true });
          sendResponse({ ok: true, result: r });
          break;
        }
        case "runAll": {
          const r = await runAll(true);
          sendResponse({ ok: true, results: r.results });
          break;
        }
        case "getSettings":
          sendResponse(await getSettings());
          break;
        case "saveSettings":
          await saveSettings(msg.settings);
          sendResponse({ ok: true });
          break;
        case "testTG": {
          const settings = await getSettings();
          await sendTG(settings, "✅ NewAPI 签到测试消息\n如果你看到这条，说明 Telegram 配置成功。");
          sendResponse({ ok: true });
          break;
        }
        case "getLogs": {
          const d = await chrome.storage.local.get(LOG_KEY);
          sendResponse({ logs: d[LOG_KEY] || [] });
          break;
        }
        case "getNextTime": {
          const done = await isCheckedToday();
          sendResponse({ next: done ? "今日已签到 ✓" : "今日待签（打开浏览器后自动）" });
          break;
        }
        default:
          sendResponse({ error: "未知操作" });
      }
    } catch (e) {
      sendResponse({ error: String(e) });
    }
  })();
  return true; // 异步响应
});
