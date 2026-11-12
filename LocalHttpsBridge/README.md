# LocalHttpsBridge — 本地 HTTP→HTTPS 中转器

把一个 **HTTP** 的 API 一键包装成 **HTTPS** 端点，供只接受 HTTPS 的软件使用。
轻量 Python 程序，仅使用标准库和已打包的 `cryptography`；新版增加 VPN 共享门户、独立 Key 与本地 SQLite 用量统计。

---

## 一、双击运行

**方式 A（推荐）：双击 `LocalHttpsBridge.exe`** —— 免安装、免 Python，
**全程无黑色命令行窗口**（后台静默运行），浏览器默认打开统一 HTTPS 门户
`https://26.236.3.200:8443/`（按实际 Radmin 地址及配置端口生成；无 VPN 时使用 HTTPS loopback，门户启动失败才回退到带令牌的本机 HTTP 控制台）。免解压快速版，须保留同级 `_internal` 文件夹。

**方式 B：双击 `启动.bat`** —— 需要本机装有 Python 3.8+。
若 `O:\program\python\python.exe` 不存在，启动器会自动回退到 PATH 里的 `python`。
（此方式保留一个控制台窗口，关闭窗口 = 服务停止。）

> **停止服务**：点击网页右上角 **⏻ 退出** 按钮，程序会自动停掉代理并安全退出
> （EXE 与 bat 两种方式通用）。
> **重复双击无害**：已有实例也会打开统一门户，不会堆积进程。
> **备用本机控制台**：`http://127.0.0.1:8765/?t=<本机控制令牌>`；令牌仍保存在 `web_token.txt`，不要分享该地址或文件。
> 门户顶部为「用量概览 / 在线设备 / 接入 Key / 请求明细 / 桥接配置」；配置页保留原控制台全部功能。
> 「停止代理」只停止 API 转发，门户仍可查看、配置与重新启动；「退出」才关闭整个程序。
> 新版支持登录自启和代理恢复：**停止代理**会取消恢复；**退出程序**只结束本次运行。详见第十节。

## 二、Web 控制台三步走

1. 在顶部点 **桥接配置**，**填后端信息**（卡片 ① 后端配置）
   - `后端地址`：你的 HTTP API，如 `http://192.168.1.50:8080/v1`（路径前缀原样拼接）
   - `后端 Key(真实)`：你现在用的真实 Key
   - `对外端口`：本机 HTTPS 监听端口，默认 `8443`
   - `启用 Key 替换`：默认开启
   - 表单**自动保存**到 `config.json`；远程页面不回填保存的后端 Key，留空表示保留，输入新值替换。原本机备用控制台保持旧回填行为
2. **测试连通性 → 启动代理** —— 测试时会请求 `GET /v1/models`，把**模型列表以标签形式展示**（点标签复制模型名），并逐个模型执行随机八色块流式识图：带 `👁` = 本轮识图与 SSE 协议通过，半透明标签 = 本轮识图未通过；悬停可看原因，卡片 ③ 运行日志显示测试阶段
3. **复制对外接入信息**（卡片 ②，启动后点亮高亮）
   - **对外 HTTPS 地址**：大号等宽字体直接展示 + 一键复制，
     地址 chips 保留本机所有网卡 IP，优先选中实际 Radmin 网卡地址（当前 `26.236.3.200`），仍保留 `127.0.0.1`；VPN 不可用时明确提示
   - **对外 Key**：默认打码，支持 显示 / 一键复制（`lb_` 开头自动生成）
   - 把这两个值填进目标软件即可

三种界面任选：

| 方式 | 命令 |
| --- | --- |
| Web 控制台（默认，推荐） | `python LocalHttpsBridge.py` |
| 传统桌面 GUI | `python LocalHttpsBridge.py --tk` |
| 无界面 | `python LocalHttpsBridge.py --headless ...` |

## 三、Key 替换是什么意思？

- **开（默认）**：你把「对外 Key」填给目标软件；桥接器转发时自动把它
  换回你的「真实 Key」。保存的后端 Key 不回填到 VPN 浏览器，只在转发时发给上游。
- **关（透传模式）**：不替换，目标软件里直接填你的真实 Key。

替换覆盖以下常见鉴权头：
`Authorization: Bearer <key>`、`x-api-key`、`api-key`、`x-goog-api-key`、`x-auth-token`

## 四、目标软件报「证书错误」怎么办？

首次启动生成固定信任根(有效期 10 年)及其签发的服务证书。服务证书 SAN 含 `localhost`、`127.0.0.1` 和本机 IPv4,有效期最长一年;重启优先复用,新增 IP 或临近到期时只更新服务证书,不更换信任根。升级时沿用旧版有效的 `bridge_cert.pem` 与 `bridge_key.pem`,保持已安装的信任。

HTTPS 配置页的 **「下载根证书」** 只下载公钥证书，不修改服务器信任；在实际客户端核对指纹后安装（第十一节）。备用本机 HTTP 控制台的 **「安装证书到系统」** 只为桥接机当前用户安装。根证书损坏、丢失私钥或过期时明确报错，不会静默轮换；不要复制私钥或删除 `certs` 修复客户端错误。

- 证书位置：`certs/bridge_cert.pem`
- 卸载：`certutil -user -delstore Root LocalHttpsBridge`

## 五、无界面（headless）用法

```powershell
O:\program\python\python.exe LocalHttpsBridge.py --headless `
  --backend http://192.168.1.50:8080/v1 `
  --port 8443 `
  --external-key my-ext-key `
  --backend-key my-real-key
```

| 参数 | 说明 |
| --- | --- |
| `--headless` | 无 GUI 运行 |
| `--backend` | 后端 HTTP 地址（必填） |
| `--port` | HTTPS 监听端口，默认 8443 |
| `--backend-key` | 真实 Key |
| `--external-key` | 对外 Key（不填则自动生成） |
| `--no-replace` | 关闭 Key 替换，原样透传 |


> Web 控制台参数：`--web-port <端口>`（默认 8765，被占用时自动 +1 递增）、
> `--no-browser`（启动后不自动打开浏览器，适合远程/自动化场景）。
## 六、行为细节

- 支持 `GET / POST / PUT / DELETE / PATCH / HEAD / OPTIONS`
- 路径、查询串、请求体原样透传；上游返回的 4xx/5xx 原样透传。Chat SSE 有下述空 usage 候选的针对性兼容处理
- 上游不可达时返回 `502 {"bridge_error":"upstream_unreachable"}`
- 逐跳头（`Connection`、`Transfer-Encoding` 等）按规范剥离
- API 仍监听 `0.0.0.0` 保持已有接入兼容；**新门户只在 Radmin 地址与回环地址提供**，访问其他物理网卡地址的门户会返回 404
- 单次请求最长等待 300 秒（视觉模型传图推理需要更久；旧版 30 秒会误判为失败）
- 请求体兼容 `Content-Length` 与 `Transfer-Encoding: chunked`（客户端发大图两种方式都有）
- 响应支持流式转发：上游无 `Content-Length` 或 `text/event-stream` 时使用 `read1()` 读取当前可用数据，立即转发首段内容，不等待凑满 64KB 或响应结束
- 「测试连通性」逐模型发送一张随机 800×140 八色块图并检查完整 Chat SSE 终态：带 `👁` = 本轮颜色顺序正确且流式协议通过，半透明 = 本轮识图未通过；最多前 30 个模型、5 并发、单模型 90 秒超时。不会再凭 HTTP 200 判为视觉通过，也不再用 16-token 上限截断推理
- 仅对 Chat Completions 流式响应规范化已结束候选之后的纯空占位事件，保留 usage、原始文本与真实错误；Responses、Anthropic 和普通 HTTP 路径不做此项改写

## 七、常见问题：目标软件「获取不到模型列表」

打开控制台「运行日志」卡片，每个请求都会显示上游状态码，按现象对号入座：

| 现象 | 原因 | 解法 |
| --- | --- | --- |
| 日志里**连请求都没有**，软件报 SSL/证书/连接错误 | 证书信任或网络未通过 | 在该客户端核对并信任固定根证书，重启软件；多机步骤见第十一节。不要关闭日常 TLS 校验 |
| 日志显示 `[404] GET API ...` | 路径拼接不对 | 推荐后端填根地址，客户端填 `https://<ip>:8443/v1`；后端已有 `/v1` 时新版也会去重 |
| 日志显示 `[401] GET API ...` | Key 填错或已撤销 | 新客户端使用门户签发的 `lbp_` Key；旧替换模式仍用 `lb_` 对外 Key，旧透传模式仍用原凭据 |
| 「测试连通性」显示 ✅ 可达，但**模型列表为空**（带提示行） | 后端 Key 无权查看、或后端无 `/v1/models` 接口 | 按提示行处理：Key 错则换正确后端 Key；后端若无此接口，不影响其他路径正常转发 |
| 日志显示 `[502] ...` | 桥接机连不上后端，或上游响应超过等待上限 | 检查后端地址与后端服务是否在线；单次请求最长等待 300 秒 |
| 目标软件提示「模型都不支持图片 / 图片检测失败」，但其中确实有视觉模型 | 旧版转发有两个硬伤：① 单次请求只等 30 秒，视觉模型传图推理常超时被判失败；② 客户端用 `Transfer-Encoding: chunked` 发大图时请求体被丢弃 | 换用最新版（已修）：等待上限提到 300 秒、完整解析 chunked 请求体、流式响应边收边发。日志里 `请求体 N B` 与 `, 流式` 可确认大图与流式都被正确转发 |
| 「测试连通性」变慢了，模型标签旁出现 👁 / 半透明 | 新版逐模型执行一次随机八色块流式识图（最多前 30 个、5 并发、单模型 90 秒） | `👁` = 颜色顺序和 SSE 终态均通过；半透明 = 本轮识图未通过，不等同于永远不支持图片；每次检测会消耗上游推理额度 |
| 模型悬停显示“未判定” | 探测超时、SSE 不兼容、鉴权、模型或接口异常 | 不是“不支持视觉”的结论；按悬停提示检查后端，恢复后复测 |

## 八、文件清单

| 文件 | 作用 |
| --- | --- |
| `LocalHttpsBridge.exe` | 快速启动入口，免 Python；需与 `_internal` 保持在同一文件夹 |
| `_internal/` | 已打包的 Python 运行时与依赖，**请勿删除或单独移动** |
| `LocalHttpsBridge.py` / `bridge_runtime.py` / `bridge_store.py` / `portal_ui.py` | 主程序、轻量传输、统计存储和共享门户源码；源码运行需保持同目录 |
| `启动.bat` | 双击启动器（需本机有 Python） |
| `certs/bridge_cert.pem` | 固定信任根证书公钥;客户端安装此文件 |
| `certs/bridge_key.pem` | 固定 CA 私钥,**请勿外传、删除或覆盖** |
| `certs/bridge_server.pem` / `bridge_server_key.pem` | 自动维护的 HTTPS 服务证书与私钥;勿外传私钥 |
| `web_token.txt` | 控制台访问令牌（持久化保存，重启后控制台地址保持不变） |
| `config.json` | 表单草稿、最后成功的代理配置和恢复开关（含 Key），**请勿外传** |
| `console.json` / `instance.lock` | 自动维护的控制台端口缓存与单实例锁；不含 Key |
| `usage.sqlite3`（及运行中的 `-wal` / `-shm`） | 本地 Key 哈希、撤销状态及用量元数据；关闭程序后可一致备份，不对外分发 |

## 九、NeoRead 接入与图片检测

不需要修改 NeoRead 源码。在其 API 设置中选择 **OpenAI Chat Completions**，Base URL 填桥接器地址并加 `/v1`（例如 `https://127.0.0.1:8443/v1`），Key 填桥接器的对外 Key。不要把完整 `/chat/completions` URL 当作 Base URL。

1. 启动新版桥接器，在 NeoRead 所在电脑核对并信任固定根证书，再重启 NeoRead；跨电脑使用桥接机的 Radmin VPN 地址，步骤见第十一节。
2. NeoRead 必须先通过文本检测，才会执行图片检测；它要求完整 SSE 流和随机八色块的正确颜色顺序，不是仅检查 HTTP 200。
3. 某些兼容后端在 `finish_reason: stop` 后返回带空候选的 `usage` 事件。桥接器现将这种纯空占位规范为 `choices: []`，保留 usage；不会合成答案、`stop`、`[DONE]`，也不会把真实错误改成成功。日志出现 `[SSE 兼容]` 表示触发了此项修正。
4. 本轮使用实际后端、按 NeoRead 请求和判定规则复现：`qwen3.8-flash`、`zdr-glm-5.3-flash`、`deepseek-v4.1-flash` 已通过八色块与 SSE 终态检测。其他模型的 400、错答或超时保持真实结果，不保证所有模型都有视觉能力。

本轮未安装 Go 工具链或运行 NeoRead 完整界面；验证范围是源码协议复现、真实后端与桥接器测试，不等同于完整 GUI 验收。

回归测试：`python -B -m unittest discover -s LocalHttpsBridge/tests -v`（在上级文件夹运行，无需真实 Key）。

## 十、登录自启、代理恢复与快速启动

- 自启使用当前用户的 Windows `Run` 项，**登录桌面后静默运行**，不需要管理员权限、不弹浏览器；不是登录前的系统服务。双击 EXE 会打开已有控制台，不会重复启动代理。
- 点击「启动代理」成功后，程序原子保存最后实际运行的配置；即使后来编辑表单草稿，下次也只恢复最后成功运行的代理，Key 和端口保持不变。
- **点击「停止代理」会取消下次自动恢复。点击「⏻ 退出」只退出本次进程，保留最后的代理开关状态。** 关机或进程异常结束后，也按已保存状态恢复。
- 恢复失败（如 HTTPS 端口被其他程序占用）时，控制台仍可打开查看日志；不会擅自修改端口，也不会执行耗费推理额度的视觉检测。
- 快速版使用目录式打包，不再每次解压依赖；去掉固定浏览器等待，并绕过系统代理快速定位已有控制台。本机同条件启动至控制台就绪的测试，从平均 12.27 秒降至最终版平均 2.43 秒，缩短约 80%；不同电脑和 Windows 登录负载下会有差异。
- **不要删除 `_internal`，也不要只复制 EXE。移动时应移动整个文件夹；移动后重新执行启用自启命令，更新系统记录的路径。**

在本文件夹的 PowerShell 中管理自启：

```powershell
# 启用（本次已配置；之后移动文件夹时可重新执行）
Start-Process .\LocalHttpsBridge.exe -ArgumentList '--enable-autostart' -Wait
# 关闭登录自启（不立即停止当前代理）
Start-Process .\LocalHttpsBridge.exe -ArgumentList '--disable-autostart' -Wait
```

自启项名称：`LocalHttpsBridge`；位置：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`。启动参数只有 `--startup`，不含后端 Key 或控制令牌。

打包版恢复/并发回归测试（在上级文件夹运行，使用隔离副本及模拟后端，不修改系统自启项）：
`python -B LocalHttpsBridge/tests/verify_packaged_startup.py LocalHttpsBridge/LocalHttpsBridge.exe`。

## 十一、一台桥接、多台电脑同时接入

两台电脑可以同时信任同一个桥接根证书;在 A 机安装证书不会撤销 B 机的信任。不要在客户端另开一个桥接实例来生成证书,也不要复制整个 `certs` 或含 Key 的配置。

1. 桥接只在服务器运行。本机 NeoRead 可用 `https://127.0.0.1:8443/v1`;另一台使用服务器的可达 IP,本例为 `https://26.236.3.200:8443/v1`。NeoRead 网络代理选择直连。
2. 在桥接控制台卡片 ② 点选 `https://26.236.3.200:8443`,再点“其他电脑接入”的“复制命令”,把命令发给另一台电脑,在那里用运行 NeoRead 的同一 Windows 用户执行。
3. 命令只下载 `/cert` 的固定根证书公钥。首次下载可临时跳过 TLS 校验,但**必须先匹配控制台固定的 SHA-256 指纹才导入**;下载失败或指纹不一致会停止,不安装。日常 API 请求不跳过校验。
4. 完全退出并重新启动另一台的 NeoRead。已信任这个固定根的本机不需要卸载或重新安装。
5. 另一台可运行 `curl.exe --noproxy "*" --max-time 10 --ssl-revoke-best-effort -v https://26.236.3.200:8443/cert -o NUL` 核验系统 TLS,不要加 `-k`。本地 CA 不提供在线吊销服务;该选项只允许无法取得吊销信息,仍校验证书链和地址,否则 Windows curl 可能报 `CRYPT_E_NO_REVOCATION_CHECK`。HTTP 200 表示证书和网络通过;模型请求返回 HTTP 401 则是 Key/上游鉴权问题,不是证书错误。

`/cert` 返回固定根，握手发送服务证书，两者 SHA-256 **本来就不同**。比较两台机器信任的根指纹，不要拿服务证书指纹与根指纹比较。新增 IP 后重启桥接程序，只重签服务证书，客户端信任不变。

迁移会沿用旧版有效的 CA:TRUE 根证书与私钥,不会自动安装或删除系统证书。旧根缺少部分 PKI 扩展,Python 3.13 的 `VERIFY_X509_STRICT` 可能拒绝其证书链;本项目目标客户端 Windows/NeoRead 不依赖该严格扩展策略。新建根已补齐 KeyUsage/SKI。根损坏、丢失私钥或到期时需恢复服务器备份;确需更换根则所有客户端必须重新导入。

## 十二、VPN 共享门户与独立 Key

- 浏览器打开 **`https://26.236.3.200:8443/`**；API Base URL 为 **`https://26.236.3.200:8443/v1`**。桥接机本机也可用 `https://127.0.0.1:8443/` 与 `/v1`。先按第十一节核对、安装根证书。
- 从实际处于 Up 状态、名称或描述含 Radmin 的网卡识别地址，不凭 `26.*` 前缀猜测。启动恢复后默认打开该地址；网卡变化时重启程序以更新门户范围、展示地址和服务证书 SAN，固定根不变。
- 门户不注册、不区分角色：所有可访问者均可查看统计、签发/撤销 Key，并在 **桥接配置** 页面修改后端、启停代理、测试及退出。此权限按用户确认开放给共同信任的 VPN 成员，不限制只能登记两台设备。
- 完整 `lbp_` Key **仅签发时显示一次**，可复制到客户端；关闭弹窗后只保留脱敏前缀，数据库仅保存 SHA-256 哈希，不保存完整 Key。撤销后新请求返回 401，已经在途的请求不强制撤回。
- 不论旧配置是否启用 Key 替换，`lbp_` Key 均在桥接器本地验证，转发时使用已保存的真实后端 Key。无效/撤销 Key 在调用上游前被拒绝。未配置真实后端 Key 时暂不签发新 Key（409），可在桥接配置页填写。
- 原有 `lb_` 对外 Key、透传凭据与配置继续兼容。未配置任何可校验 Key 的旧无密钥/任意 Key 透传保持旧行为；它不是新 Key 权限机制，推荐在本机填好真实后端凭据后使用独立 Key。
- 顶部导航对应独立 URL：`/`、`/portal/devices`、`/portal/keys`、`/portal/requests`、`/console`；支持直接打开、刷新与浏览器前进后退，不是页面锚点滚动。
- HTTPS 管理接口为 `GET /api/state|form|logs` 和 `POST /api/form|test|start|stop|quit|cert`，仅在实际 VPN/loopback 目标接口开放，要求合法 Host、同源及 `X-Bridge-Portal: 1`；不接受本地令牌替代这些校验。控制令牌不嵌入远程 HTML，不使用跨域 127 请求。
- 共享接口：`GET /portal/api/info|stats|devices|keys`；`POST /portal/api/keys`、`/revoke`、`/heartbeat`，写请求也需同源及门户头。根证书下载仍为 `/cert`。停止后 API 返回 503，门户继续在线；远程改端口先回复，再切换并跳到新配置页。

## 十三、统计口径、留存与容量

- 默认 Web/EXE 模式提供此功能；旧 `--tk`、`--headless` 仍可转发，但不初始化共享门户/统计存储。
- 从升级后经过桥接器的 API 请求开始统计，**不回填旧请求**。门户、自身心跳及证书下载不算模型调用。
- 流量为桥接器成功读取的请求体、成功写出的响应体字节，不含 HTTP 头、chunk 分帧、TLS、TCP 或 VPN 其他软件流量；被提前拒绝而未读取的请求体计 0。客户端中断时以已写出字节为准，并不代表对端应用已消费。
- 页面支持全部、今天、近 7/30 天与自定义时间，提供请求/成功/失败、平均总耗时、模型/IP/Key 分组及最近 **100 条**筛选后明细（每页 15 条）。HTTP 200–399 且完整结束才计成功；中断记失败，按请求只结算一次。
- Token 只采集上游 JSON/SSE 的实际 usage；缺失字段显示未知，不推算总数或费用。已知 Token 是返回过该字段的请求之和，可能只是部分调用；完全缺失 usage 的请求单独计数。压缩体或超过 256 KiB 的单条 usage 捕获限制可能显示未知，但转发不受此统计缓冲影响。
- 明细保留 30 天，启动及运行中定期清理；累计小时汇总不随明细清理删除。近期筛选使用准确明细；已清理历史只能按**重叠小时**汇总，筛选不再精确到秒。Key/撤销状态、累计统计重启保留。
- 在线列表依据实际 socket 来源 IP，不信任 `X-Forwarded-For`。有活动请求，或最近 5 分钟 API/门户心跳的 IP 为在线；页面每 5 秒刷新。不是 VPN 成员扫描，也不能区分共享同一来源 IP 的多台设备。
- 有界资源：最多 32 个连接、8 个在途 API；超过返回 503，门户仍可利用剩余连接响应。请求体最大 32 MiB（超过 413），单个 Chat SSE 事件最大 2 MiB；空闲连接/握手有 15 秒超时，上游连接建立最多 5 秒、读取等待保留 300 秒。最多 1000 枚有效 Key，超出返回明确错误。
- 目标为轻量双设备并发，不是 50/100 路模型推理平台；实际上游模型吞吐由后端决定。备份时正常退出程序，再复制配置、证书及数据库；完整 Key 请由各客户端自行保存。

新增检查（上级目录运行，全为隔离模拟后端）：

```powershell
python -B -m unittest discover -s LocalHttpsBridge/tests -v
node LocalHttpsBridge/tests/portal_frontend_test.js
python -B LocalHttpsBridge/tests/verify_packaged_startup.py LocalHttpsBridge/LocalHttpsBridge.exe
python -B LocalHttpsBridge/tests/verify_packaged_portal.py LocalHttpsBridge/LocalHttpsBridge.exe
```
