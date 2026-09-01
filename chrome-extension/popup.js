// popup.js
const $ = id => document.getElementById(id);
let editingId = "";

function send(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

// Tab 切换
document.querySelectorAll(".tab").forEach(t => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x === t));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.add("hidden"));
    $("tab-" + t.dataset.tab).classList.remove("hidden");
    if (t.dataset.tab === "logs") loadLogs();
    if (t.dataset.tab === "settings") loadSettings();
  });
});

// 加载站点列表
async function loadSites() {
  const d = await send({ action: "getSites" });
  const sites = d.sites || [];
  $("siteCount").textContent = "(" + sites.length + ")";
  const el = $("siteList");
  if (!sites.length) { el.innerHTML = '<p class="muted">还没有站点，在下方添加</p>'; return; }
  el.innerHTML = sites.map(s => {
    const statusTag = s.enabled === false ? '<span class="tag off">已停用</span>' : '';
    return '<div class="site-item">' +
      '<div><div class="site-name">' + s.name + statusTag + '</div>' +
      '<div class="site-url">' + s.base_url + (s.user_id ? ' · ID:' + s.user_id : '') + '</div></div>' +
      '<div class="site-actions">' +
      '<button class="ghost" data-checkin="' + s.id + '">签到</button>' +
      '<button class="ghost" data-edit="' + s.id + '">编辑</button>' +
      '<button class="danger" data-del="' + s.id + '">删</button>' +
      '</div></div>';
  }).join("");
}

// 编辑
function fillForm(s) {
  editingId = s.id;
  $("addForm").name.value = s.name;
  $("addForm").base_url.value = s.base_url;
  $("addForm").token.value = s.token;
  $("addForm").user_id.value = s.user_id || "";
  $("formTitle").textContent = "编辑站点：" + s.name;
  $("submitBtn").textContent = "保存修改";
  $("cancelEdit").classList.remove("hidden");
}
function cancelEdit() {
  editingId = "";
  $("addForm").reset();
  $("formTitle").textContent = "添加站点";
  $("submitBtn").textContent = "添加站点";
  $("cancelEdit").classList.add("hidden");
}
$("cancelEdit").addEventListener("click", cancelEdit);

// 表单提交
$("addForm").addEventListener("submit", async e => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(e.target).entries());
  fd.base_url = fd.base_url.trim().replace(/\/+$/, "");
  fd.token = fd.token.trim();
  fd.user_id = fd.user_id.trim();
  const wasEdit = !!editingId;
  let d;
  if (editingId) {
    d = await send({ action: "updateSite", id: editingId, site: fd });
  } else {
    d = await send({ action: "addSite", site: fd });
  }
  if (d.ok) {
    cancelEdit();
    loadSites();
  } else {
    alert("操作失败：" + (d.error || "未知错误"));
  }
});

// 事件委托
document.addEventListener("click", async e => {
  if (e.target.matches("[data-del]")) {
    if (!confirm("确定删除这个站点？")) return;
    await send({ action: "deleteSite", id: e.target.dataset.del });
    if (editingId === e.target.dataset.del) cancelEdit();
    loadSites();
  }
  if (e.target.matches("[data-edit]")) {
    const d = await send({ action: "getSites" });
    const s = (d.sites || []).find(x => x.id === e.target.dataset.edit);
    if (s) fillForm(s);
  }
  if (e.target.matches("[data-checkin]")) {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = "...";
    const d = await send({ action: "checkinOne", id: btn.dataset.checkin });
    btn.disabled = false;
    btn.textContent = "签到";
    if (d.result) {
      const r = d.result;
      alert(r.success ? ("✅ 签到成功！获得 " + fmt(r.gained) + (r.remain != null ? "，余额 " + fmt(r.remain) : "")) : ("❌ 签到失败：" + r.message));
    } else {
      alert("签到失败：" + (d.error || "未知错误"));
    }
  }
});

// 全部签到
$("runAllBtn").addEventListener("click", async () => {
  if (!confirm("立即签到全部站点？")) return;
  $("runAllBtn").disabled = true;
  $("runAllBtn").textContent = "签到中...";
  const d = await send({ action: "runAll" });
  $("runAllBtn").disabled = false;
  $("runAllBtn").textContent = "全部签到";
  if (d.results) {
    const ok = d.results.filter(r => r.success).length;
    alert("签到完成：成功 " + ok + "，失败 " + (d.results.length - ok));
  }
});

// 记录
async function loadLogs() {
  const d = await send({ action: "getLogs" });
  const logs = d.logs || [];
  const el = $("logList");
  if (!logs.length) { el.innerHTML = '<p class="muted">暂无记录</p>'; return; }
  el.innerHTML = logs.slice(0, 50).map(l => {
    const t = new Date(l.time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const icon = l.success ? "✅" : "❌";
    const gain = l.success && l.gained ? " +" + fmt(l.gained) : "";
    const remain = l.remain != null ? " 余额:" + fmt(l.remain) : "";
    return '<div class="log-item">' + icon + ' ' + l.name + gain + remain +
      '<div class="log-time">' + t + (l.success ? "" : " · " + l.message) + '</div></div>';
  }).join("");
}

// 设置
async function loadSettings() {
  const s = await send({ action: "getSettings" });
  $("tg_token").value = s.tg_bot_token || "";
  $("tg_chat").value = s.tg_chat_id || "";
  $("tg_enabled").checked = !!s.tg_enabled;
}
$("saveSettings").addEventListener("click", async () => {
  await send({
    action: "saveSettings",
    settings: { tg_bot_token: $("tg_token").value.trim(), tg_chat_id: $("tg_chat").value.trim(), tg_enabled: $("tg_enabled").checked }
  });
  alert("已保存");
});
$("testTG").addEventListener("click", async () => {
  await send({ action: "saveSettings", settings: { tg_bot_token: $("tg_token").value.trim(), tg_chat_id: $("tg_chat").value.trim(), tg_enabled: $("tg_enabled").checked } });
  const d = await send({ action: "testTG" });
  alert(d.ok ? "测试消息已发送" : "发送失败，请检查 Token 和 Chat ID");
});

// 下次签到时间
async function loadNextTime() {
  const d = await send({ action: "getNextTime" });
  if (d.next && d.next !== "未设置") $("nextTime").textContent = "下次: " + d.next;
}

function fmt(n) { return Number(n || 0).toLocaleString(); }

// 初始化
loadSites();
loadNextTime();
