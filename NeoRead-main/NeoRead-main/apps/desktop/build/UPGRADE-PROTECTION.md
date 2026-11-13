# Windows 安装检查与精确卸载

## 0.10.8 起的行为

按本机用户要求，安装器不再执行强制书库预检与自动快照：

- 不扫描新旧安装目录的文件集合，不再用本次程序清单拒绝旧版哈希资源、退役运行库或未知文件。
- 不读取书库位置配置，不查询旧安装目录来做数据校验，不创建升级快照，也不要求先迁移书库才能安装。
- 安装、卸载前只运行 `CheckStopped`，要求正常退出 NeoRead、本地服务及程序目录内进程；不强杀进程。失败输出受控事件、模式、阶段及原因码，不输出目录或配置内容。
- `customRemoveFiles` 仍只删除本次构建的精确程序文件清单及已知卸载器，再非递归删除空目录。未知文件、未知目录和后来放入的书库不会被递归清除。
- 继续禁止 `--delete-app-data`，不启用 electron-builder 的用户数据递归删除分支。

本次问题来自安装目录中的旧版 Vite 哈希文件及退役 Agent 运行库；它们不在新版文件清单中，不代表存在书库数据。取消的是安装阻断和强制快照，不是将卸载改为删除整个目录。

## NSIS 调用与构建约束

`builder.config.cjs` 的 `afterPack` 仍调用 `prepare-upgrade-protection.cjs`，从本次打包产物生成 `build/program-files-<arch>.json`，用于卸载清理，**不再作为安装预检白名单**。按已审查的 app-builder-lib 26.17.0 规则补充后追加的 `resources\elevate.exe`。清单不含 glob，拒绝穿越、驱动器/UNC/ADS、设备名、特殊字符、链接和大小写冲突。

保留四份 NSIS 模板的 SHA-256 校验，不修改上游模板或改用自定义 `nsis.script`。当前仅构建单架构安装器。

进程检查覆盖已有钩子路径：

1. 外层安装／卸载实例：`customCheckAppRunning`。
2. UAC 内层 GUI：目录页后的隐藏钩子，仅检查进程，不增加用户操作页面。
3. UAC 内层静默安装：`customInit` 在最终安装模式确定后检查。
4. 通过检查后沿用 builder 原有旧版本卸载和新程序写入流程。

`customRemoveFiles` 仍使用独立插件工作目录，PowerShell 的 `Add-Type` 显式引用运行时程序集，保留 0.10.6 对 NSIS `System.dll` 同名冲突的修复。清理前验证精确路径，不跟随 reparse 点。

## 脚本入口

- `-Mode CheckStopped -Destination <程序目录>`：安装器实际使用的轻量进程检查，不读取 Manifest、UserData 或 BackupRoot。
- `-Mode Clean -Destination <程序目录> -Manifest <程序文件清单> -UninstallerName "Uninstall NeoRead.exe"`：卸载器实际使用的精确清理；不要对真实目录运行合成测试。
- `UninstallCheck` 是兼容旧测试／调用的进程检查别名。
- 旧 `Install` 快照入口与相关函数暂留用于历史排查及合成回归；**NSIS 安装流程不再调用它**。
- 成功返回 0，进程未退出或精确清理失败返回 73。

关闭自动快照后，安装器不会替用户创建升级备份。已有备份不删除，用户书库与配置不由新卸载器主动清除。历史安装器／卸载器不会因本次改动而被自动修补；特别旧的递归删除型卸载器仍不应单独运行来修复安装问题。

## 验证

```powershell
pnpm exec vitest run apps/desktop/build/installer-process-check.test.ts apps/desktop/build/upgrade-protection.test.ts --maxWorkers=1
pnpm typecheck
pnpm package
```

新增回归使用临时合成目录，包含旧版前端资源、退役原生依赖、未知文件与模拟书库，确认进程检查不会扫描或迁移这些文件、不会读取损坏位置配置、不会创建快照；精确卸载仍保留它们。原有清单、路径、同名 DLL 和历史快照函数回归继续保留。

打包会验证 NSIS 编译和隔离包内运行时。进程检查与合成清理测试不等同于真实 GUI、静默、UAC 安装／升级／卸载验收；未执行的路径须在交付说明中明确列出。
