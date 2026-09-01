# NewAPI 多站点自动签到

部署在 Cloudflare Workers 上的 NewAPI 系 API 中转站自动签到工具。支持多站点管理、全天随机时间签到、余额查询、Telegram 通知。

## 功能

- ✅ 多站点集中管理，单个添加或批量粘贴
- ✅ 每天北京时间 0:00~23:00 随机一个整点自动签到
- ✅ 多站点间隔 3~15 秒，模拟真人
- ✅ 签到后自动查询余额，Telegram 推送结果
- ✅ 账号名脱敏显示
- ✅ 网页管理后台，复制粘贴一键添加站点
- ✅ 书签一键提取站点 Token
- ✅ 手动补签单个站点或全部签到

## 部署（推荐：GitHub + Cloudflare 自动部署）

不需要敲命令，全程网页操作。

### 第一步：Fork 本仓库

1. 点击右上角 **Fork**，复制一份到你自己的 GitHub
2. Fork 后的仓库就是你的了，后续更新也可以同步

### 第二步：在 Cloudflare 创建 Worker

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages**
2. 点击 **Create** → **Connect to Git**
3. 连接你的 GitHub 账号，选择刚才 Fork 的仓库
4. 点击 **Save and Deploy**，等待部署完成

### 第三步：配置密码和 KV

1. 进入刚创建的 Worker → **Settings** → **Variables and Bindings**
2. **添加 Variable**：
   - 变量名：`ADMIN_TOKEN`
   - 值：你自己设一个密码（登录管理页用，比如 `mypassword123`）
   - 点击 **Save**
3. **添加 KV Namespace Binding**：
   - 如果还没有 KV，先去 **Workers & Pages** → **KV** → **Create a namespace**，名字随便起（比如 `checkin-data`）
   - 回到 Worker → **Settings** → **Variables and Bindings** → **Add binding** → **KV Namespace**
   - 变量名填：`KV`（必须是这个名字）
   - 选择刚才创建的 KV namespace
   - 点击 **Save**

### 第四步：重新部署

配置完变量和 KV 后，回到 **Deployments** 页面，点击 **Retry deployment** 或随便推送一次代码触发重新部署。

### 第五步：打开管理页

部署完成后，Worker 会给你一个 `*.workers.dev` 域名，打开它，输入你刚才设的 `ADMIN_TOKEN` 密码即可进入管理后台。

（可选）在 Worker → **Settings** → **Domains & Routes** 里可以绑定自己的域名。

---

## 使用说明

### 添加站点

进入管理后台 → **站点管理** tab：

#### 方式一：单个添加

| 字段 | 说明 |
|------|------|
| 站点名称 | 随便起，方便你认，如 `tabitoken` |
| 网址 | 站点首页地址，如 `https://tabitoken.com`，末尾不要加斜杠 |
| Token | 站点后台 → 个人设置 → 安全设置 → 生成令牌，`sk-` 开头 |

#### 方式二：批量添加

在「批量添加」文本框里，每行一个站点，用**英文逗号**分隔：

```
名称,网址,token
tabitoken,https://tabitoken.com,sk-abc123
另一个站,https://example.com,sk-def456
```

网址和 token 在同一行，不会搞混。

#### 方式三：书签一键提取（推荐）

1. 在管理页展开「一键提取」，把蓝色链接拖到浏览器书签栏
2. 打开任意 NewAPI 站点并登录
3. 点一下刚才拖的书签，会自动跳回管理页并填好名称、网址、Token
4. 点「添加站点」即可

### 签到看板

**签到看板** tab 显示：
- 今日计划签到时间
- 每个站点的状态（已签到 / 未签到 / 失败）
- 每个站点获得的额度和余额
- 每个站点旁边有「签到」按钮可手动补签
- 底部「立即签到全部」一键全签

### Telegram 通知

**通知设置** tab：

| 字段 | 说明 |
|------|------|
| Bot Token | Telegram 找 `@BotFather`，发 `/newbot` 获取 |
| Chat ID | Telegram 找 `@userinfobot`，点 Start 获取 |

填好后勾选「启用 Telegram 通知」，点「保存设置」，再点「发送测试」验证。

每天自动签到完成后，会推送签到报告到你的 Telegram，包含每个站点的签到结果和余额。

---

## 常见问题

**Q：签到时间是固定的吗？**
A：不是。每天 0:00~23:00 之间随机选一个整点，多个站点之间间隔 3~15 秒，模拟真人操作。

**Q：一天签到几次？**
A：一次。每天只签一次，避免重复签到被站点限制。

**Q：Token 会过期吗？**
A：NewAPI 的 System Access Token 是长期有效的，除非你在站点后台手动撤销。

**Q：支持哪些站点？**
A：所有基于 NewAPI / One API 开源框架搭建的 API 中转站，只要有 `/api/user/checkin` 签到接口。

**Q：怎么更新代码？**
A：如果原仓库有更新，在你 Fork 的仓库点 **Sync fork** 同步，Cloudflare 会自动重新部署。

---

## 本地开发（可选）

如果你想在本地修改代码：

```bash
npm install -g wrangler
wrangler login
wrangler dev
```

修改 `worker.js` 后运行 `wrangler deploy` 部署。

## License

MIT
