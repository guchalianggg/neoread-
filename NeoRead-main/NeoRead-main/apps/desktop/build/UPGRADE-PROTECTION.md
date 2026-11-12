# Windows 安装升级与卸载的数据保护

## 构建约束与 hook 顺序

`builder.config.cjs` 的 `afterPack` 调用 `prepare-upgrade-protection.cjs`，扫描**本次打包产物**生成 `build/program-files-<arch>.json`。另外按已审查的 26.17.0 NSIS 规则，包含在 afterPack 之后追加到安装负载的精确路径 `resources\elevate.exe`（遵循 `packElevateHelper` / `perMachine` 配置），避免卸载残留和后续安装误报未知文件。白名单不含 glob；拒绝路径穿越、驱动器/UNC/ADS、设备名、NSIS 特殊字符及链接。JSON 作为不经 NSIS 插值的文件嵌入安装器和卸载器，不把文件名拼成 NSIS 指令。

已审查 electron-builder/app-builder-lib **26.17.0** 的以下顺序，并在 afterPack 校验四份模板的 SHA-256；模板变化会阻止打包，必须先重新审查，不能直接更新 hash 绕过检查：

1. `.onInit` → `initMultiUser` → `customInit`。
2. 最终目录选择后，`installSection.nsh` → `CHECK_APP_RUNNING` → `customCheckAppRunning` 完成预检和快照（仅外层实例到达此处；内层路径见第 4 条）。
3. 只有保护脚本退出码为 0，才进入 `uninstallOldVersion` → `installApplicationFiles` → `customInstall`。
4. 上游 UAC 内层会跳过 `CHECK_APP_RUNNING`，因此预检在所有内层可达的钩子补齐：GUI 内层在 `customPageAfterChangeDir`（目录页后、instfiles 前的隐藏页）执行；静默内层在 `customInit`（先强制 per-machine 模式定稿 `$INSTDIR`）执行。外层仍走 `customCheckAppRunning`，每个实例恰好命中一个钩子，每次安装只做一次快照。快照始终用原用户上下文（`SetShellVarContext current` 包裹调用，之后按 `$installMode` 恢复），跨用户提升时管理员蜂巢缺数据则 fail-safe 跳过。`--delete-app-data` 一律拒绝。单架构安装限制不变。
5. 新卸载器的 `customRemoveFiles` 替代上游 `un.atomicRMDir` / `RMDir /r $INSTDIR`，只删除嵌入白名单文件及已知卸载器文件名，再尝试**非递归**删除已空的程序目录。未知文件、未知目录、后来放入的书库均保留；先校验全部待删路径，遇到 reparse 点则中止。
6. 安装和卸载均拒绝 `--delete-app-data`，避免激活上游额外的 AppData 递归删除分支。

**旧的 `0.10.1-local.1` 安装包/卸载器自身仍危险。** 新安装包在调用它之前保护，但无法阻止用户绕开新安装包直接运行旧程序。不要重新分发或运行旧安装包；不要让用户直接运行旧卸载器来“修复”保护拒绝。

## 安装前行为

- 读取实际 HKCU/HKLM、32/64 位的安装注册表键、卸载命令父目录和最终 `$INSTDIR`。仅读取 `NeoRead/library-location.json` 决定书库路径，不修改它；缺配置沿用应用的 `userData/library` 默认位置。
- 书库与新旧程序目录存在祖先/后代或相等关系时，**中止并要求先迁移**，不执行“备份后继续删除活跃库”。新旧目录内出现不属于本次程序白名单的文件，也保守中止，保护尚未被配置引用的旧数据。旧版退役的程序文件也可能触发此中止，应核实并移出，不要放宽为递归清理。
- 路径按 Windows 分段边界、大小写不敏感比较，并展开现有 8.3 别名。拒绝 UNC、路径遍历/歧义、reparse、权限/枚举错误、位置配置损坏、已配置书库缺失及有内容却无数据库的目录；不创建空书库。
- 枚举 NeoRead、本地服务及程序目录内进程；要求用户先**正常退出**以完成阅读/后台保存。不发送 Stop-Process/taskkill，不强杀。无法查询进程也拒绝。
- 选定外部库和 NeoRead 用户数据目录中的文件全部本机复制，包括数据库、存在的 WAL/SHM、原件、编辑副本、附件、翻译和 AI/代理等配置。配置只当不透明字节复制，不输出内容。

## 快照位置与验证

实际安装使用 `%LOCALAPPDATA%\NeoRead Upgrade Backups`，不使用 TEMP 或程序目录。其路径与书库、用户数据、新旧程序目录重叠或落 TEMP/TMP 时拒绝。备份根目录 ACL 仅允许当前用户及 SYSTEM。

每次生成新的时间戳 + UUID 快照；不会覆盖、自动删除或滚动淘汰历史快照。失败文件保留在 `.incomplete-*`，不能当成完成的备份。空间不足则中止升级；用户需自行管理旧快照空间。

复制期间为所有源文件持有禁止写入/删除的只读句柄；锁冲突即失败。逐文件落盘、核验长度和 SHA-256，复查源文件集合、位置配置与进程状态，最后写入本机 `manifest.json` 并将临时目录改名为完成快照。输出只有受控事件/原因、文件数和快照 ID，不输出路径、文件内容或配置。该机制不是硬盘损坏或对抗性并发修改的绝对保证。

恢复时先正常退出应用，选择一个无 `.incomplete-` 前缀且核验通过的快照，将 `library` 复制到**新的独立外部目录**，然后由应用“打开已有书库”选择；不要直接覆盖现用库。`configuration` 仅供人工核对恢复，不自动覆盖现用配置，也不要将其内容放入日志或报告。

## CLI 与验证（只用于合成临时数据）

`upgrade-protection.ps1` 的模式：

- `-Mode Install -Destination <最终程序目录> -UserData <合成NeoRead配置目录> -BackupRoot <本机持久快照目录> -Manifest <打包文件白名单JSON> -InstallRegistryKey <键> -UninstallRegistryKey <键> [-UninstallRegistryKey2 <键>] -UninstallerName "Uninstall NeoRead.exe"`
- `-Mode UninstallCheck -Destination <程序目录>`：只检查进程已退出。
- `-Mode Clean -Destination <合成程序目录> -Manifest <白名单JSON> -UninstallerName "Uninstall NeoRead.exe"`：精确清理。切勿用于真实目录测试。
- 成功退出 0；保护拒绝退出 **73**。无特殊参数能够关闭保护后继续安装。

0.10.6 修复了 `customRemoveFiles` 使用插件目录作为工作目录时的程序集冲突：NSIS 插件的原生 `System.dll` 会遮蔽 `Add-Type` 默认的同名 .NET 引用。脚本显式引用当前运行时的 `[Uri].Assembly.Location`，不再从工作目录查找引用；32 位和 64 位 PowerShell CLI 均以带同名无效 DLL 的独立工作目录回归验证。

失败状态沿用受控 `event` / `reason`，增加 `mode`、白名单 `phase` 和归一化 `exceptionType`，用于区分进程检查、互操作初始化、清单、路径、文件及空目录清理。安装与卸载分别显示对应提示；不输出原始异常消息、路径、配置或清单正文。

```powershell
pnpm exec vitest run apps/desktop/main/library-location.test.ts apps/desktop/build/upgrade-protection.test.ts --pool=threads --maxWorkers=1 --no-file-parallelism
pnpm typecheck
# 直接运行真实 PowerShell 合成套件（Root 必须在会话 scratch 中）：
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File apps/desktop/build/upgrade-protection.test.ps1 -Root "$env:PI_SCRATCH_DIR\upgrade-test-unique-id"
```

测试从不运行实际安装器/卸载器；旧卸载器仅以保护成功后递增的计数器模拟。覆盖实际文件复制、SHA/字节、SQLite/WAL/SHM、分类和假 API 字节、库/数据库锁、ACL 目录拒绝、junction、备份损坏、源集合变化、目标/旧路径边界、中文与前缀相似目录、损坏配置、空的新旧安装、合成注册表发现与未知文件保留。

## 发包验收

主流程正常打包即会自动生成本架构白名单，无需手写生成物。保留 `include: "installer.nsh"`、afterPack 与上述模板校验；不要设置自定义 `nsis.script`，它会改变 builder 的卸载器生成流程。当前拒绝多架构合并安装器，x64/arm64 应分别出包。

发包前必须完成 NSIS 编译，并在隔离测试目录/虚拟机检查普通安装、静默目标选择、正常退出后卸载；不能以原始卸载启动进程 exit=0 代替实际卸载结果。需要等待实际执行副本，核验程序文件、注册表与快捷方式均已移除；测试普通用户与全用户 UAC 路径。对安装目录内库、权限错误或损坏位置配置仍应看到中止，不应看到旧卸载器运行。应用已将实际 `dirname(process.execPath)` 传入目录验证；开发模式不启用程序目录限制，现有违规库启动时明确提示先迁移，而不是换成空库。
