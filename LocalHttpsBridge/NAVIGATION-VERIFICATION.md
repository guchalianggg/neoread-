# 统一门户导航与 EXE 入口修正 — 验收记录

## 交付结果

已替换并启动最终版 `LocalHttpsBridge.exe`，同级 `_internal` 必须保留。

- EXE 默认入口：`https://26.236.3.200:8443/`；由实际 Radmin 网卡和配置端口生成。已有实例再次打开也选择此门户，而非旧 HTTP 127 页面。HTTPS 门户失败时才回退到原令牌保护的本机控制台；无 VPN 时可用 HTTPS loopback。
- 顶部五项导航：概览 `/`、在线设备 `/portal/devices`、Key 自助 `/portal/keys`、请求明细 `/portal/requests`、桥接配置 `/console`。各页互斥显示，支持直达、刷新、前进/后退和键盘焦点，不是锚点滚动。
- 原配置控制台已迁移，保留后端配置、自动保存、模型/视觉测试、启停、日志、复制接入信息及退出功能。按用户明确选择，VPN 成员可操作，不新增账户或角色系统。
- 远程页面使用同源 HTTPS 管理接口，不使用跨域 127 API，不嵌入/读取本地控制令牌。管理 API 要求合法 Host、同源及 `X-Bridge-Portal: 1`，且仅在实际 VPN/loopback 目标接口开放；物理网卡管理请求拒绝。
- 保存的后端 Key 不回填到 VPN 浏览器；空白/仅空格输入且带保留标志时继续使用已保存的 Key，输入新值才替换。表单、状态、日志和测试返回对保存的后端 Key/控制令牌脱敏。
- 停止只禁用 API 转发并取消在途 API 连接，门户继续在线，重复停止幂等；停止后的冷启动也只开门户，不擅自恢复转发。退出才关闭整个进程，保留原恢复意图语义。
- 改端口先回复再切换；新监听成功后才退役旧监听。占用端口明确报错并保留原门户。后续停止/启动/退出使过期的延迟启动失效。
- 远程证书按钮只下载根公钥，不能安装服务器系统信任。原固定根、根私钥、服务证书及本机自启项均保留，未更改系统信任或防火墙。

最终 EXE：**2,804,003 字节**；SHA-256：
`3368E537DB68A49A92185817788795547DCD8FBDE256607E8B68F94588D51C0E`。

## 验证证据

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 源码完整回归 | **119/119** | 证书、严格 NeoRead/SSE 兼容、存储、并发、启动、远程管理；全为临时状态与模拟后端 |
| 新门户/控制台 Chromium | **100 项 PASS** | 五页导航、直达/刷新/前后退、响应式 320–1920px、键盘、错误恢复、一次性 Key、远程头、Key 保留和证书按钮；无 JS 异常 |
| 原控制台前端 | **40/40** | 原自动保存、模型标签、Key 替换、证书指纹接入命令等 |
| 最终 EXE 启动恢复 | **21/21** | 隔离副本、重复/并发启动、崩溃恢复、停止意图、端口避让、缓存失败 |
| 最终 EXE VPN 门户 | **30/30** | 真实 Radmin TLS、迁移页面、掩码配置、远程保存/停止/恢复/退出、独立 Key、撤销、统计与重启持久性 |
| 运行版 Windows TLS | **19/19** | 默认入口、五页 HTTP 200、原代理恢复、远程/跨站限制、物理网卡隔离、原凭据在 VPN/loopback 模型列表成功、单实例；未跳过证书校验 |
| 实际浏览器页面 | **通过** | 已访问门户、请求明细及配置页；实际互斥显示、当前导航、完整控件、同源链接、Key 掩码、无溢出、控制台无异常 |
| 包复制 | **965 文件哈希一致** | 最终 EXE 与依赖逐文件核对后才清理构建目录 |
| 状态保留 | **通过** | 最终迁移前后配置、令牌、根/服务证书及私钥哈希一致；Key 表、历史小时行与累计指标保留，自启项不变 |
| NeoRead 只读约束 | **1146 文件，0 变化** | 按原哈希清单逐文件核对，未修改 NeoRead |

同一源码全量回归中，两条模拟 SSE 同时持续 11.39s，首事件 377.4/379.1ms，在途统计 12.5ms、签发 Key 13.6ms。延迟探测期间配置/日志轮询和停止仍可响应。

单次限定复核发现并修复五项边界：重复停止、失败端口切换、过期延迟启动、探测持锁、空白 Key 保留，均有专门回归。最终现场检查另发现浏览器 `/favicon.ico` 被旧通用转发路由误计量；已改为空响应、不转发、不计量并加测试。已有历史记录未删除，最终启动后的图标记录数量未增加。

验证日志保存在本次会话 scratch 目录：`navigation-source-tests.log`、`navigation-frontend-tests.log`、`navigation-build.log`、`navigation-packaged-startup.log`、`navigation-packaged-portal.log`、`navigation-deploy-final.log`、`navigation-live.log`、`navigation-final-hash-check.log`。日志不含真实 Key/控制令牌。旧运行包和数据库保留在 scratch 备份目录。

## 阶段反思与剩余边界

1. **现在最没把握的是什么？** 另一台实体电脑的实际 VPN 连通性、客户端证书信任及完整 NeoRead GUI 行为尚未亲自操作。本轮证据是当前电脑的真实 Radmin/Windows TLS、实际浏览器和隔离双客户端，不等同跨物理机验证。EXE 浏览器调用目标由单元捕获与打包入口接口共同验证，且运行版已按默认启动执行；入口实现见 [LocalHttpsBridge.py](C:/Users/10126/Desktop/neoread/LocalHttpsBridge/LocalHttpsBridge.py:1634)。
2. **用户容易忽略的边界是什么？** “停止代理”与“退出程序”现在有意不同：前者必须保留门户供 VPN 重启，后者会让所有人的门户连接关闭；对应 [api_stop](C:/Users/10126/Desktop/neoread/LocalHttpsBridge/LocalHttpsBridge.py:1502) 与 [request_quit](C:/Users/10126/Desktop/neoread/LocalHttpsBridge/LocalHttpsBridge.py:1523)。共享管理仍是共同信任的 VPN 成员同权模式，同源校验不是用户身份系统，见 [管理校验](C:/Users/10126/Desktop/neoread/LocalHttpsBridge/bridge_runtime.py:353)。

无已知阻塞。本轮未执行 Windows 完整重启，未点击生产视觉探测、未发起生产推理压测，也未冒称另一台实体机或完整 NeoRead GUI 已验收。

本文覆盖上一阶段记录中“仅本机管理 / HTTPS 管理全部 403”及旧 EXE 哈希；前一阶段历史证据保留在 `UPGRADE-VERIFICATION.md`。
