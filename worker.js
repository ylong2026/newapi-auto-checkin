// ============================================================
// NewAPI 多站点自动签到 · Cloudflare Workers 版
// 功能：全天随机时间签到 / 多站点管理 / 余额查询 / Telegram 通知
// ============================================================

const BJ_HOUR_START = 0;
const BJ_HOUR_END   = 23;
const INTERVAL_MIN  = 3000;
const INTERVAL_MAX  = 15000;

// ---------- 工具 ----------
const json = (d, s=200) => new Response(JSON.stringify(d), {status:s, headers:{"Content-Type":"application/json; charset=utf-8"}});
const auth = (r, env) => (r.headers.get("x-admin-token")||"") === env.ADMIN_TOKEN;
const uid = () => Date.now().toString(36)+Math.random().toString(36).slice(2,8);
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const mask = n => n.length>3 ? n.slice(0,3)+"***" : n+"***";
const fmt = n => Number(n||0).toLocaleString();

// ---------- KV ----------
const getSites    = async env => JSON.parse((await env.KV.get("sites"))||"[]");
const saveSites   = async (env,v) => env.KV.put("sites", JSON.stringify(v));
const getSettings = async env => JSON.parse((await env.KV.get("settings"))||"{}");
const saveSettings= async (env,v) => env.KV.put("settings", JSON.stringify(v));
const getToday    = async env => JSON.parse((await env.KV.get("today"))||"null");
const saveToday   = async (env,v) => env.KV.put("today", JSON.stringify(v));

// ---------- NewAPI 交互（仅需 token） ----------
function headers(site) {
  const origin = site.base_url.replace(/\/+$/,"");
  const h = {
    "Authorization": "Bearer " + site.token,
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Origin": origin,
    "Referer": origin + "/console",
    "X-Requested-With": "XMLHttpRequest",
  };
  if (site.user_id) h["new-api-user"] = String(site.user_id);
  return h;
}

async function checkIn(site) {
  const url = site.base_url.replace(/\/+$/,"") + "/api/user/checkin";
  try {
    const r = await fetch(url, {method:"POST", headers:headers(site)});
    const d = await r.json().catch(()=>({}));
    return { id:site.id, name:site.name, success:!!d.success, gained:d.data||0, message:d.message||("HTTP "+r.status) };
  } catch(e) { return { id:site.id, name:site.name, success:false, gained:0, message:String(e) }; }
}

async function getQuota(site) {
  const url = site.base_url.replace(/\/+$/,"") + "/api/user/self";
  try {
    const r = await fetch(url, {headers:headers(site)});
    const d = await r.json().catch(()=>({}));
    if (d.success && d.data) {
      const q = Number(d.data.quota||0);
      const u = Number(d.data.used_quota||0);
      return { remain: q-u, total:q, used:u };
    }
    return null;
  } catch(e) { return null; }
}

// ---------- Telegram ----------
async function sendTG(env, text) {
  const s = await getSettings(env);
  if (!s.tg_enabled || !s.tg_bot_token || !s.tg_chat_id) return false;
  try {
    await fetch("https://api.telegram.org/bot"+s.tg_bot_token+"/sendMessage", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ chat_id:s.tg_chat_id, text:text, disable_web_page_preview:true })
    });
    return true;
  } catch(e) { return false; }
}

function buildReport(results, date) {
  const ok = results.filter(r=>r.success).length;
  let msg = "📋 签到报告 "+date+"\n";
  msg += "共 "+results.length+" 站，成功 "+ok+"，失败 "+(results.length-ok)+"\n\n";
  results.forEach(r => {
    const icon = r.success ? "✅" : "❌";
    const gain = r.success && r.gained ? "+"+fmt(r.gained) : "";
    const remain = r.remain != null ? "余额:"+fmt(r.remain) : "";
    msg += icon+" "+mask(r.name)+" "+gain+" "+remain+"\n";
    if (!r.success) msg += "   ↳ "+r.message+"\n";
  });
  return msg;
}

// ---------- 签到主流程 ----------
async function runCheckIn(env, siteId) {
  const sites = await getSites(env);
  let targets = sites;
  if (siteId) targets = sites.filter(s=>s.id===siteId);
  if (!targets.length) return { skipped:true };

  const results = [];
  for (let i=0;i<targets.length;i++) {
    if (i>0) await sleep(INTERVAL_MIN + Math.floor(Math.random()*(INTERVAL_MAX-INTERVAL_MIN)));
    const r = await checkIn(targets[i]);
    if (r.success) {
      const q = await getQuota(targets[i]);
      if (q) r.remain = q.remain;
    }
    results.push(r);
  }

  if (!siteId) {
    const date = new Date().toISOString().slice(0,10);
    await sendTG(env, buildReport(results, date));
  }
  return { results };
}

// ---------- 定时触发（每小时） ----------
async function handleScheduled(env) {
  const now = new Date();
  const today = now.toISOString().slice(0,10);
  const bjHour = (now.getUTCHours()+8)%24;

  let state = await getToday(env);
  if (!state || state.date !== today) {
    const pool = [];
    for (let h=BJ_HOUR_START; h<=BJ_HOUR_END; h++) pool.push(h);
    state = { date:today, target_bj_hour:pool[Math.floor(Math.random()*pool.length)], done:false, results:[] };
    await saveToday(env, state);
  }
  if (state.done || bjHour !== state.target_bj_hour) return;

  const outcome = await runCheckIn(env, null);
  state.done = true;
  state.results = outcome.results || [];
  state.executed_at = new Date().toISOString();
  await saveToday(env, state);
}

// ---------- 前端页面 ----------
function page() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
'<title>NewAPI 签到管理</title>'+
'<style>'+
'*{box-sizing:border-box;margin:0;padding:0}'+
'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f5f5f7;color:#1d1d1f;padding:12px;max-width:640px;margin:0 auto}'+
'h1{font-size:18px;margin-bottom:10px}'+
'h2{font-size:14px;margin-bottom:8px}'+
'.card{background:#fff;border-radius:12px;padding:12px;margin-bottom:10px;box-shadow:0 1px 3px rgba(0,0,0,.07)}'+
'label{display:block;font-size:12px;font-weight:500;margin-bottom:2px}'+
'.hint{font-size:10.5px;color:#999;font-weight:400;margin-left:4px}'+
'input,textarea,select{width:100%;padding:8px;border:1px solid #ddd;border-radius:8px;font-size:13px;margin-bottom:7px;font-family:inherit}'+
'textarea{resize:vertical;min-height:64px;font-family:monospace;font-size:12px}'+
'button{padding:8px 14px;border:none;border-radius:8px;background:#0071e3;color:#fff;font-size:13px;cursor:pointer}'+
'button:hover{background:#0077ed}'+
'button.danger{background:#ff3b30}'+
'button.ghost{background:#e8e8ed;color:#1d1d1f}'+
'button:disabled{opacity:.5;cursor:not-allowed}'+
'.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}'+
'.tabs{display:flex;gap:4px;margin-bottom:10px;background:#fff;border-radius:10px;padding:4px;box-shadow:0 1px 3px rgba(0,0,0,.07)}'+
'.tab{flex:1;padding:9px;border:none;background:transparent;color:#666;font-size:13px;border-radius:8px;cursor:pointer;font-weight:500}'+
'.tab.active{background:#0071e3;color:#fff}'+
'.site-item{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f0f0f0}'+
'.site-item:last-child{border-bottom:none}'+
'.site-name{font-size:14px;font-weight:500}'+
'.site-url{font-size:11px;color:#999;margin-top:2px}'+
'.dash-card{padding:12px;border:1px solid #eee;border-radius:10px;margin-bottom:8px}'+
'.dash-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}'+
'.dash-name{font-size:14px;font-weight:500}'+
'.dash-meta{font-size:12px;color:#666}'+
'.tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;margin-left:6px}'+
'.ok{background:#e8f5e9;color:#2e7d32}.fail{background:#ffebee;color:#c62828}.wait{background:#fff3e0;color:#e65100}'+
'.hidden{display:none}'+
'.muted{color:#888;font-size:12px}'+
'.bookmarklet{display:inline-block;padding:8px 14px;background:#f0f0f5;border-radius:8px;text-decoration:none;color:#0071e3;font-size:13px;margin:6px 0}'+
'details{margin-top:8px;margin-bottom:8px}'+
'summary{cursor:pointer;font-size:13px;color:#0071e3;padding:4px 0}'+
'.batch-hint{background:#f9f9fb;border-radius:8px;padding:8px 10px;font-size:11px;color:#666;margin-bottom:8px;line-height:1.6}'+
'</style></head><body>'+
'<h1>NewAPI 自动签到管理</h1>'+

// 登录
'<div id="auth" class="card">'+
'  <label>管理密码</label>'+
'  <input type="password" id="pwd" placeholder="输入管理密码，回车即可进入" onkeydown="if(event.key===\'Enter\')login()">'+
'  <div id="loginErr" style="color:#ff3b30;font-size:12px;margin-bottom:8px;display:none">密码错误，请重试</div>'+
'  <button onclick="login()">进入</button>'+
'</div>'+

'<div id="app" class="hidden">'+
// Tab 导航
'<div class="tabs">'+
'  <button class="tab active" data-tab="sites">📋 站点管理</button>'+
'  <button class="tab" data-tab="dashboard">📊 签到看板</button>'+
'  <button class="tab" data-tab="settings">⚙️ 通知设置</button>'+
'</div>'+

// Tab: 站点管理
'<div id="tab-sites" class="tab-content">'+
'  <div class="card">'+
'    <h2>已添加站点 <span id="siteCount" class="muted"></span></h2>'+
'    <div id="siteList"></div>'+
'  </div>'+
'  <div class="card">'+
'    <h2 id="formTitle">添加站点</h2>'+
'    <form id="addForm">'+
'      <label>站点名称 <span class="hint">自己好认就行，如 tabitoken</span></label>'+
'      <input name="name" placeholder="如 tabitoken" required>'+
'      <label>站点网址 <span class="hint">首页地址，末尾不要斜杠</span></label>'+
'      <input name="base_url" placeholder="https://example.com" required>'+
'      <label>系统访问令牌 <span class="hint">头像→个人设置→安全设置→系统访问令牌→生成，复制整串。注意不是左侧「令牌」菜单里调用大模型的 Key</span></label>'+
'      <input name="token" placeholder="粘贴系统访问令牌" required>'+
'      <label>数字用户 ID <span class="hint">个人设置页里的纯数字 ID，和令牌配套，建议填写</span></label>'+
'      <input name="user_id" placeholder="纯数字 ID">'+
'      <div class="row"><button type="submit" id="submitBtn">添加站点</button><button type="button" class="ghost hidden" id="cancelEdit" onclick="cancelEdit()">取消编辑</button></div>'+
'    </form>'+
'    <details style="margin-top:12px"><summary>批量添加 / 一键提取（展开）</summary>'+
'      <div class="batch-hint" style="margin-top:8px">每行一个，英文逗号分隔：<code>名称,网址,系统访问令牌,数字ID</code></div>'+
'      <textarea id="batchInput" placeholder="名称,https://example.com,令牌,12345"></textarea>'+
'      <button onclick="batchAdd()">批量添加</button>'+
'      <div class="batch-hint" style="margin-top:10px">在已登录的目标站点页面点书签，可自动带回信息：<b>先把下方链接拖到浏览器书签栏</b>，再到目标站点页面点它。</div>'+
'      <a id="bm" class="bookmarklet" href="#">一键提取本站信息</a>'+
'    </details>'+
'  </div>'+
'</div>'+

// Tab: 签到看板
'<div id="tab-dashboard" class="tab-content hidden">'+
'  <div class="card">'+
'    <h2>今日概览</h2>'+
'    <div id="todayOverview"></div>'+
'    <div class="row" style="margin-top:10px"><button onclick="manualRun()">立即签到全部</button></div>'+
'  </div>'+
'  <div class="card">'+
'    <h2>各站点状态</h2>'+
'    <div id="dashboardList"></div>'+
'  </div>'+
'</div>'+

// Tab: 通知设置
'<div id="tab-settings" class="tab-content hidden">'+
'  <div class="card">'+
'    <h2>Telegram 通知</h2>'+
'    <label>Bot Token <span class="hint">找 @BotFather 发 /newbot 获取</span></label>'+
'    <input id="tg_token" placeholder="123456:ABC-DEF...">'+
'    <label>Chat ID <span class="hint">找 @userinfobot 点 Start 获取</span></label>'+
'    <input id="tg_chat" placeholder="123456789">'+
'    <div class="row"><label style="margin:0;font-size:13px"><input type="checkbox" id="tg_enabled" style="width:auto;margin-right:6px">启用通知</label></div>'+
'    <div class="row" style="margin-top:8px"><button onclick="saveSettings()">保存</button><button class="ghost" onclick="testTG()">发测试</button></div>'+
'    <p class="muted" style="margin-top:10px;line-height:1.5;font-size:11px">每天北京时间 0~23 点随机一个整点自动签到一次，多站间隔 3~15 秒，结果推送到此。</p>'+
'  </div>'+
'</div>'+

'</div>'+

'<script>'+
'let T=localStorage.getItem("admin_token")||"";'+
'const $=id=>document.getElementById(id);'+
'async function login(){'+
'  const pwd=$("pwd").value.trim();'+
'  if(!pwd){$("loginErr").style.display="block";$("loginErr").textContent="请输入密码";return;}'+
'  T=pwd;'+
'  try{'+
'    const r=await fetch("/api/sites",{headers:{"x-admin-token":T}});'+
'    if(r.status===401){$("loginErr").style.display="block";$("loginErr").textContent="密码错误，请重试";return;}'+
'  }catch(e){$("loginErr").style.display="block";$("loginErr").textContent="网络错误，请刷新重试";return;}'+
'  localStorage.setItem("admin_token",T);'+
'  $("loginErr").style.display="none";'+
'  $("auth").classList.add("hidden");'+
'  $("app").classList.remove("hidden");'+
'  init();'+
'}'+
'if(T){$("auth").classList.add("hidden");$("app").classList.remove("hidden");init();}'+

'async function api(p,o={}){'+
'  const r=await fetch(p,{...o,headers:{...(o.headers||{}),"x-admin-token":T}});'+
'  if(r.status===401){localStorage.removeItem("admin_token");T="";$("app").classList.add("hidden");$("auth").classList.remove("hidden");$("loginErr").style.display="block";$("loginErr").textContent="登录已过期，请重新输入密码";return {};}'+
'  return r.json();'+
'}'+

'function switchTab(name){'+
'  document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t.dataset.tab===name));'+
'  document.querySelectorAll(".tab-content").forEach(c=>c.classList.add("hidden"));'+
'  $("tab-"+name).classList.remove("hidden");'+
'  if(name==="dashboard")loadDashboard();'+
'  if(name==="sites")loadSites();'+
'  if(name==="settings")loadSettings();'+
'}'+

'async function init(){'+
'  try{'+
'  const origin=location.origin;'+
'  $("bm").href="javascript:(function(){try{var t=localStorage.getItem(\'token\')||\'\';var u=JSON.parse(localStorage.getItem(\'user\')||\'{}\');var d=btoa(JSON.stringify({name:location.hostname.split(\'.\')[0],url:location.origin,token:t,userId:u.id||\'\'}));location.href=\'"+origin+"/?import=\'+d;}catch(e){alert(\'提取失败，请先登录站点\');}})();";'+
'  const imp=new URLSearchParams(location.search).get("import");'+
'  if(imp){try{const d=JSON.parse(atob(imp));$("addForm").name.value=d.name||"";$("addForm").base_url.value=d.url||"";$("addForm").token.value=d.token||"";$("addForm").user_id.value=d.userId||"";}catch(e){}}'+
'  document.querySelectorAll(".tab").forEach(t=>t.addEventListener("click",()=>switchTab(t.dataset.tab)));'+
'  loadSites();'+
'  }catch(e){alert("初始化错误:"+e.message);}'+
'}'+

'let editingId="";'+
'async function loadSites(){'+
'  try{'+
'  const d=await api("/api/sites");'+
'  $("siteCount").textContent=d.sites?("("+d.sites.length+")"):"";'+
'  const el=$("siteList");'+
'  if(!d.sites||!d.sites.length){el.innerHTML=\'<p class="muted">还没有站点，在下方添加</p>\';return;}'+
'  el.innerHTML=d.sites.map(s=>\'<div class="site-item"><div><div class="site-name">\'+s.name+\'</div><div class="site-url">\'+s.base_url+(s.user_id?\' · ID:\'+s.user_id:\'\')+\'</div></div><div class="row" style="gap:6px"><button class="ghost" data-edit="\'+s.id+\'" style="padding:6px 12px">编辑</button><button class="danger" data-del="\'+s.id+\'" style="padding:6px 12px">删除</button></div></div>\').join("");'+
'  }catch(e){$("siteList").innerHTML=\'<p style="color:#ff3b30">加载失败:\'+e.message+\'</p>\';}'+
'}'+
'function fillForm(s){editingId=s.id;$("addForm").name.value=s.name;$("addForm").base_url.value=s.base_url;$("addForm").token.value=s.token;$("addForm").user_id.value=s.user_id||"";$("formTitle").textContent="编辑站点："+s.name;$("submitBtn").textContent="保存修改";$("cancelEdit").classList.remove("hidden");window.scrollTo({top:0,behavior:"smooth"});}'+
'function cancelEdit(){editingId="";$("addForm").reset();$("formTitle").textContent="添加站点";$("submitBtn").textContent="添加站点";$("cancelEdit").classList.add("hidden");}'+

'async function batchAdd(){'+
'  const text=$("batchInput").value.trim();'+
'  if(!text){alert("请输入站点信息");return;}'+
'  const lines=text.split("\\n").map(l=>l.trim()).filter(l=>l);'+
'  const sites=[];'+
'  for(const line of lines){'+
'    const parts=line.split(",").map(p=>p.trim());'+
'    if(parts.length>=3&&parts[0]&&parts[1]&&parts[2]){sites.push({name:parts[0],base_url:parts[1],token:parts[2],user_id:parts[3]||""});}'+
'  }'+
'  if(!sites.length){alert("格式不对，每行应为：名称,网址,token");return;}'+
'  const d=await api("/api/sites/batch",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sites})});'+
'  if(d.ok){$("batchInput").value="";loadSites();alert("成功添加 "+sites.length+" 个站点");}'+
'  else{alert("添加失败："+(d.error||"未知错误"));}'+
'}'+

'async function loadDashboard(){'+
'  try{'+
'  const [sites,status]=await Promise.all([api("/api/sites"),api("/api/status")]);'+
'  const list=sites.sites||[];'+
'  const results=(status.state&&status.state.results)||[];'+
'  const el=$("dashboardList");'+
'  if(!list.length){el.innerHTML=\'<p class="muted">还没有站点</p>\';}else{'+
'    el.innerHTML=list.map(s=>{'+
'      const r=results.find(x=>x.name===s.name);'+
'      const done=r?true:false;'+
'      const tag=done?(\'<span class="tag \'+(r.success?\'ok\':\'fail\')+\'">\'+(r.success?\'已签到\':\'失败\')+\'</span>\'):\'<span class="tag wait">未签到</span>\';'+
'      const meta=r?(r.success?(\'+\'+Number(r.gained).toLocaleString()+(r.remain!=null?\'  余额:\'+Number(r.remain).toLocaleString():\'\')):r.message):\'今天还没签到\';'+
'      return \'<div class="dash-card"><div class="dash-head"><span class="dash-name">\'+s.name+tag+\'</span><button data-checkin="\'+s.id+\'">签到</button></div><div class="dash-meta">\'+s.base_url+\' · \'+meta+\'</div></div>\';'+
'    }).join("");'+
'  }'+
'  const ov=$("todayOverview");'+
'  if(!status.state){ov.innerHTML=\'<p class="muted">今天还未生成计划</p>\';}else{'+
'    const st=status.state;'+
'    ov.innerHTML=\'<div class="muted">日期：\'+st.date+\'</div>\'+'+
'      \'<div class="muted">计划时间（北京时间）：\'+st.target_bj_hour+\':00 左右</div>\'+'+
'      \'<div class="muted">状态：\'+(st.done?\'已完成\':\'等待中\')+\'</div>\';'+
'  }'+
'  }catch(e){$("dashboardList").innerHTML=\'<p style="color:#ff3b30">加载失败:\'+e.message+\'</p>\';}'+
'}'+

'async function manualRun(){if(!confirm("立即签到全部站点？"))return;await api("/api/run",{method:"POST"});loadDashboard();}'+
'async function saveSettings(){await api("/api/settings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tg_bot_token:$("tg_token").value,tg_chat_id:$("tg_chat").value,tg_enabled:$("tg_enabled").checked})});alert("已保存");}'+
'async function testTG(){const d=await api("/api/test-tg",{method:"POST"});alert(d.ok?"测试消息已发送":"发送失败，请检查 Token 和 Chat ID");}'+
'async function loadSettings(){try{const d=await api("/api/settings");$("tg_token").value=d.tg_bot_token||"";$("tg_chat").value=d.tg_chat_id||"";$("tg_enabled").checked=!!d.tg_enabled;}catch(e){}}'+

'document.addEventListener("click",async e=>{'+
'  if(e.target.matches("[data-del]")){'+
'    if(confirm("确定删除这个站点？")){await api("/api/sites/"+e.target.dataset.del,{method:"DELETE"});if(editingId===e.target.dataset.del)cancelEdit();loadSites();}'+
'  }'+
'  if(e.target.matches("[data-edit]")){'+
'    const d=await api("/api/sites");const s=(d.sites||[]).find(x=>x.id===e.target.dataset.edit);if(s)fillForm(s);'+
'  }'+
'  if(e.target.matches("[data-checkin]")){'+
'    const btn=e.target;btn.disabled=true;btn.textContent="签到中...";'+
'    const d=await api("/api/checkin/"+btn.dataset.checkin,{method:"POST"});'+
'    const r=(d.outcome&&d.outcome.results&&d.outcome.results[0]);'+
'    if(r){alert(r.success?("✅ 签到成功！获得 "+Number(r.gained||0).toLocaleString()+(r.remain!=null?"，余额 "+Number(r.remain).toLocaleString():"")):("❌ 签到失败："+r.message));}'+
'    loadDashboard();'+
'  }'+
'});'+

'$("addForm").addEventListener("submit",async e=>{e.preventDefault();const fd=Object.fromEntries(new FormData(e.target).entries());const wasEdit=!!editingId;let d;if(editingId){d=await api("/api/sites/"+editingId,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(fd)});}else{d=await api("/api/sites",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(fd)});}if(d.ok){cancelEdit();loadSites();alert(wasEdit?"已保存修改":"添加成功");}else{alert("操作失败："+(d.error||"未知错误"));}});'+
'</script></body></html>';
}

// ---------- API ----------
async function handleApi(request, env) {
  const url = new URL(request.url);
  const p = url.pathname;
  if (!auth(request, env)) return json({error:"未授权"},401);

  if (p==="/api/sites" && request.method==="GET") return json({sites:await getSites(env)});

  if (p==="/api/sites" && request.method==="POST") {
    const b = await request.json();
    if (!b.name||!b.base_url||!b.token) return json({error:"缺少字段"},400);
    b.token = (b.token||"").trim(); b.base_url=(b.base_url||"").trim().replace(/\/+$/,""); b.user_id=(b.user_id||"").trim();
    const sites = await getSites(env);
    const dup = sites.find(s=>s.base_url===b.base_url && String(s.user_id||"")===String(b.user_id||""));
    if (dup) return json({error:"该站点（网址+用户ID）已存在，请勿重复添加"},409);
    sites.push({id:uid(),name:b.name,base_url:b.base_url,token:b.token,user_id:b.user_id});
    await saveSites(env, sites);
    return json({ok:true});
  }

  if (p==="/api/sites/batch" && request.method==="POST") {
    const b = await request.json();
    if (!Array.isArray(b.sites)||!b.sites.length) return json({error:"没有站点数据"},400);
    const sites = await getSites(env);
    let added = 0, skipped = 0;
    for (const s of b.sites) {
      if (!s.name||!s.base_url||!s.token) continue;
      const dup = sites.find(x=>x.base_url===s.base_url && String(x.user_id||"")===String(s.user_id||""));
      if (dup) { skipped++; continue; }
      sites.push({id:uid(),name:s.name,base_url:s.base_url,token:s.token,user_id:s.user_id||""}); added++;
    }
    await saveSites(env, sites);
    return json({ok:true, added, skipped});
  }

  const dm = p.match(/^\/api\/sites\/(.+)$/);
  if (dm && request.method==="DELETE") {
    const sites = (await getSites(env)).filter(s=>s.id!==dm[1]);
    await saveSites(env, sites);
    return json({ok:true});
  }
  if (dm && request.method==="PUT") {
    const b = await request.json();
    const sites = await getSites(env);
    const i = sites.findIndex(s=>s.id===dm[1]);
    if (i<0) return json({error:"站点不存在"},404);
    const dup = sites.find(s=>s.id!==dm[1] && s.base_url===(b.base_url||sites[i].base_url) && String(s.user_id||"")===String(b.user_id||sites[i].user_id||""));
    if (dup) return json({error:"该站点（网址+用户ID）已存在"},409);
    sites[i] = {...sites[i], name:b.name??sites[i].name, base_url:b.base_url??sites[i].base_url, token:b.token??sites[i].token, user_id:b.user_id??sites[i].user_id};
    await saveSites(env, sites);
    return json({ok:true});
  }

  const cm = p.match(/^\/api\/checkin\/(.+)$/);
  if (cm && request.method==="POST") {
    const outcome = await runCheckIn(env, cm[1]);
    return json({ok:true, outcome});
  }

  // 调试接口：返回签到请求的原始响应
  const dbg = p.match(/^\/api\/debug\/(.+)$/);
  if (dbg && request.method==="POST") {
    const sites = await getSites(env);
    const site = sites.find(s=>s.id===dbg[1]);
    if (!site) return json({error:"站点不存在"},404);
    const base = site.base_url.replace(/\/+$/,"");
    const h = headers(site);
    const out = { headers_sent:h };
    try {
      const r1 = await fetch(base+"/api/user/self", {headers:h});
      out.self_status = r1.status;
      out.self_body = (await r1.text()).slice(0,500);
    } catch(e) { out.self_error = String(e); }
    try {
      const r2 = await fetch(base+"/api/user/checkin", {method:"POST", headers:h});
      out.checkin_status = r2.status;
      out.checkin_body = (await r2.text()).slice(0,500);
    } catch(e) { out.checkin_error = String(e); }
    return json({ok:true, ...out});
  }

  if (p==="/api/settings" && request.method==="GET") return json(await getSettings(env));
  if (p==="/api/settings" && request.method==="POST") {
    const b = await request.json();
    await saveSettings(env, {...(await getSettings(env)), ...b});
    return json({ok:true});
  }

  if (p==="/api/test-tg" && request.method==="POST") {
    const ok = await sendTG(env, "✅ NewAPI 签到测试消息\n如果你看到这条，说明 Telegram 配置成功。");
    return json({ok});
  }

  if (p==="/api/status" && request.method==="GET") return json({state:await getToday(env)});

  if (p==="/api/run" && request.method==="POST") {
    const outcome = await runCheckIn(env, null);
    const state = (await getToday(env))||{};
    state.done=true; state.results=outcome.results||[]; state.manual=true;
    state.executed_at=new Date().toISOString();
    await saveToday(env, state);
    return json({ok:true});
  }

  return json({error:"not found"},404);
}

// ---------- 入口 ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    return new Response(page(), {headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store, no-cache, must-revalidate"}});
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(handleScheduled(env)); },
};
