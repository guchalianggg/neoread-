# NeoRead 迁移设计参考：Joplin 与 Signal Desktop

检索日期：2026-10-25。以下结论来自项目第一方源码的固定快照，未运行第三方应用，不能视为其稳定版安装包的运行验收。

- Joplin `dev`：`bad38b7fff0f1899109c0833d45a34b21d7b3603`
- Signal Desktop `main`：`17502b9d1a9e34af689f31508c4ac4ccee5b5cb7`

## Joplin：业务 profile、浏览器 session 和语义迁移

### 1. 业务 profile 的路径有独立解析逻辑

桌面主进程分别设置 Electron 显示名称、应用标识和业务 `appName`；业务 profile 由 `determineBaseAppDirs` 解析，支持 `--profile`、便携版 `JoplinProfile`，普通桌面环境默认为 `~/.config/joplin-desktop`。这套解析并不以 `app.getPath('userData')` 为业务数据库目录。活动 profile 可以在根 profile 下另行选择。

业务初始化明确在活动 `profileDir` 下使用 `database.sqlite`、`resources`，并单列 `tmp`、`cache`、`plugin-data` 等目录。可以借鉴的是显式定义业务存储位置及其子目录用途；不能据此声称 Joplin 曾经更名而完全不迁移目录。

来源：[main.ts：显示名称与业务 profile 初始化](https://github.com/laurent22/joplin/blob/bad38b7fff0f1899109c0833d45a34b21d7b3603/packages/app-desktop/main.ts#L20-L57)、[determineBaseAppDirs.ts：路径规则](https://github.com/laurent22/joplin/blob/bad38b7fff0f1899109c0833d45a34b21d7b3603/packages/lib/determineBaseAppDirs.ts#L4-L26)、[BaseApplication.ts：业务目录与数据库](https://github.com/laurent22/joplin/blob/bad38b7fff0f1899109c0833d45a34b21d7b3603/packages/lib/BaseApplication.ts#L791-L864)。

### 2. 窗口使用显式 session，只迁移需要的词典内容

`ElectronAppWrapper.createJoplinSession_()` 为浏览器窗口选择 `<rootProfileDir>/internal`，通过 `session.fromPath` 创建 session；窗口的 `webPreferences.session` 指向它。迁移自定义拼写词典时，只读取旧 Electron `userData/Custom Dictionary.txt`，解析、去重其中的单词，调用新 session 的词典接口导入，再写入一次性完成标记。

这是可直接参考的“迁移某类持久数据”的例子：迁移的是用户单词，而不是递归复制整个旧 Chromium 用户目录。这里的 `cache: false` 不能解读为 Electron 全部缓存均不存在；这段代码只证明窗口 session 的显式归属，并不证明所有应用级 GPU 缓存都被重定向到该目录。

来源：[创建 session 与词典迁移](https://github.com/laurent22/joplin/blob/bad38b7fff0f1899109c0833d45a34b21d7b3603/packages/app-desktop/ElectronAppWrapper.ts#L205-L236)、[窗口使用该 session](https://github.com/laurent22/joplin/blob/bad38b7fff0f1899109c0833d45a34b21d7b3603/packages/app-desktop/ElectronAppWrapper.ts#L256-L274)。

### 3. 数据库升级属于数据库打开流程，不要求 Electron 完全不启动

`JoplinDatabase.open()` 等待 `initialize()`；后者读取 schema 版本并执行 `upgradeDatabase()`。业务初始化等待数据库打开后再设置后续模型与服务。另一方面，桌面 wrapper 明确先等待 Electron ready，然后建立 session 和窗口。因此它可支持“业务初始化等待数据库就绪”，不能作为“用外部 Go 启动器，数据库升级完成后才启动 Electron”的实现案例。

来源：[数据库 open](https://github.com/laurent22/joplin/blob/bad38b7fff0f1899109c0833d45a34b21d7b3603/packages/lib/JoplinDatabase.ts#L163-L167)、[读取版本并升级](https://github.com/laurent22/joplin/blob/bad38b7fff0f1899109c0833d45a34b21d7b3603/packages/lib/JoplinDatabase.ts#L1034-L1056)、[wrapper 启动顺序](https://github.com/laurent22/joplin/blob/bad38b7fff0f1899109c0833d45a34b21d7b3603/packages/app-desktop/ElectronAppWrapper.ts#L926-L939)。

## Signal Desktop：数据类型的明确路径与数据库就绪条件

### 1. 同一 userData 根目录下，业务数据有明确归属

Signal 的 SQL 层明确把数据库放在 `<configDir>/sql/db.sqlite`；附件模块分别定义 `attachments.noindex`、`avatars.noindex`、`stickers.noindex`、`drafts.noindex`、`temp`、`update-cache` 等用途。桌面正常启动把 `app.getPath('userData')` 解析后的路径交给 SQL 初始化。

可借鉴的是让每个数据类型的拥有者决定路径与清理范围。此项目并没有在这组证据中展示“Electron profile 与全部业务数据分成两个互不相关的根目录”；不能把它包装成完全分离的案例。

来源：[SQL 数据库位置及初始化](https://github.com/signalapp/Signal-Desktop/blob/17502b9d1a9e34af689f31508c4ac4ccee5b5cb7/ts/sql/Server.node.ts#L1024-L1066)、[附件与临时目录分类](https://github.com/signalapp/Signal-Desktop/blob/17502b9d1a9e34af689f31508c4ac4ccee5b5cb7/app/attachments.node.ts#L29-L65)。

### 2. 有单独的数据路径配置，并且在单实例检查之前确定

`user_config.main.ts` 支持 `storagePath`、`storageProfile`，在需要时设置 Electron `userData`。主入口专门注明此模块必须在单实例检查前导入，因为单实例检查依赖用户数据目录。

这说明路径确定与单实例协议是同一个启动约束，不能随意把 Electron 运行目录换掉后，仍假定原有单实例语义不受影响。该证据支持稳定、集中地解析存储位置；并不证明 Signal 的路径完全与显示名称无关（例如 AppImage 分支仍使用 `app.getName()`）。

来源：[数据路径配置](https://github.com/signalapp/Signal-Desktop/blob/17502b9d1a9e34af689f31508c4ac4ccee5b5cb7/app/user_config.main.ts#L13-L45)、[单实例检查前的顺序要求](https://github.com/signalapp/Signal-Desktop/blob/17502b9d1a9e34af689f31508c4ac4ccee5b5cb7/app/main.main.ts#L69-L77)。

### 3. Electron 已启动，但业务数据通过初始化完成条件隔离

SQL 初始化在 `app.on('ready')` 中开始。主流程允许窗口预加载与 SQL 初始化并行，随后等待 `sqlInitPromise`；失败进入数据库错误处理，成功后才设置应用的 `ready` 状态。`database-ready` IPC 同样等待该 Promise。数据库初始化只让主 worker 执行 schema 更新；更新检查版本单调性，拒绝高于当前程序支持范围的数据库，并尽量在事务中执行版本迁移，遇到需要 VACUUM 的阶段则提交后继续。

因此，能借鉴的是业务就绪条件、单一迁移执行者和明确 schema 版本。它恰好说明“Electron 进程已经启动”本身不是故障原因；需要避免的是迁移器与运行时同时写同一批数据。

来源：[ready 后启动 SQL 初始化](https://github.com/signalapp/Signal-Desktop/blob/17502b9d1a9e34af689f31508c4ac4ccee5b5cb7/app/main.main.ts#L2198-L2242)、[窗口预加载与 SQL 就绪](https://github.com/signalapp/Signal-Desktop/blob/17502b9d1a9e34af689f31508c4ac4ccee5b5cb7/app/main.main.ts#L2461-L2490)、[database-ready IPC](https://github.com/signalapp/Signal-Desktop/blob/17502b9d1a9e34af689f31508c4ac4ccee5b5cb7/app/main.main.ts#L1069-L1086)、[版本与事务规则](https://github.com/signalapp/Signal-Desktop/blob/17502b9d1a9e34af689f31508c4ac4ccee5b5cb7/ts/sql/migrations/index.node.ts#L1721-L1806)。

## 对 NeoRead 的适用判断

1. 优先借鉴 Joplin 的业务 profile 与显式浏览器 session，以及它按用户数据含义迁移词典的做法。业务迁移清单应覆盖数据库及文件依赖、已确认的持久设置，而不是维护不断增长的缓存排除表。
2. 以一个稳定的书库位置/存储标识作为业务入口，显示名称变化不应自动等同于整棵目录搬家。这是由项目结构得出的设计建议，不是上述项目完成过同类更名迁移的历史事实。
3. 用 Go 的迁移结果控制业务服务与阅读窗口何时可用；Electron 的 bootstrap 是否需要提前运行，可由错误展示、单实例、深链接和现有打包方式决定。不要把“独立原生启动器”当成实现数据写隔离的唯一办法。
4. 上述项目源码都不能直接替 NeoRead 证明旧 `verified` 记录的恢复规则，也不能证明可以安全删除不在业务清单中的未知文件。既有双书库、部分激活和旧版本写入仍需单独处理。

## 本次采用的范围

只实现 Reader 0.8 及更早版本到 NeoRead 0.9 的一次性业务白名单迁移。按实际书库位置选择整个业务书库，另行迁移书库位置和代理配置；不搬运 Chromium profile，不增加临时 profile 重启或原生 Go 启动器。完成记录保持一次性，旧的未完成记录做有限兼容，未知内容保留。
