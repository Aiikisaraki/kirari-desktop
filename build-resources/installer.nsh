# ============================================================================
# 安装向导自定义「模型配置」页（electron-builder nsis.include）
#
# 通过 electron-builder 预留的 customPageAfterChangeDir 宏钩子，
# 把本页插入到「选择安装目录」之后、「开始安装」之前。
#
# 行为：
#   - 若 $APPDATA\akisaki-kirari\config.json 已存在 → 自动跳过本页（升级/重装）
#   - 若不存在 → 显示本页，用户填写 Endpoint / Model / Key 后点「安装」直接开始安装
#     （MUI2 最后一个预安装页的「下一步」按钮自动显示为「安装」）
#
# 收集值写入 $APPDATA\akisaki-kirari\config.json，
# 主程序首次启动读取该文件并注入后端；勾选跳过则不写文件。
# ============================================================================
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
# 由 scripts/write-edition-nsh.cjs 生成：定义 !define EDITION "frontend|integrated|full"
# 决定安装向导是否插入「选择默认模式」页，以及是否跳过「模型配置」页。
!include "edition.nsh"

# electron-builder 预留钩子：在"选择安装目录"页之后插入自定义页
!macro customPageAfterChangeDir
  # full 版：插入「选择默认模式」页（本地部署 / 连接远程服务端）
  !ifdef EDITION_FULL
  Page custom ModeSelectShow ModeSelectLeave
  !endif
  Page custom ModelConfigShow ModelConfigLeave
!macroend

# 仅在「安装构建」中编译本页函数与变量；卸载构建不引用它们，
# 否则 warning 6001/6010（变量/函数未被引用）会导致构建失败。
!ifndef BUILD_UNINSTALLER
Var ModelCfgDialog
Var ModelCfgEndpointBox
Var ModelCfgModelBox
Var ModelCfgKeyBox
Var ModelCfgSkipBox
Var ModelCfgEndpointVal
Var ModelCfgModelVal
Var ModelCfgKeyVal
Var ModelCfgSkipVal

# full 版「选择默认模式」页的控件与状态变量（仅 full 版编译，避免其他版未使用告警）
!ifdef EDITION_FULL
Var ModeSelectDialog
Var ModeSelectLocal
Var ModeSelectRemote
Var ModeSelectVal

# ──────────────────────────────────────────────────────────────────────
# full 版安装向导「选择默认模式」页（仅在 EDITION="full" 时插入）
# 写入 $APPDATA\akisaki-kirari\pet-client.config.json 的 mode 字段，
# 主程序据此决定本地启动后端还是连接远程服务端。
# 升级 / 重装（pet-client.config.json 已存在）则跳过本页。
# ──────────────────────────────────────────────────────────────────────
Function ModeSelectShow
  ${If} ${FileExists} "$APPDATA\akisaki-kirari\pet-client.config.json"
    Abort
  ${EndIf}

  nsDialogs::Create 1018
  Pop $ModeSelectDialog
  ${If} $ModeSelectDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0    100% 16u "选择默认工作模式"
  ${NSD_CreateLabel} 0 18u  100% 30u "本地部署：随程序启动内置后端，无需额外服务器。$\r$\n连接远程服务端：连接你已经部署好的 Kirari 服务端（稍后在设置中填写地址）。"

  ${NSD_CreateRadioButton} 0 54u 100% 14u "本地部署（推荐，后端已随安装包附带）"
  Pop $ModeSelectLocal
  ${NSD_CreateRadioButton} 0 72u 100% 14u "连接远程服务端"
  Pop $ModeSelectRemote

  ; 默认选中「本地部署」
  ${NSD_Check} $ModeSelectLocal
  nsDialogs::Show
FunctionEnd

Function ModeSelectLeave
  ${NSD_GetState} $ModeSelectLocal $1
  ${NSD_GetState} $ModeSelectRemote $2
  ${If} $2 == 1
    StrCpy $ModeSelectVal "remote"
  ${Else}
    StrCpy $ModeSelectVal "local"
  ${EndIf}

  CreateDirectory "$APPDATA\akisaki-kirari"
  ${If} $ModeSelectVal == "remote"
    FileOpen $R0 "$APPDATA\akisaki-kirari\pet-client.config.json" w
    FileWrite $R0 "{$\"mode$\":$\"remote$\",$\"server$\":{$\"wsUrl$\":$\"$\",$\"httpUrl$\":$\"$\"},$\"builtinToken$\":$\"kirari-local-builtin$\"}"
    FileClose $R0
  ${Else}
    FileOpen $R0 "$APPDATA\akisaki-kirari\pet-client.config.json" w
    FileWrite $R0 "{$\"mode$\":$\"local$\",$\"server$\":{$\"wsUrl$\":$\"ws://localhost:9089/ws$\",$\"httpUrl$\":$\"http://localhost:9089$\"},$\"builtinToken$\":$\"kirari-local-builtin$\"}"
    FileClose $R0
  ${EndIf}
FunctionEnd
!endif ; EDITION_FULL

Function ModelConfigShow
  ; ══════════════════════════════════════════════════════════════════
  ; 升级 / 重装检测：已有配置文件则完全跳过本页
  ; 用户将直接从「选择安装目录」进入「安装」确认，体验更流畅
  ; ══════════════════════════════════════════════════════════════════
  ${If} ${FileExists} "$APPDATA\akisaki-kirari\config.json"
    Abort
  ${EndIf}

  ; ══════════════════════════════════════════════════════════════════
  ; 按版本跳过「模型配置」页：
  ;   - 纯前端版（frontend）：无本地后端，模型在服务端配置，无需本页。
  ;   - full 版且用户选了「远程」：同样无本地后端，跳过本页。
  ; ══════════════════════════════════════════════════════════════════
  !ifdef EDITION_FRONTEND
    Abort
  !endif
  !ifdef EDITION_FULL
    ${If} $ModeSelectVal == "remote"
      Abort
    ${EndIf}
  !endif

  nsDialogs::Create 1018
  Pop $ModelCfgDialog
  ${If} $ModelCfgDialog == error
    Abort
  ${EndIf}

  ; ── 标题 ──────────────────────────────────────────────────────
  ${NSD_CreateLabel} 0 0      100% 14u "模型配置"

  ${NSD_CreateLabel} 0 16u    100% 18u "配置大模型连接信息。本地部署模式也需要填写（这是调用大模型的密钥，不是本地后端地址），留空可稍后在程序「设置」中填写。"

  ; ── API Endpoint（标签与输入框同行，节省垂直空间） ────────
  ${NSD_CreateLabel}   0 40u   75u 12u "API Endpoint："
  ${NSD_CreateText}    78u 38u  180u 14u "https://api.chatanywhere.tech/v1"
  Pop $ModelCfgEndpointBox

  ; ── 模型名称 ─────────────────────────────────────────────────
  ${NSD_CreateLabel}   0 58u   75u 12u "模型名称："
  ${NSD_CreateText}    78u 56u  180u 14u "gpt-5.4-mini"
  Pop $ModelCfgModelBox

  ; ── API Key（显式宽度 180u，避免 100% 宽度在部分 DPI/主题下溢出导致不可见） ──
  ${NSD_CreateLabel}   0 76u   75u 12u "API Key："
  ${NSD_CreatePassword}78u 74u  180u 14u ""
  Pop $ModelCfgKeyBox

  ; ── 跳过勾选框（压缩纵向间距，确保密钥框与勾选框均在可见区域内） ──
  ${NSD_CreateCheckBox} 0 96u   100% 12u "跳过，稍后再配置"
  Pop $ModelCfgSkipBox

  nsDialogs::Show
FunctionEnd

Function ModelConfigLeave
  ${NSD_GetText} $ModelCfgEndpointBox $ModelCfgEndpointVal
  ${NSD_GetText} $ModelCfgModelBox $ModelCfgModelVal
  ${NSD_GetText} $ModelCfgKeyBox $ModelCfgKeyVal
  ${NSD_GetState} $ModelCfgSkipBox $ModelCfgSkipVal

  ; 勾选"跳过"则不写入任何配置
  ${If} $ModelCfgSkipVal == 1
    Return
  ${EndIf}

  ; 写入 $APPDATA\akisaki-kirari\config.json（与 Electron userData 目录一致）
  CreateDirectory "$APPDATA\akisaki-kirari"
  FileOpen $R0 "$APPDATA\akisaki-kirari\config.json" w
  FileWrite $R0 "{$\"endpoint$\":$\"$ModelCfgEndpointVal$\",$\"model$\":$\"$ModelCfgModelVal$\",$\"key$\":$\"$ModelCfgKeyVal$\"}"
  FileClose $R0
FunctionEnd
!endif

# ============================================================================
# 安装向导「完成页」：保留默认「运行」复选框，新增「开机自动启动」复选框
#
# 通过 electron-builder 预留的 customFinishPage 钩子（替代默认 MUI_PAGE_FINISH）。
# - MUI_FINISHPAGE_RUN + StartApp：保留「安装完成后运行」勾选（默认勾选）。
# - MUI_FINISHPAGE_SHOWREADME 复用为「开机自动启动 Kirari绮莉」复选框，
#   配合 MUI_FINISHPAGE_SHOWREADME_NOTCHECKED 使默认【未勾选】
#   （满足用户要求：安装向导默认不开机启动；MUI 该框默认是勾选的，必须显式 NOTCHECKED）。
# - 勾选时触发 AutostartOnFinish：以 --set-auto-launch 一次性拉起本程序，
#   由主进程写入登录项后自行退出。与设置界面勾选共用同一套 Electron 登录项机制，
#   保证安装期勾选与设置界面勾选写入的是同一条登录项。
# 注：函数定义在宏体内，仅安装构建展开该宏时才会生成，卸载构建不会引用，避免未使用告警。
# ============================================================================
!macro customFinishPage
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_FINISHPAGE_SHOWREADME
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "开机自动启动 Kirari绮莉"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION "AutostartOnFinish"
  # MUI 的 SHOWREADME 复选框默认【勾选】；必须用 NOTCHECKED 才能默认不勾选
  !define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
  !insertmacro MUI_PAGE_FINISH

  Function StartApp
    ${If} ${isUpdated}
      StrCpy $1 "--updated"
    ${Else}
      StrCpy $1 ""
    ${EndIf}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function AutostartOnFinish
    Exec '"$INSTDIR\aki-kirari-pet.exe" --set-auto-launch'
  FunctionEnd
!macroend

# ============================================================================
# 桌面快捷方式使用「独立图标」（shortcut-icon.ico），与 exe 图标（app-icon.ico）区分
#
# 背景：electron-builder 默认用 exe 图标创建桌面快捷方式；其 addDesktopLink 宏在
# installSection.nsh 中于本宏之前被调用，且默认宏无法被 include 覆盖（会被重定义）。
# 因此这里利用 electron-builder 预留的 customInstall 钩子（在桌面快捷方式创建之后触发），
# 用 shortcut-icon.ico 重建同名桌面快捷方式，覆盖默认图标。
# $newDesktopLink / $appExe / $INSTDIR / ${APP_ID} / ${APP_DESCRIPTION} 此刻均已就绪。
# shortcut-icon.ico 由 electron-builder.yml 的 extraFiles 打包进安装根目录（$INSTDIR）。
# ============================================================================
!macro customInstall
  CreateShortCut "$newDesktopLink" "$appExe" "" "$INSTDIR\shortcut-icon.ico" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"

  # ── 官方皮肤：安装阶段一次性释放到用户数据目录 ──────────────────────
  # 程序启动后不再替换/更新皮肤；升级时由安装包重新执行本宏处理。
  nsExec::ExecToLog 'powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File $\"$INSTDIR\install-avatars.ps1$\"'
  Pop $R0
  ${If} $R0 != "0"
    DetailPrint "官方皮肤安装脚本返回: $R0"
  ${EndIf}
  # 注意：此处保留 $INSTDIR\resources\official-avatars 作为 bundled resource。
  # 它同时作为「主进程首次启动兜底复制」的素材源（ensureDefaultAvatars 在
  # userData/avatars 为空时从 process.resourcesPath/official-avatars 复制一次）。
  # 运行时只复制一次、绝不覆盖用户已存在的自定义皮肤。
!macroend

# ============================================================================
# 卸载前清理：移除「开机自动启动」登录项
#
# 通过 electron-builder 预留的 customUnInstall 钩子（卸载区段中被调用）。
# 以 --clear-auto-launch 一次性拉起本程序，由主进程调用
# app.setLoginItemSettings({ openAtLogin: false }) 移除 HKCU\...\Run 下的登录项后自行退出，
# 与设置界面 / 安装向导写入的是同一条登录项，保证清理干净。
# 仅卸载构建期展开本宏（避免安装构建引用未定义符号触发告警）。
# ============================================================================
!ifdef BUILD_UNINSTALLER
# ── 卸载前可选「清除所有配置和个人数据」自定义页 ──────────────────────
# 在确认卸载前插入一个勾选页：勾选后于 customUnInstall 中删除
# %APPDATA%\akisaki-kirari 与 %LOCALAPPDATA%\akisaki-kirari（配置/登录态/皮肤/日志全清）。
# 默认不勾选，避免误删；仅卸载构建展开本段，安装构建不引用。
Var UninstCleanChk
Var UninstCleanState

Function un.CleanDataShow
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 28u "删除程序时，是否同时清除本机上的所有个人数据？"
  ${NSD_CreateLabel} 0 30u 100% 32u "包括配置文件、登录态、已下载皮肤与日志（位于 %APPDATA%\akisaki-kirari 与 %LOCALAPPDATA%\akisaki-kirari）。此操作不可恢复。"
  ${NSD_CreateCheckBox} 0 66u 100% 12u "同时清除所有配置和个人数据"
  Pop $UninstCleanChk
  nsDialogs::Show
FunctionEnd

Function un.CleanDataLeave
  ${NSD_GetState} $UninstCleanChk $UninstCleanState
FunctionEnd

Page custom un.CleanDataShow un.CleanDataLeave

!macro customUnInstall
  ClearErrors
  ExecWait '"$INSTDIR\aki-kirari-pet.exe" --clear-auto-launch' $R0
  ${If} $R0 != "0"
    DetailPrint "清理开机启动登录项返回: $R0"
  ${EndIf}
  ${If} $UninstCleanState == 1
    ${If} $APPDATA != ""
      RMDir /r "$APPDATA\akisaki-kirari"
    ${EndIf}
    ${If} $LOCALAPPDATA != ""
      RMDir /r "$LOCALAPPDATA\akisaki-kirari"
    ${EndIf}
    DetailPrint "已清除配置与个人数据"
  ${EndIf}
!macroend
!endif
