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
const fmt = n => Number(n || 0).toLocaleString();
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

// ---------- 方式2：浏览器标签页（cookie 认证，过 Turnstile/WAF）----------
async function checkinByTab(site) {
  const base = site.base_url.replace(/\/+$/, "");
  let tab;
  try {
    tab = await chrome.tabs.create({ url: base + "/console", active: false });
    await sleep(4000);
    // 注入脚本：自动从 localStorage 读 token，cookie + token 双重认证
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (savedToken, userId) => {
        try {
          // 优先用保存的 token，没有就从 localStorage 读
          let token = savedToken;
          if (!token) {
            try {
              const u = JSON.parse(localStorage.getItem("user") || "{}");
              token = u.token || "";
            } catch (e) {}
          }
          const headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/plain, */*",
            "X-Requested-With": "XMLHttpRequest",
          };
          if (token) headers["Authorization"] = "Bearer " + token;
          if (userId) headers["new-api-user"] = String(userId);
          const r = await fetch("/api/user/checkin", { method: "POST", headers, credentials: "include" });
          const text = await r.text();
          let d = {};
          try { d = JSON.parse(text); } catch (e) {}
          return { status: r.status, success: !!d.success, gained: d.data || 0, message: d.message || ("HTTP " + r.status) };
        } catch (e) {
          return { success: false, message: String(e) };
        }
      },
      args: [site.token || "", site.user_id || ""],
    });
    const r = result.result;
    // 查询余额
    let remain = null;
    if (r.success) {
      try {
        const [q] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (savedToken, userId) => {
            let token = savedToken;
            if (!token) {
              try {
                const u = JSON.parse(localStorage.getItem("user") || "{}");
                token = u.token || "";
              } catch (e) {}
            }
            const headers = { "Accept": "application/json" };
            if (token) headers["Authorization"] = "Bearer " + token;
            if (userId) headers["new-api-user"] = String(userId);
            const r = await fetch("/api/user/self", { headers, credentials: "include" });
            const d = await r.json();
            if (d.success && d.data) return { remain: Number(d.data.quota || 0) - Number(d.data.used_quota || 0) };
            return null;
          },
          args: [site.token || "", site.user_id || ""],
        });
        if (q.result) remain = q.result.remain;
      } catch (e) {}
    }
    return { success: r.success, gained: r.gained, message: r.message, remain, viaBrowser: true };
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
      func: async () => {
        try {
          // NewAPI 登录态存在 localStorage 的 user 对象里
          let token = "", lsId = null, lsName = "";
          const userStr = localStorage.getItem("user");
          if (userStr) {
            try {
              const u = JSON.parse(userStr);
              token = u.token || "";
              lsId = u.id || null;
              lsName = u.username || u.display_name || "";
            } catch (e) {}
          }
          const headers = { "Accept": "application/json" };
          if (token) headers["Authorization"] = "Bearer " + token;
          const r = await fetch("/api/user/self", { credentials: "include", headers });
          const d = await r.json();
          if (d.success && d.data) {
            return {
              ok: true,
              base_url: location.origin,
              user_id: d.data.id || lsId,
              username: d.data.username || d.data.display_name || lsName,
              token: token,
            };
          }
          return { ok: false, message: d.message || "未登录或不是 NewAPI 站点" };
        } catch (e) {
          return { ok: false, message: "请求失败: " + String(e) };
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
  // 有 token 时先尝试直接 fetch（快），没有 token 直接用标签页 cookie 模式
  if (site.token) {
    let r = await checkinByFetch(site);
    if (!r.needBrowser) {
      if (r.success) {
        try {
          const base = site.base_url.replace(/\/+$/, "");
          const resp = await fetch(base + "/api/user/self", { headers: buildHeaders(site) });
          const d = await resp.json();
          if (d.success && d.data) r.remain = Number(d.data.quota || 0) - Number(d.data.used_quota || 0);
        } catch (e) {}
      }
      return { id: site.id, name: site.name, ...r };
    }
  }
  // 标签页模式（cookie 认证，可过 Turnstile/WAF）
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
    await addLog({ time: new Date().toISOString(), site: r.name, success: r.success, message: r.message, gained: r.gained, remain: r.remain, manual });
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
    const gain = r.success && r.gained ? "+" + fmt(r.gained) : "";
    const remain = r.remain != null ? "余额:" + fmt(r.remain) : "";
    msg += icon + " " + mask(r.name) + " " + gain + " " + remain + "\n";
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
          await addLog({ time: new Date().toISOString(), site: r.name, success: r.success, message: r.message, gained: r.gained, remain: r.remain, manual: true });
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
