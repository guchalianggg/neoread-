"""Dependency-free shared VPN portal and legacy console navigation shell.

Design contract
- Mission: unify shared usage, connection trust, keys, and bridge management.
- Preserve the host's system font / white surfaces / cyan identity; no assets/CDN.
- Tokens: ink #1b2537, muted #596b80, surface #fff, canvas #f4f7fb,
  accent #087e9c, success #08785e, danger #b42336; 4/8px spacing rhythm;
  8/12/16px radii; 120ms feedback, 240ms state entrance, reduced-motion off.
- Do: semantic controls, visible focus, honest unknowns, isolated error states.
- Don't: infer VPN presence, persist full keys, invent costs or hide management.
- Assumptions: epochs are seconds (ISO timestamps are also tolerated); all-time
  API aggregates outlive retained details; capacity is informational, not a
  client-enforced quota. All VPN members may manage the bridge via /console;
  this module adds no management API or authentication. Mutations aren't retried.
"""

from html import escape as _escape
import re as _re
from urllib.parse import urlsplit as _urlsplit, urlunsplit as _urlunsplit

PORTAL_HTML = r'''<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="referrer" content="no-referrer">
<title>LocalHttpsBridge · 共享接入门户</title>
<style>
:root{--bg:#f4f7fb;--card:#fff;--line:#e2e8f2;--txt:#1b2537;--dim:#596b80;--ac:#087e9c;--tint:#edf9fc;--ok:#08785e;--ok-bg:#eaf8f1;--bad:#b42336;--bad-bg:#fff1f2;--warn:#865714;--warn-bg:#fff8e8;--radius:16px;--mono:Consolas,"Cascadia Mono",monospace;--spring:cubic-bezier(.2,.8,.2,1)}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.6 "Segoe UI",system-ui,-apple-system,"Microsoft YaHei",sans-serif}button,input,textarea{font:inherit}button,a,input,textarea,summary,[tabindex]{-webkit-tap-highlight-color:transparent}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.48}button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:3px solid var(--ac);outline-offset:3px}a{color:var(--ac);text-underline-offset:4px}h1,h2,h3,p{margin:0}h1{font-size:28px;line-height:1.3;letter-spacing:-.8px}h2{font-size:17px;line-height:1.5}h3{font-size:14px}small,.small{font-size:12px}.muted{color:var(--dim)}.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}.break{overflow-wrap:anywhere;word-break:break-word}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;clip-path:inset(50%);overflow:hidden;white-space:nowrap}.skip{position:fixed;top:8px;left:8px;z-index:20;transform:translateY(-150%);padding:8px 16px;background:var(--card)}.skip:focus{transform:translateY(0)}[hidden]{display:none!important}
.topbar{background:var(--card);border-bottom:1px solid var(--line)}.top-inner{max-width:1440px;margin:auto;padding:16px 32px;display:flex;align-items:center;gap:32px;flex-wrap:wrap}.brand{display:flex;align-items:center;gap:12px}.brand-mark{display:grid;place-items:center;width:40px;height:40px;background:var(--ac);border-radius:12px;color:white;flex:none}.brand-name{font-weight:750;font-size:16px;line-height:1.3}.brand-sub{font-size:11px;color:var(--dim);letter-spacing:1px}.nav{display:flex;gap:8px;flex-wrap:wrap}.nav a{text-decoration:none;color:var(--dim);padding:8px 12px;border-radius:8px;font-size:13px;font-weight:600}.nav a:hover{background:var(--tint);color:var(--ac)}.nav a:first-child{color:var(--ac);background:var(--tint)}.connection{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dim)}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}.connection[data-state=ok]{color:var(--ok)}.connection[data-state=error]{color:var(--bad)}
.wrap{max-width:1440px;margin:auto;padding:32px 32px 24px}.intro{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:24px;flex-wrap:wrap}.eyebrow{color:var(--ac);font-size:11px;font-weight:700;letter-spacing:2px;margin-bottom:8px}.intro p{margin-top:8px;color:var(--dim);font-size:13px}.refresh-area{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:40px;padding:8px 16px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--txt);font-weight:600;font-size:13px;text-decoration:none;transition:background-color 120ms,border-color 120ms,transform 120ms}.btn:not(:disabled):hover{background:var(--tint);border-color:#9bc9d5}.btn:not(:disabled):active{transform:translateY(1px)}.btn.primary{background:var(--ac);color:#fff;border-color:var(--ac)}.btn.primary:not(:disabled):hover{background:#06677e}.btn.danger{color:var(--bad);border-color:#ebbac1}.btn.danger:not(:disabled):hover{background:var(--bad-bg)}.btn.compact{min-height:32px;padding:4px 12px;font-size:12px}.btn svg{width:16px;height:16px;flex:none}.panel{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:0 2px 4px #1b253703;min-width:0}.panel-head{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;padding:20px 24px}.panel-head p{margin-top:4px;font-size:12px;color:var(--dim)}.badge{display:inline-flex;align-items:center;gap:6px;border-radius:6px;font-size:11px;font-weight:600;padding:3px 8px;background:#eef2f7;color:var(--dim);white-space:nowrap}.badge.ok{background:var(--ok-bg);color:var(--ok)}.badge.bad{background:var(--bad-bg);color:var(--bad)}.badge.accent{background:var(--tint);color:var(--ac)}.heading-line{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.access{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(220px,1fr);margin-bottom:24px}.endpoint{padding:20px 24px;border-right:1px solid var(--line)}.label{font-size:11px;color:var(--dim);font-weight:600;letter-spacing:.5px}.endpoint-line{display:flex;align-items:center;gap:16px;justify-content:space-between;margin:8px 0}.endpoint code{font-size:17px;font-weight:600;min-width:0}.connection-meta{padding:20px 24px;display:flex;flex-direction:column;justify-content:center;gap:12px}.meta-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.certificate{grid-column:1/-1;border-top:1px solid var(--line);padding:0 24px}.certificate summary{cursor:pointer;min-height:44px;padding:12px 0;color:var(--dim);font-size:12px}.cert-content{padding:4px 0 20px;display:grid;gap:12px}.fingerprint-line{display:flex;align-items:center;gap:12px}.fingerprint-line code{min-width:0;flex:1;font-size:12px;overflow-wrap:anywhere;background:var(--bg);border:1px solid var(--line);padding:12px;border-radius:8px}.cert-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.notice,.error,.hint{font-size:12px;border-radius:8px;padding:12px 16px;overflow-wrap:anywhere}.notice{margin-bottom:24px;background:var(--tint);color:#126176;border:1px solid #caeaf2}.error{color:var(--bad);background:var(--bad-bg);border:1px solid #f1cdd3;margin:0 24px 16px}.error p+p{margin-top:4px}.hint{color:var(--warn);background:var(--warn-bg);border:1px solid #f1dfb6}.inline-error{font-size:12px;color:var(--bad);margin-top:8px}
.section-top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:16px}.section-top p{font-size:12px;color:var(--dim);margin-top:4px}.segments,.tabs{display:flex;gap:4px;flex-wrap:wrap}.segments{padding:4px;background:#e9eff5;border-radius:10px}.segment{min-height:32px;border:0;background:transparent;color:var(--dim);font-size:12px;padding:4px 12px;border-radius:6px;font-weight:600}.segment:hover{background:#ffffff80}.segment[aria-pressed=true]{background:white;color:var(--ac);box-shadow:0 1px 3px #1b253714}.custom-range{display:flex;align-items:end;gap:12px;flex-wrap:wrap;margin:0 0 16px;padding:16px 20px}.field{display:flex;flex-direction:column;gap:6px;min-width:0}.field label{font-size:12px;color:var(--dim);font-weight:600}input,textarea{color:var(--txt);border:1px solid #ccd7e3;background:var(--card);border-radius:8px;min-height:40px;padding:8px 12px;max-width:100%}input:focus,textarea:focus{border-color:var(--ac)}input[aria-invalid=true]{border-color:var(--bad)}.range-message{width:100%;font-size:12px;color:var(--dim)}.range-message[data-error=true]{color:var(--bad)}
.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:24px}.metric{padding:20px;position:relative;animation:enter 240ms var(--spring) both}.metric:nth-child(2n){animation-delay:32ms}.metric:nth-child(3n){animation-delay:64ms}.metric-title{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;color:var(--dim)}.metric-glyph{font-size:14px;color:var(--ac);background:var(--tint);width:28px;height:28px;display:grid;place-items:center;border-radius:8px}.metric-value{font-size:28px;line-height:1.25;font-weight:700;letter-spacing:-.5px;font-variant-numeric:tabular-nums;margin:12px 0 8px;overflow-wrap:anywhere}.metric-value small{font-size:13px;font-weight:400;letter-spacing:0;color:var(--dim)}.metric-foot{color:var(--dim);font-size:11px;min-height:18px;overflow-wrap:anywhere}.metric.success .metric-value{color:var(--ok)}.metric.failed .metric-value{color:var(--bad)}.section-gap{margin-bottom:24px}.tabs{padding:4px;border:1px solid var(--line);border-radius:10px;background:#f8fafc}.tab{background:transparent;border:0;color:var(--dim);border-radius:6px;min-height:32px;padding:4px 12px;display:flex;gap:8px;align-items:center;font-size:12px;font-weight:600}.tab:hover{background:var(--tint)}.tab[aria-selected=true]{background:white;color:var(--ac);box-shadow:0 1px 4px #1b253717}.count{background:#e9eff5;border-radius:4px;padding:0 5px;font-size:10px;font-variant-numeric:tabular-nums}.tab[aria-selected=true] .count{background:var(--tint)}
.table-scroll{overflow:auto;border-top:1px solid var(--line);border-bottom-left-radius:16px;border-bottom-right-radius:16px;max-width:100%}table{border-collapse:collapse;width:100%;text-align:left;font-size:12px;table-layout:fixed}th{background:#f8fafc;color:var(--dim);font-size:11px;font-weight:600;padding:12px 24px;border-bottom:1px solid var(--line);white-space:nowrap}td{padding:14px 24px;border-bottom:1px solid #edf1f6;vertical-align:middle;overflow-wrap:anywhere}tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:#fbfdff}td.number,th.number{text-align:right;font-variant-numeric:tabular-nums}.group-table{min-width:850px}.group-table th:first-child{width:25%}.group-table th:nth-child(4){width:17%}.group-name{font-weight:600;overflow-wrap:anywhere}.bar-track{height:3px;margin-top:8px;background:#edf4f7;border-radius:2px;max-width:160px}.bar-fill{height:100%;background:#62b6cb;border-radius:2px;min-width:0;transition:width 240ms var(--spring)}.cell-sub{color:var(--dim);font-size:10px;margin-top:3px}.empty{text-align:center!important;padding:32px 24px!important;color:var(--dim);font-size:12px}.table-note{font-size:11px;color:var(--dim);padding:12px 24px;border-top:1px solid var(--line)}.dual{display:grid;grid-template-columns:minmax(0,1fr);gap:24px;margin-bottom:24px}.devices-table{min-width:720px}.devices-table th:first-child{width:23%}.keys-table{min-width:760px}.keys-table th:first-child{width:23%}.keys-table th:last-child{width:100px}.key-form{display:flex;align-items:end;gap:12px;padding:0 24px 20px;flex-wrap:wrap}.key-form .field{flex:1;min-width:180px;max-width:400px}.key-form .form-note{flex-basis:100%;font-size:11px;color:var(--dim)}.details-table{min-width:1180px}.details-table th,.details-table td{padding:12px 16px}.details-table th:nth-child(1){width:145px}.details-table th:nth-child(2){width:120px}.details-table th:nth-child(3){width:160px}.details-table th:nth-child(4){width:145px}.details-table th:nth-child(5){width:190px}.details-table th:nth-child(6){width:110px}.details-table th:nth-child(8){width:130px}.pager{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 24px;border-top:1px solid var(--line);font-size:11px;color:var(--dim)}.pager-controls{display:flex;gap:8px}.foot{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;color:var(--dim);font-size:11px;padding:0 4px}.foot p{max-width:850px}
dialog{border:1px solid var(--line);padding:0;border-radius:16px;width:min(540px,calc(100% - 32px));max-height:calc(100dvh - 32px);color:var(--txt);background:var(--card);box-shadow:0 24px 80px #19334d30;animation:enter 200ms var(--spring)}dialog::backdrop{background:#132a4266}.dialog-inner{padding:24px}.dialog-title{display:flex;align-items:center;gap:12px;margin-bottom:16px}.dialog-symbol{display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--ok-bg);color:var(--ok);font-size:20px;flex:none}.dialog-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:20px}.secret{display:block;width:100%;min-height:96px;font:13px/1.6 var(--mono);resize:vertical;margin-top:12px;overflow-wrap:anywhere}.dialog-message{font-size:12px;margin-top:12px;overflow-wrap:anywhere}.toast{position:fixed;bottom:24px;left:50%;transform:translate(-50%,16px);max-width:calc(100% - 32px);border:1px solid #b7d6df;background:#fff;box-shadow:0 8px 32px #1b253714;padding:12px 20px;border-radius:10px;font-size:12px;opacity:0;pointer-events:none;z-index:30;transition:opacity 160ms,transform 200ms var(--spring);overflow-wrap:anywhere}.toast.show{opacity:1;transform:translate(-50%,0)}@keyframes enter{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@media(min-width:1550px){.dual{grid-template-columns:minmax(0,1fr) minmax(0,1.08fr)}.dual .devices-table{min-width:620px}.dual .keys-table{min-width:680px}}
@media(max-width:1000px){.top-inner{gap:16px;padding:16px 24px}.nav{order:3;width:100%;border-top:1px solid var(--line);padding-top:12px}.wrap{padding:24px}.access{grid-template-columns:minmax(0,1fr)}.endpoint{border-right:0;border-bottom:1px solid var(--line)}.connection-meta{flex-direction:row;justify-content:space-between;flex-wrap:wrap}.connection-meta .meta-row{gap:16px}.metric{padding:16px}.metric-value{font-size:25px}}
@media(max-width:640px){h1{font-size:24px}.top-inner{padding:16px;gap:12px}.brand-name{font-size:14px}.brand-mark{width:36px;height:36px}.connection{font-size:11px}.nav{gap:0;justify-content:space-between}.nav a{padding:6px 8px;font-size:12px}.wrap{padding:24px 16px}.intro{gap:16px}.refresh-area{width:100%;justify-content:space-between}.metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.metric{padding:16px 12px}.metric-value{font-size:24px}.metric-glyph{width:24px;height:24px;font-size:12px}.metric-title{font-size:11px}.metric-foot{font-size:10px}.endpoint,.connection-meta{padding:16px}.endpoint code{font-size:13px}.endpoint-line{gap:8px}.certificate{padding:0 16px}.fingerprint-line{align-items:stretch;flex-direction:column}.fingerprint-line .btn{align-self:flex-start}.panel-head{padding:16px}.tabs{width:100%}.tab{flex:1;justify-content:center;padding:4px 8px}.section-top{gap:12px}.segments{width:100%}.segment{flex:1;padding:4px 6px}.custom-range{padding:16px}.custom-range .field{width:100%}.custom-range input{width:100%;min-width:0}.error{margin:0 16px 16px}.key-form{padding:0 16px 16px;gap:8px}.key-form .field{max-width:none}.key-form>.btn{width:100%}.pager,.table-note{padding:12px 16px}.dialog-inner{padding:20px}.foot{gap:8px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*::before,*::after{animation:none!important;transition:none!important}}
.nav a[aria-current=page]{color:var(--ac);background:var(--tint)}.nav a:first-child:not([aria-current=page]){color:var(--dim);background:transparent}.nav a:first-child:not([aria-current=page]):hover{color:var(--ac);background:var(--tint)}.nav a{display:inline-flex;align-items:center;gap:6px;min-height:40px}.nav-count{font-size:10px;min-width:16px;text-align:center;background:#e9eff5;color:var(--dim);border-radius:4px;padding:0 4px}.nav a[aria-current=page] .nav-count{background:#d9f0f6;color:var(--ac)}.portal-page{min-width:0;margin-bottom:24px}.page-title:focus{outline:none}.page-title:focus-visible{outline:3px solid var(--ac);outline-offset:6px;border-radius:4px}.page-intro-text{max-width:800px}.stats-filters{min-width:0}.nav{gap:4px}
@media(max-width:640px){.nav{justify-content:flex-start;gap:4px}.nav a{padding:6px 8px;min-height:40px}.nav a:last-child{margin-left:0}.connection{margin-left:auto}.intro .page-intro-text{width:100%}}
</style>
</head>
<body>
<a href="#main" class="skip">跳至主要内容</a>
<header class="topbar"><div class="top-inner">
  <div class="brand"><div class="brand-mark" aria-hidden="true"><svg width="25" height="25" viewBox="0 0 28 28" fill="none"><path d="M4 19h20M7 19V8m14 11V8M7 11c4 6 10 6 14 0M4 23v-4m20 4v-4M10 14v5m4-3v3m4-5v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></div><div><div class="brand-name">LocalHttpsBridge</div><div class="brand-sub">共享接入门户</div></div></div>
  <nav class="nav" aria-label="页面导航"><a href="/" data-route="overview" aria-current="page">概览</a><a href="/portal/devices" data-route="devices">在线设备 <span class="nav-count" id="navOnline" aria-label="在线数量">—</span></a><a href="/portal/keys" data-route="keys">Key 自助 <span class="nav-count" id="navKeys" aria-label="有效 Key 数量">—</span></a><a href="/portal/requests" data-route="requests">请求明细</a><a href="/console">桥接配置</a></nav>
  <div class="connection" id="connection" data-state="loading" role="status"><span class="dot" aria-hidden="true"></span><span id="connectionText">正在连接</span></div>
</div></header>
<main class="wrap" id="main" tabindex="-1">
  <section class="intro" aria-labelledby="pageTitle"><div class="page-intro-text"><div class="eyebrow" id="pageEyebrow">BRIDGE / OVERVIEW</div><h1 id="pageTitle" class="page-title" tabindex="-1">连接有序，用量清晰。</h1><p id="pageDescription">VPN 成员均可查看用量、签发 Key，以及管理后端配置与启停。</p></div><div class="refresh-area"><span class="small muted" id="lastRefresh">每 5 秒自动刷新</span><button class="btn" id="refresh" type="button"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M16 7a6.5 6.5 0 1 0 .2 5M16 3v4h-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span id="refreshLabel">刷新数据</span></button></div></section>
  <article class="portal-page" id="overviewPage" data-page="overview" aria-labelledby="pageTitle">
  <section class="panel access" id="access" aria-label="接入信息">
    <div class="endpoint"><div class="label">API BASE URL</div><div class="endpoint-line"><code class="mono break" id="apiUrl">正在获取接入地址…</code><button class="btn compact" id="copyApi" disabled type="button">复制地址</button></div><p class="small muted">填入客户端的 Base URL；使用下方签发的接入 Key。</p></div>
    <div class="connection-meta"><div class="meta-row"><span class="label">RADMIN VPN IP</span><span class="mono" id="vpnIp">—</span></div><div class="meta-row"><span class="badge" id="vpnStatus">检测中</span><span class="small muted" id="capacity">服务容量 —</span></div></div>
    <details class="certificate"><summary>首次接入？下载并核对根证书 <span aria-hidden="true">↗</span></summary><div class="cert-content"><p class="small muted">通过可信渠道与桥接机持有人核对 SHA-256 根指纹，一致后再在当前设备信任下载的根证书。证书信任只作用于当前设备；VPN 成员也可从「桥接配置」管理后端与启停。</p><div class="fingerprint-line"><code class="mono" id="certFp">正在获取根证书指纹…</code><button class="btn compact" id="copyFp" type="button" disabled>复制根指纹</button></div><div class="cert-actions"><a href="/cert" class="btn compact" download>下载根证书</a><span class="small muted">下载不会自动安装或建立信任。</span></div></div></details>
  </section>
  <div class="error" id="infoError" role="alert" hidden></div><div class="notice" id="notice" hidden></div>
  <section id="overview" aria-labelledby="overviewTitle">
    <section id="statsFilters" class="stats-filters" aria-labelledby="overviewTitle">
    <div class="section-top"><div><h2 id="overviewTitle">用量概览</h2><p id="rangeCaption">全部时间 · 累计汇总；明细保留 30 天</p></div><div class="segments" role="group" aria-label="统计时间范围"><button class="segment" data-range="all" aria-pressed="true" type="button">全部</button><button class="segment" data-range="today" aria-pressed="false" type="button">今天</button><button class="segment" data-range="7d" aria-pressed="false" type="button">近 7 天</button><button class="segment" data-range="30d" aria-pressed="false" type="button">近 30 天</button><button class="segment" data-range="custom" aria-pressed="false" type="button">自定义</button></div></div>
    <form id="rangeForm" class="panel custom-range" hidden><div class="field"><label for="since">开始时间（本地）</label><input type="datetime-local" id="since" required></div><div class="field"><label for="until">结束时间（本地）</label><input type="datetime-local" id="until" required></div><button class="btn primary" type="submit">应用时间</button><p class="range-message" id="rangeMessage" role="status">按当前设备时区筛选。</p></form>
    <div class="error" id="statsError" role="alert" hidden></div>
    </section>
    <div class="metrics" id="metrics" aria-busy="true">
      <article class="panel metric"><div class="metric-title">总请求数<span class="metric-glyph" aria-hidden="true">↗</span></div><div class="metric-value" id="requests">—</div><p class="metric-foot" id="requestsFoot">正在加载统计</p></article>
      <article class="panel metric success"><div class="metric-title">成功请求<span class="metric-glyph" aria-hidden="true">✓</span></div><div class="metric-value" id="success">—</div><p class="metric-foot" id="successFoot">成功率 —</p></article>
      <article class="panel metric failed"><div class="metric-title">失败请求<span class="metric-glyph" aria-hidden="true">!</span></div><div class="metric-value" id="failed">—</div><p class="metric-foot">按桥接器记录的结果统计</p></article>
      <article class="panel metric"><div class="metric-title">平均耗时<span class="metric-glyph" aria-hidden="true">◷</span></div><div class="metric-value" id="latency">—</div><p class="metric-foot">请求总耗时，非首 Token 延迟</p></article>
      <article class="panel metric"><div class="metric-title">上行流量<span class="metric-glyph" aria-hidden="true">↑</span></div><div class="metric-value" id="upload">—</div><p class="metric-foot">应用请求体 · 发往上游</p></article>
      <article class="panel metric"><div class="metric-title">下行流量<span class="metric-glyph" aria-hidden="true">↓</span></div><div class="metric-value" id="download">—</div><p class="metric-foot">应用响应体 · 返回客户端</p></article>
      <article class="panel metric"><div class="metric-title">已知 Token<span class="metric-glyph" aria-hidden="true">#</span></div><div class="metric-value" id="tokens">—</div><p class="metric-foot" id="tokensFoot">输入 — / 输出 —</p></article>
      <article class="panel metric"><div class="metric-title">Token 未知请求<span class="metric-glyph" aria-hidden="true">?</span></div><div class="metric-value" id="unknown">—</div><p class="metric-foot" id="unknownFoot">未返回 usage，不代表消耗为零</p></article>
    </div>
    <section class="panel section-gap" aria-labelledby="groupsTitle"><div class="panel-head"><div><h2 id="groupsTitle">用量分组</h2><p>按请求数排序，快速定位使用来源。</p></div><div class="tabs" role="tablist" aria-label="分组维度"><button class="tab" id="tab-models" role="tab" aria-selected="true" aria-controls="groupPanel" tabindex="0" data-group="models" type="button">模型 <span class="count" id="count-models">—</span></button><button class="tab" id="tab-ips" role="tab" aria-selected="false" aria-controls="groupPanel" tabindex="-1" data-group="ips" type="button">IP <span class="count" id="count-ips">—</span></button><button class="tab" id="tab-keys" role="tab" aria-selected="false" aria-controls="groupPanel" tabindex="-1" data-group="keys" type="button">Key <span class="count" id="count-keys">—</span></button></div></div><div id="groupPanel" role="tabpanel" aria-labelledby="tab-models"><div class="table-scroll" tabindex="0" role="region" aria-label="用量分组，可横向滚动"><table class="group-table"><thead><tr><th scope="col" id="groupName">模型</th><th scope="col" class="number">请求</th><th scope="col" class="number">成功 / 失败</th><th scope="col" class="number">上行 / 下行</th><th scope="col" class="number">平均耗时</th><th scope="col" class="number">已知 Token</th><th scope="col" class="number">未知请求</th></tr></thead><tbody id="groupRows"><tr><td colspan="7" class="empty">正在加载用量分组…</td></tr></tbody></table></div></div><p class="table-note">Token 仅汇总已返回的 usage；未知不记为零，不估算费用。</p></section>
  </section>
  </article>
    <section class="panel portal-page" id="devices" data-page="devices" aria-labelledby="devicesTitle" hidden><div class="panel-head"><div><div class="heading-line"><h2 id="devicesTitle">在线设备</h2><span class="badge ok" id="onlineCount">— 在线</span></div><p>正在调用或最近 5 分钟有活动即在线，不扫描 VPN 网络。</p></div><span class="small muted" id="deviceCount">已观察 — 台</span></div><div class="error" id="devicesError" role="alert" hidden></div><div class="table-scroll" tabindex="0" role="region" aria-label="设备列表，可横向滚动"><table class="devices-table"><thead><tr><th scope="col">设备 IP</th><th scope="col">状态 / 活动请求</th><th scope="col">最近活动</th><th scope="col" class="number">请求</th><th scope="col" class="number">上行 / 下行</th></tr></thead><tbody id="deviceRows"><tr><td colspan="5" class="empty">正在加载设备…</td></tr></tbody></table></div><p class="table-note">门户心跳也会更新活动时间；设备列表不受统计时间筛选影响。</p></section>
    <section class="panel portal-page" id="keys" data-page="keys" aria-labelledby="keysTitle" hidden><div class="panel-head"><div><div class="heading-line"><h2 id="keysTitle">Key 自助</h2><span class="badge accent" id="keyCount">— 有效</span></div><p>用设备名区分 Key。所有访问者均可签发或撤销任何 Key。</p></div></div><form class="key-form" id="keyForm"><div class="field"><label for="keyLabel">设备名称</label><input id="keyLabel" name="label" type="text" maxlength="64" placeholder="例如：书房电脑" autocomplete="off" required aria-describedby="keyFormNote keyError"></div><button class="btn primary" id="issueKey" type="submit">＋ 签发 Key</button><p class="form-note" id="keyFormNote">完整 Key 仅创建后显示一次，请及时保存。列表只显示脱敏前缀。</p><p class="inline-error" id="keyError" role="alert" hidden></p></form><div class="error" id="keysError" role="alert" hidden></div><div class="table-scroll" tabindex="0" role="region" aria-label="Key 列表，可横向滚动"><table class="keys-table"><thead><tr><th scope="col">设备名称</th><th scope="col">Key（脱敏）</th><th scope="col">创建时间</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody id="keyRows"><tr><td colspan="5" class="empty">正在加载 Key…</td></tr></tbody></table></div></section>
  <article class="portal-page" id="requestsPage" data-page="requests" aria-labelledby="pageTitle" hidden><div id="requestFilterSlot"></div>
  <section class="panel section-gap" id="details" aria-labelledby="detailsTitle"><div class="panel-head"><div><h2 id="detailsTitle">请求明细</h2><p>仅记录调用元数据，不包含提示词、图片或响应正文。</p></div><span class="badge" id="retention">保留 30 天</span></div><div class="table-scroll" tabindex="0" role="region" aria-label="请求明细，可横向滚动"><table class="details-table"><thead><tr><th scope="col">时间</th><th scope="col">来源 IP</th><th scope="col">模型</th><th scope="col">Key 标识</th><th scope="col">方法 / 路径</th><th scope="col">结果</th><th scope="col" class="number">耗时</th><th scope="col" class="number">上行 / 下行</th><th scope="col" class="number">Token</th></tr></thead><tbody id="detailRows"><tr><td colspan="9" class="empty">正在加载请求明细…</td></tr></tbody></table></div><div class="pager"><span id="pageInfo">— 条记录</span><div class="pager-controls"><button class="btn compact" id="prevPage" type="button" disabled>上一页</button><button class="btn compact" id="nextPage" type="button" disabled>下一页</button></div></div></section>
  </article>
  <footer class="foot"><p>统计口径：流量仅指应用层请求体 / 响应体，不是 VPN 总流量。明细按保留期清理，全部时间展示累计汇总；Token 未知不等于零。</p><span>LocalHttpsBridge · 共享门户</span></footer>
</main>
<dialog id="secretDialog" aria-labelledby="secretTitle" aria-describedby="secretWarning"><div class="dialog-inner"><div class="dialog-title"><span class="dialog-symbol" aria-hidden="true">✓</span><div><h2 id="secretTitle">Key 已签发</h2><p class="small muted break" id="secretDevice"></p></div></div><p class="hint" id="secretWarning">仅此一次显示完整 Key。请复制并保存在你的客户端；关闭后无法再次查看。所有门户访问者均可撤销此 Key。</p><label class="sr-only" for="secretValue">新签发的完整 Key</label><textarea id="secretValue" class="secret" readonly spellcheck="false" autocomplete="off"></textarea><p class="dialog-message muted" id="secretMessage" role="status">此 Key 不会存入浏览器持久存储。</p><div class="dialog-actions"><button class="btn" id="dismissSecret" type="button">清除并关闭</button><button class="btn primary" id="copySecret" type="button" autofocus>复制完整 Key</button></div></div></dialog>
<dialog id="revokeDialog" aria-labelledby="revokeTitle" aria-describedby="revokeDescription"><div class="dialog-inner"><h2 id="revokeTitle">确认撤销这个 Key？</h2><p class="small muted" id="revokeDescription" style="margin-top:12px">撤销后，使用此 Key 的客户端将无法继续接入，且不能恢复。其他 Key 不受影响。</p><p class="mono break" id="revokeTarget" style="margin-top:16px"></p><p class="dialog-message" id="revokeError" role="alert" hidden></p><div class="dialog-actions"><button class="btn" id="cancelRevoke" type="button" autofocus>取消</button><button class="btn danger" id="confirmRevoke" type="button">确认撤销</button></div></div></dialog>
<div class="toast" id="toast" role="status"></div>
<noscript><p class="error">此门户需要 JavaScript 才能读取状态与签发 Key；请启用后重新加载。</p></noscript>
<script>
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const state = {info:null,stats:null,devices:null,keys:null,range:'all',custom:null,group:'models',page:0,retention:30,busy:false,queued:false,mutation:false,revoke:null,filterVersion:0,keyVersion:0,revokeFocus:null};
  const routes={overview:{path:'/',title:'连接有序，用量清晰。',label:'概览',description:'VPN 成员均可查看用量、签发 Key，以及管理后端配置与启停。'},devices:{path:'/portal/devices',title:'在线设备',label:'在线设备',description:'观察桥接器的实际活动，而非扫描 VPN 网络。门户心跳与 API 调用都会更新活动。'},keys:{path:'/portal/keys',title:'Key 自助',label:'Key 自助',description:'为每台设备签发独立 Key。VPN 成员拥有相同权限，也可撤销任何接入 Key。'},requests:{path:'/portal/requests',title:'请求明细',label:'请求明细',description:'按时间查看调用元数据，不记录提示词、图片或响应正文。'}};
  function currentRoute(){const pathname=location.pathname.replace(/\/+$/,'')||'/';return Object.keys(routes).find(key=>routes[key].path===pathname)||'overview';}
  function renderRoute(key,focus=false){
    const route=routes[key];state.route=key;
    if($('secretDialog').open)clearSecret();if($('revokeDialog').open&&!state.mutation)$('revokeDialog').close();
    document.querySelectorAll('[data-page]').forEach(page=>{page.hidden=page.dataset.page!==key;});
    document.querySelectorAll('[data-route]').forEach(link=>{if(link.dataset.route===key)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');});
    if(key==='requests')$('requestFilterSlot').append($('statsFilters'));else if(key==='overview')$('overview').prepend($('statsFilters'));
    text('overviewTitle',key==='requests'?'明细时间范围':'用量概览');text('pageTitle',route.title);text('pageDescription',route.description);text('pageEyebrow','BRIDGE / '+key.toUpperCase());document.title='LocalHttpsBridge · '+route.label;
    if(focus){$('pageTitle').focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});}
  }
  const counts = new Intl.NumberFormat('zh-CN');
  const dateFmt = new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  const signatures = new Map();
  let toastTimer;
  const text = (id,value) => { $(id).textContent = String(value); };
  const num = value => typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const fmt = value => counts.format(num(value));
  const token = value => typeof value === 'number' && Number.isFinite(value) ? fmt(value) : '未知';
  function bytes(value) { let n=num(value),i=0;const units=['B','KB','MB','GB','TB'];while(n>=1024 && i<units.length-1){n/=1024;i++;}return (i ? n.toFixed(n>=100 ? 0 : 1) : String(Math.round(n)))+' '+units[i]; }
  const ms = value => num(value)>=1000 ? (num(value)/1000).toFixed(2)+' s' : Math.round(num(value))+' ms';
  function epoch(value) { if(typeof value==='number') return value>1e12 ? value/1000 : value;const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed/1000:0; }
  const stamp = value => epoch(value)>0 ? dateFmt.format(new Date(epoch(value)*1000)) : '—';
  const node = (tag,cls,value) => { const e=document.createElement(tag);if(cls)e.className=cls;if(value!==undefined)e.textContent=String(value);return e; };
  function showError(id,message) { text(id,message||'');$(id).hidden=!message; }
  function toast(message) { text('toast',message);$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),4000); }
  function errorText(error) { return error && error.name==='AbortError' ? '请求超时，请检查桥接器连接。' : (error && error.message || '网络请求失败，请稍后刷新。'); }
  async function api(path,body) {
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10000);
    try {
      const options={method:body===undefined?'GET':'POST',mode:'same-origin',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{'Accept':'application/json'}};
      if(body!==undefined){options.headers['Content-Type']='application/json';options.headers['X-Bridge-Portal']='1';options.body=JSON.stringify(body);}
      const response=await fetch('/portal/api/'+path,options);
      let data;try{data=await response.json();}catch{throw new Error('服务未返回有效 JSON（HTTP '+response.status+'）。');}
      if(!response.ok || !data || data.ok===false)throw new Error(data && typeof data.error==='string'?data.error:'请求失败（HTTP '+response.status+'）。');
      return data;
    } finally { clearTimeout(timer); }
  }
  async function copy(value,message) {
    if(!value) return false;
    try { if(!navigator.clipboard || !navigator.clipboard.writeText)throw new Error('clipboard unavailable');await navigator.clipboard.writeText(value);if(message)toast(message);return true; }
    catch { if(message)toast('复制不可用，请选中文字后手动复制。');return false; }
  }
  function fillRows(id,signature,rows,cols,empty) {
    if(signatures.get(id)===signature)return;
    signatures.set(id,signature);
    const active=document.activeElement;const focus=active && $(id).contains(active) ? active.dataset.focus : null;
    if(!rows.length){const row=node('tr');const cell=node('td','empty',empty);cell.colSpan=cols;row.append(cell);rows=[row];}
    $(id).replaceChildren(...rows);
    if(focus){const target=Array.from($(id).querySelectorAll('[data-focus]')).find(e=>e.dataset.focus===focus);if(target&&!target.disabled)target.focus();else{$('keysTitle').setAttribute('tabindex','-1');$('keysTitle').focus();}}
  }
  function cell(row,value,cls) { const td=node('td',cls,value);row.append(td);return td; }
  function flag(value,kind) { return node('span','badge '+(kind||''),value); }
  function keyName(id) { const key=(state.keys||[]).find(k=>String(k.id)===String(id));return key ? (String(key.label||'未命名')+' · '+String(key.prefix||'—')) : String(id||'未标识'); }
  function setRetention(value) { if(Number.isFinite(value)&&value>0)state.retention=value;text('retention','保留 '+state.retention+' 天');updateRangeCaption(); }
  function updateRangeCaption() {
    const labels={all:'全部时间 · 累计汇总；明细保留 '+state.retention+' 天',today:'今天 · 本地时间 00:00 至今','7d':'最近 7 天 · 滚动时间范围','30d':'最近 30 天 · 滚动时间范围'};
    const fullStamp=value=>new Date(value*1000).toLocaleString('zh-CN',{hour12:false});
    text('rangeCaption',state.range==='custom'&&state.custom ? '自定义 · '+fullStamp(state.custom.since)+' — '+fullStamp(state.custom.until)+'（本地时间）' : labels[state.range]||'自定义时间');
  }
  function query() {
    if(state.range==='all')return '';
    let until=Math.floor(Date.now()/1000),since;
    if(state.range==='custom')({since,until}=state.custom);
    else if(state.range==='today'){const start=new Date();start.setHours(0,0,0,0);since=Math.floor(start.getTime()/1000);}
    else since=until-(state.range==='7d'?7:30)*86400;
    return '?since='+since+'&until='+until;
  }
  function renderInfo(data) {
    state.info=data;text('apiUrl',data.api_url||'暂未提供接入地址');$('copyApi').disabled=!data.api_url;
    text('vpnIp',data.vpn_ip||'未检测到');text('vpnStatus',data.vpn_available?'VPN 地址可用':'VPN 地址不可用');$('vpnStatus').className='badge '+(data.vpn_available?'ok':'bad');
    text('capacity','服务容量 '+(Number.isFinite(data.capacity)?fmt(data.capacity):'—'));
    const fp=typeof data.cert_fp==='string'&&/^[a-f\d]{64}$/i.test(data.cert_fp)?data.cert_fp:'';
    text('certFp',fp?fp.toUpperCase().match(/.{1,4}/g).join(' '):'根指纹暂不可用，请向桥接机持有人核对。');$('copyFp').disabled=!fp;
    text('notice',data.notice||'');$('notice').hidden=!data.notice;setRetention(data.retention_days);
  }
  function renderStats(data) {
    if(!data.summary || typeof data.summary!=='object')throw new Error('统计响应缺少 summary，请稍后重试。');
    state.stats=data;setRetention(data.retention_days);const s=data.summary;const total=num(s.requests),known=num(s.usage_known);
    text('requests',fmt(total));text('requestsFoot',total?'当前统计范围内的调用':'当前范围暂无请求');text('success',fmt(s.success));text('successFoot','成功率 '+(total?(num(s.success)/total*100).toFixed(1)+'%':'—'));
    text('failed',fmt(s.failed));text('latency',total?ms(s.avg_ms):'—');text('upload',bytes(s.in_bytes));text('download',bytes(s.out_bytes));
    text('tokens',typeof s.total_tokens==='number'?fmt(s.total_tokens):(total?'—':'0'));text('tokensFoot',known?'输入 '+token(s.input_tokens)+' / 输出 '+token(s.output_tokens):'尚无可用 usage，不代表零消耗');text('unknown',fmt(s.usage_unknown));text('unknownFoot','已返回部分或全部 usage '+fmt(known)+' 次 / 全未知 '+fmt(s.usage_unknown)+' 次');
    for(const group of ['models','ips','keys'])text('count-'+group,fmt(Array.isArray(data[group])?data[group].length:0));
    renderGroups();renderDetails();$('metrics').setAttribute('aria-busy','false');
  }
  function renderGroups() {
    if(!state.stats)return;
    const groups=(Array.isArray(state.stats[state.group])?state.stats[state.group]:[]).slice().sort((a,b)=>num(b.requests)-num(a.requests));
    text('groupName',{models:'模型',ips:'来源 IP',keys:'Key（设备 / 脱敏前缀）'}[state.group]);
    const max=Math.max(1,...groups.map(g=>num(g.requests)));
    const rows=groups.map(g=>{const r=node('tr');const first=cell(r,'');first.append(node('div','group-name',state.group==='keys'?keyName(g.name):g.name||'未标识'));const track=node('div','bar-track');track.setAttribute('aria-hidden','true');const bar=node('div','bar-fill');bar.style.width=(num(g.requests)/max*100)+'%';track.append(bar);first.append(track);cell(r,fmt(g.requests),'number');cell(r,fmt(g.success)+' / '+fmt(g.failed),'number');cell(r,bytes(g.in_bytes)+' / '+bytes(g.out_bytes),'number');cell(r,num(g.requests)?ms(g.avg_ms):'—','number');cell(r,num(g.requests)?token(g.total_tokens):'0','number');cell(r,fmt(g.usage_unknown),'number');return r;});
    fillRows('groupRows',JSON.stringify([state.group,groups,state.keys]),rows,7,'当前时间范围暂无分组数据。发起 API 调用后，统计会自动更新。');
  }
  function renderDevices(data) {
    if(!Array.isArray(data.devices))throw new Error('设备列表响应格式不正确。');
    state.devices=data.devices;const now=Date.now()/1000;const online=d=>typeof d.online==='boolean'?d.online:epoch(d.last_seen)>0&&now-epoch(d.last_seen)<=300;
    const list=data.devices.slice().sort((a,b)=>Number(online(b))-Number(online(a))||epoch(b.last_seen)-epoch(a.last_seen));
    text('onlineCount',fmt(list.filter(online).length)+' 在线');text('deviceCount','已观察 '+fmt(list.length)+' 台');
    text('navOnline',fmt(list.filter(online).length));
    const rows=list.map(d=>{const r=node('tr');cell(r,d.ip||'未知','mono');const status=cell(r,'');status.append(flag(online(d)?'在线':'近期无活动',online(d)?'ok':''));status.append(node('div','cell-sub',fmt(d.active)+' 个活动请求'));cell(r,stamp(d.last_seen),'mono');cell(r,fmt(d.requests),'number');cell(r,bytes(d.in_bytes)+' / '+bytes(d.out_bytes),'number');return r;});
    fillRows('deviceRows',JSON.stringify([list,list.map(online)]),rows,5,'尚未观察到设备。设备访问门户或调用 API 后会出现在这里。');
  }
  function renderKeys(data) {
    if(!Array.isArray(data.keys))throw new Error('Key 列表响应格式不正确。');
    state.keys=data.keys;const list=data.keys.slice().sort((a,b)=>Number(Boolean(a.revoked))-Number(Boolean(b.revoked))||epoch(b.created)-epoch(a.created));
    text('keyCount',fmt(list.filter(k=>!k.revoked).length)+' 有效');
    text('navKeys',fmt(list.filter(k=>!k.revoked).length));
    const rows=list.map(k=>{const r=node('tr');cell(r,k.label||'未命名');cell(r,k.prefix||'—','mono');cell(r,stamp(k.created),'mono');const status=cell(r,'');status.append(flag(k.revoked?'已撤销':'有效',k.revoked?'':'ok'));const action=cell(r,'');const btn=node('button','btn compact'+(k.revoked?'':' danger'),k.revoked?'已撤销':'撤销');btn.type='button';btn.disabled=Boolean(k.revoked)||state.mutation;btn.dataset.revoke='1';btn.dataset.focus=String(k.id);btn.setAttribute('aria-label',(k.revoked?'已撤销：':'撤销 Key：')+String(k.label||k.prefix||k.id));btn.addEventListener('click',()=>openRevoke(k));action.append(btn);return r;});
    fillRows('keyRows',JSON.stringify([list,state.mutation]),rows,5,'还没有接入 Key。填写设备名称，即可签发第一枚 Key。');renderGroups();renderDetails();
  }
  function renderDetails() {
    if(!state.stats)return;
    const details=(Array.isArray(state.stats.details)?state.stats.details:[]).slice().sort((a,b)=>epoch(b.ts)-epoch(a.ts));
    const pages=Math.max(1,Math.ceil(details.length/15));state.page=Math.min(state.page,pages-1);
    const rows=details.slice(state.page*15,(state.page+1)*15).map(d=>{const r=node('tr');cell(r,stamp(d.ts),'mono');cell(r,d.ip||'—','mono');cell(r,d.model||'未标识');cell(r,keyName(d.key_id));const path=cell(r,'');path.append(node('div','mono break',String(d.method||'')+' '+String(d.path||'/')));const result=cell(r,'');const failed=num(d.status)>=400||['failed','error','failure','timeout','aborted','interrupted'].includes(d.outcome);result.append(flag(d.status||d.outcome||'未知',failed?'bad':num(d.status)>=200&&num(d.status)<400?'ok':''));result.append(node('div','cell-sub break',d.outcome||''));cell(r,ms(d.duration_ms),'number');cell(r,bytes(d.in_bytes)+' / '+bytes(d.out_bytes),'number');const usage=cell(r,token(d.total_tokens),'number');if([d.total_tokens,d.input_tokens,d.output_tokens].some(v=>typeof v==='number'))usage.append(node('div','cell-sub','入 '+token(d.input_tokens)+' / 出 '+token(d.output_tokens)));return r;});
    fillRows('detailRows',JSON.stringify([state.page,details,state.keys]),rows,9,'当前范围没有保留的请求明细。累计汇总可能包含已超出保留期的调用。');
    text('pageInfo','共 '+fmt(details.length)+' 条 · 第 '+(state.page+1)+' / '+pages+' 页');$('prevPage').disabled=state.page===0;$('nextPage').disabled=state.page>=pages-1;
  }
  async function refresh(manual=false,force=false) {
    if(state.busy){if(manual||force)state.queued=true;return;}
    state.busy=true;$('refresh').disabled=true;text('refreshLabel','正在刷新…');
    const suffix=query(),filterVersion=state.filterVersion,keyVersion=state.keyVersion;let failures=0;
    const jobs=[['info','infoError',renderInfo],['stats'+suffix,'statsError',renderStats],['devices','devicesError',renderDevices],['keys','keysError',renderKeys]];
    const obsolete=id=>(id==='statsError'&&filterVersion!==state.filterVersion)||(id==='keysError'&&keyVersion!==state.keyVersion);
    const heartbeat=api('heartbeat',{}).then(()=>true,()=>false);
    await Promise.all(jobs.map(async([path,id,render])=>{
      try{const data=await api(path);if(obsolete(id))return;render(data);showError(id,'');}
      catch(error){
        if(obsolete(id))return;failures++;showError(id,errorText(error)+' 如有旧数据则保留；可手动刷新重试。');
        if(id==='infoError'&&!state.info){text('apiUrl','接入信息暂不可用');text('vpnStatus','VPN 状态未知');text('certFp','根指纹暂不可用，请刷新后重试。');}
        if(id==='statsError'){$('metrics').setAttribute('aria-busy','false');if(!state.stats){for(const [name,cols]of[['groupRows',7],['detailRows',9]])fillRows(name,'error',[],cols,'统计加载失败，请使用“刷新数据”重试。');text('requestsFoot','统计加载失败');}}
        if(id==='devicesError'&&!state.devices)fillRows('deviceRows','error',[],5,'设备加载失败，请刷新重试。');
        if(id==='keysError'&&!state.keys)fillRows('keyRows','error',[],5,'Key 列表加载失败，请刷新重试。');
      }
    }));
    const heartbeatOk=await heartbeat;if(!heartbeatOk)failures++;
    $('connection').dataset.state=failures?'error':'ok';text('connectionText',failures?(heartbeatOk?'部分数据未同步':'心跳未送达'):'门户已连接');
    text('lastRefresh',(failures?'尝试于 ':'更新于 ')+new Date().toLocaleTimeString('zh-CN',{hour12:false})+' · 5s');
    state.busy=false;$('refresh').disabled=false;text('refreshLabel','刷新数据');
    if(manual&&!state.queued)toast(failures?'部分数据未能刷新，请查看对应提示。':'数据已刷新');
    if(state.queued){state.queued=false;void refresh();}
  }
  function setMutation(busy) { state.mutation=busy;$('issueKey').disabled=busy||$('secretDialog').open;$('keyLabel').disabled=busy;$('confirmRevoke').disabled=busy;$('cancelRevoke').disabled=busy;document.querySelectorAll('[data-revoke]').forEach(btn=>{btn.disabled=busy||Boolean((state.keys||[]).find(k=>String(k.id)===btn.dataset.focus)?.revoked);}); }
  function clearSecret() { const wasOpen=$('secretDialog').open;$('secretValue').value='';text('secretDevice','');text('secretMessage','此 Key 不会存入浏览器持久存储。');$('copySecret').disabled=false;if(wasOpen)$('secretDialog').close();$('issueKey').disabled=state.mutation;if(wasOpen)(state.route==='keys'?$('issueKey'):$('pageTitle')).focus(); }
  function openRevoke(key) { if(state.mutation)return;state.revoke={id:key.id,label:key.label,prefix:key.prefix};state.revokeFocus=String(key.id);text('revokeTarget',String(key.label||'未命名')+' · '+String(key.prefix||'—'));showError('revokeError','');$('revokeDialog').showModal(); }
  $('keyForm').addEventListener('submit',async event=>{
    event.preventDefault();if(state.mutation||$('secretDialog').open)return;
    const label=$('keyLabel').value.trim();if(!label){showError('keyError','请输入设备名称，不能只填写空格。');$('keyLabel').setAttribute('aria-invalid','true');$('keyLabel').focus();return;}
    showError('keyError','');$('keyLabel').removeAttribute('aria-invalid');setMutation(true);text('issueKey','正在签发…');
    try { const data=await api('keys',{label});if(typeof data.key!=='string'||!data.key)throw new Error('服务未返回完整 Key，请先刷新列表确认签发结果。');
      state.keyVersion++;$('secretValue').value=data.key;data.key='';text('secretDevice',data.label||label);text('secretMessage','此 Key 不会存入浏览器持久存储。');$('secretDialog').showModal();$('keyLabel').value='';void refresh(false,true);
    } catch(error) {showError('keyError',errorText(error)+' 请先刷新 Key 列表确认结果，避免重复签发。');}
    finally {setMutation(false);text('issueKey','＋ 签发 Key');}
  });
  $('keyLabel').addEventListener('input',()=>{$('keyLabel').removeAttribute('aria-invalid');showError('keyError','');});
  $('copySecret').addEventListener('click',async()=>{const btn=$('copySecret');btn.disabled=true;const done=await copy($('secretValue').value);text('secretMessage',done?'已复制。请保存到客户端，随后清除并关闭。':'无法访问剪贴板。请选中上方 Key，使用 Ctrl+C 手动复制。');btn.disabled=false;if(!done){$('secretValue').focus();$('secretValue').select();}});
  $('dismissSecret').addEventListener('click',clearSecret);$('secretDialog').addEventListener('cancel',event=>{event.preventDefault();clearSecret();});$('secretDialog').addEventListener('close',clearSecret);
  $('cancelRevoke').addEventListener('click',()=>{$('revokeDialog').close();state.revoke=null;});
  $('revokeDialog').addEventListener('cancel',event=>{if(state.mutation)event.preventDefault();else state.revoke=null;});
  $('revokeDialog').addEventListener('close',()=>{const target=Array.from($('keyRows').querySelectorAll('[data-focus]')).find(e=>e.dataset.focus===state.revokeFocus);if(target&&!target.disabled)target.focus();else{$('keysTitle').setAttribute('tabindex','-1');$('keysTitle').focus();}state.revokeFocus=null;});
  $('confirmRevoke').addEventListener('click',async()=>{
    if(state.mutation||!state.revoke)return;setMutation(true);text('confirmRevoke','正在撤销…');showError('revokeError','');
    try { const target=state.revoke.id;await api('revoke',{id:target});state.keyVersion++;if(state.keys){const k=state.keys.find(k=>k.id===target);if(k)k.revoked=true;renderKeys({keys:state.keys});}$('revokeDialog').close();state.revoke=null;toast('Key 已撤销，原 Key 无法继续接入。');void refresh(false,true); }
    catch(error){showError('revokeError',errorText(error)+' 请刷新列表确认当前状态。');}
    finally{setMutation(false);text('confirmRevoke','确认撤销');}
  });
  $('copyApi').addEventListener('click',()=>void copy(state.info?.api_url,'接入地址已复制'));
  $('copyFp').addEventListener('click',()=>void copy(state.info?.cert_fp,'根证书指纹已复制'));
  $('refresh').addEventListener('click',()=>void refresh(true));
  function localInput(date){const pad=n=>String(n).padStart(2,'0');return date.getFullYear()+'-'+pad(date.getMonth()+1)+'-'+pad(date.getDate())+'T'+pad(date.getHours())+':'+pad(date.getMinutes());}
  $('since').value=localInput(new Date(Date.now()-86400000));$('until').value=localInput(new Date());
  function commitCustom() {const since=new Date($('since').value).getTime()/1000,until=new Date($('until').value).getTime()/1000;const valid=Number.isFinite(since)&&Number.isFinite(until)&&since<until;
    text('rangeMessage',valid?'已应用 · 按当前设备时区筛选。':'请选择有效时间，结束时间必须晚于开始时间。');$('rangeMessage').dataset.error=String(!valid);$('since').setAttribute('aria-invalid',String(!valid));$('until').setAttribute('aria-invalid',String(!valid));if(valid)state.custom={since:Math.floor(since),until:Math.floor(until)};return valid;}
  function applyRange(range) {
    state.range=range;state.page=0;state.filterVersion++;state.stats=null;$('metrics').setAttribute('aria-busy','true');
    for(const id of ['requests','success','failed','latency','upload','download','tokens','unknown'])text(id,'—');
    text('requestsFoot','正在加载所选时间范围');text('successFoot','成功率 —');text('tokensFoot','输入 — / 输出 —');text('unknownFoot','未返回 usage，不代表消耗为零');
    for(const group of ['models','ips','keys'])text('count-'+group,'—');
    fillRows('groupRows','loading-'+state.filterVersion,[],7,'正在加载所选范围的用量分组…');fillRows('detailRows','loading-'+state.filterVersion,[],9,'正在加载所选范围的请求明细…');
    text('pageInfo','正在加载…');$('prevPage').disabled=true;$('nextPage').disabled=true;showError('statsError','');
    $('rangeForm').hidden=range!=='custom';document.querySelectorAll('[data-range]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.range===range)));updateRangeCaption();void refresh(true);
  }
  document.querySelectorAll('[data-range]').forEach(btn=>btn.addEventListener('click',()=>{const range=btn.dataset.range;if(range==='custom'&&!commitCustom()){$('rangeForm').hidden=false;return;}applyRange(range);}));
  $('rangeForm').addEventListener('submit',event=>{event.preventDefault();if(commitCustom())applyRange('custom');});
  for(const id of ['since','until'])$(id).addEventListener('input',()=>{text('rangeMessage','时间已修改，点击“应用时间”后生效。');$('rangeMessage').dataset.error='false';$(id).removeAttribute('aria-invalid');});
  const tabs=Array.from(document.querySelectorAll('[data-group]'));
  function chooseGroup(btn){state.group=btn.dataset.group;tabs.forEach(b=>{b.setAttribute('aria-selected',String(b===btn));b.tabIndex=b===btn?0:-1;});$('groupPanel').setAttribute('aria-labelledby',btn.id);renderGroups();}
  tabs.forEach((btn,i)=>{btn.addEventListener('click',()=>chooseGroup(btn));btn.addEventListener('keydown',event=>{let next;if(event.key==='ArrowRight')next=(i+1)%tabs.length;if(event.key==='ArrowLeft')next=(i+tabs.length-1)%tabs.length;if(event.key==='Home')next=0;if(event.key==='End')next=tabs.length-1;if(next!==undefined){event.preventDefault();chooseGroup(tabs[next]);tabs[next].focus();}});});
  $('prevPage').addEventListener('click',()=>{state.page--;renderDetails();});$('nextPage').addEventListener('click',()=>{state.page++;renderDetails();});
  window.addEventListener('pagehide',clearSecret);window.addEventListener('beforeunload',clearSecret);
  document.querySelectorAll('[data-route]').forEach(link=>link.addEventListener('click',event=>{
    if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    event.preventDefault();const key=link.dataset.route;if(location.protocol!=='file:'&&location.pathname!==routes[key].path)history.pushState(null,'',routes[key].path);renderRoute(key,true);
  }));
  window.addEventListener('popstate',()=>renderRoute(currentRoute(),true));
  renderRoute(currentRoute());
  void refresh();setInterval(()=>void refresh(),5000);
})();
</script>
</body>
</html>'''


_CONSOLE_NAV_STYLE = r'''<style id="bridge-nav-style">
body.bridge-nav-shell{margin:0;background:#f4f7fb;color:#1b2537;font-family:"Segoe UI",system-ui,-apple-system,"Microsoft YaHei",sans-serif;--ac:#087e9c;--ac2:#087e9c;--dim:#596b80;--ok:#08785e;--bad:#b42336}
.bridge-nav-shell .bridge-nav-bar{display:block;margin:0;background:#fff;border-bottom:1px solid #e2e8f2}
.bridge-nav-shell .bridge-nav-inner{box-sizing:border-box;max-width:1440px;margin:auto;padding:16px 32px;display:flex;align-items:center;gap:32px;flex-wrap:wrap}
.bridge-nav-shell .bridge-nav-brand{display:flex;align-items:center;gap:12px;color:#1b2537;min-width:0}
.bridge-nav-shell .bridge-nav-mark{width:40px;height:40px;display:grid;place-items:center;background:#087e9c;border-radius:12px;color:#fff;flex:none}
.bridge-nav-shell .bridge-nav-name{font-size:16px;font-weight:750;line-height:1.3}.bridge-nav-shell .bridge-nav-sub{font-size:11px;letter-spacing:1px;color:#596b80;line-height:1.6}
.bridge-nav-shell .bridge-nav-links{display:flex;gap:4px;flex-wrap:wrap;align-items:center}
.bridge-nav-shell .bridge-nav-link{box-sizing:border-box;display:inline-flex;align-items:center;min-height:40px;padding:8px 12px;border-radius:8px;color:#596b80;text-decoration:none;font-size:13px;font-weight:600;line-height:1.6}
.bridge-nav-shell a.bridge-nav-link:hover{background:#edf9fc;color:#087e9c}.bridge-nav-shell .bridge-nav-link[aria-current=page]{background:#edf9fc;color:#087e9c}.bridge-nav-shell .bridge-nav-link[aria-disabled=true]{color:#687789}
.bridge-nav-shell .bridge-nav-permission{margin-left:auto;color:#596b80;font-size:12px;line-height:1.6}.bridge-nav-shell .bridge-nav-unavailable{box-sizing:border-box;max-width:1376px;margin:16px auto 0;padding:12px 16px;border:1px solid #e6d29c;background:#fff8e8;color:#865714;border-radius:8px;font-size:12px;line-height:1.6}
.bridge-nav-shell>.wrap{max-width:1100px;padding:32px 32px 48px}.bridge-nav-shell .bridge-nav-console-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:24px}.bridge-nav-shell .bridge-nav-console-head>.logo{display:none}.bridge-nav-shell .bridge-nav-console-head>div:not(.pill){flex:1;min-width:200px}.bridge-nav-shell .bridge-nav-console-head h1{font-size:28px;line-height:1.3;letter-spacing:-.8px}.bridge-nav-shell .bridge-nav-console-head .sub{font-size:12px;line-height:1.6;color:#596b80;margin-top:8px}.bridge-nav-shell .bridge-nav-console-head .pill{margin-left:auto}.bridge-nav-shell .bridge-nav-console-head .pill.on{animation:none;background:#eaf8f1;color:#08785e;border-color:#d0ebdf}
.bridge-nav-shell .card{min-width:0;border-color:#e2e8f2;box-shadow:0 2px 4px #1b253703;margin-bottom:24px}.bridge-nav-shell .card h2{color:#596b80;font-size:13px}.bridge-nav-shell .grid{grid-template-columns:repeat(2,minmax(0,1fr))}.bridge-nav-shell .f,.bridge-nav-shell .row{min-width:0}.bridge-nav-shell .f label{overflow-wrap:anywhere}.bridge-nav-shell .row{flex-wrap:wrap}.bridge-nav-shell .row>input{flex:1;min-width:120px}.bridge-nav-shell .btn{border-radius:8px;background:#087e9c;box-shadow:none;min-height:40px;transition:background-color 120ms,transform 120ms,opacity 120ms}.bridge-nav-shell .btn:hover:not(:disabled){transform:none;background:#06677e}.bridge-nav-shell .btn:active:not(:disabled){transform:translateY(1px)}.bridge-nav-shell .btn.ghost,.bridge-nav-shell .btn.quit{background:#fff}.bridge-nav-shell .btn.ghost:hover:not(:disabled){background:#edf9fc}.bridge-nav-shell .btn.quit:hover:not(:disabled){background:#fff1f2}.bridge-nav-shell .big{min-width:0;flex-wrap:wrap;overflow-wrap:anywhere}.bridge-nav-shell .big>span{min-width:0;flex:1;overflow-wrap:anywhere}.bridge-nav-shell #log{max-width:100%;overflow-wrap:anywhere}.bridge-nav-shell .tip{overflow-wrap:anywhere}.bridge-nav-shell .sw,.bridge-nav-shell .chip,.bridge-nav-shell .toast{transition:background-color 120ms,border-color 120ms,opacity 160ms,transform 200ms cubic-bezier(.2,.8,.2,1)}.bridge-nav-shell .card{transition:border-color 160ms,box-shadow 160ms}
.bridge-nav-shell a:focus-visible,.bridge-nav-shell button:focus-visible,.bridge-nav-shell input:focus-visible,.bridge-nav-shell [tabindex]:focus-visible{outline:3px solid #087e9c;outline-offset:3px}.bridge-nav-shell .bridge-nav-skip{position:fixed;top:8px;left:8px;z-index:20;transform:translateY(-160%);padding:8px 16px;background:white;color:#087e9c;border-radius:8px}.bridge-nav-shell .bridge-nav-skip:focus{transform:translateY(0)}
@media(max-width:1000px){.bridge-nav-shell .bridge-nav-inner{padding:16px 24px;gap:16px}.bridge-nav-shell .bridge-nav-links{order:3;width:100%;border-top:1px solid #e2e8f2;padding-top:12px}.bridge-nav-shell .bridge-nav-unavailable{margin:16px 24px 0}.bridge-nav-shell>.wrap{padding:24px}}
@media(max-width:680px){.bridge-nav-shell .grid{grid-template-columns:minmax(0,1fr)}}
@media(max-width:640px){.bridge-nav-shell .bridge-nav-inner{padding:16px;gap:12px}.bridge-nav-shell .bridge-nav-mark{width:36px;height:36px}.bridge-nav-shell .bridge-nav-name{font-size:14px}.bridge-nav-shell .bridge-nav-permission{font-size:11px}.bridge-nav-shell .bridge-nav-link{font-size:12px;padding:6px 8px}.bridge-nav-shell .bridge-nav-unavailable{margin:16px 16px 0}.bridge-nav-shell>.wrap{padding:24px 16px 40px}.bridge-nav-shell .bridge-nav-console-head h1{font-size:24px}.bridge-nav-shell .bridge-nav-console-head>div:not(.pill){flex-basis:100%;min-width:0}.bridge-nav-shell .bridge-nav-console-head .pill{margin-left:0}.bridge-nav-shell .bridge-nav-console-head #btnQuit{margin-left:auto}.bridge-nav-shell .card{padding:16px}.bridge-nav-shell .actions{gap:8px}.bridge-nav-shell .actions>.btn{flex:1 1 140px;padding:10px 12px}.bridge-nav-shell .kv .lab{flex-wrap:wrap;gap:8px}.bridge-nav-shell .big .btn{margin-left:auto}}
@media(prefers-reduced-motion:reduce){.bridge-nav-shell *,.bridge-nav-shell *::before,.bridge-nav-shell *::after{animation:none!important;transition:none!important}}
</style>'''


def console_shell(html, portal_url='', remote=False):
    """Wrap trusted WEB_INDEX_HTML without replacing its IDs or script bodies.

    remote=True: same-origin links and BRIDGE_REMOTE_ADMIN=true before old JS.
    remote=False: portal_url is a server-provided HTTP(S) base, never a control
    token. Query/fragment/userinfo are not forwarded. Missing/invalid URLs leave
    the console functional with disabled portal links and an explicit hint.
    This is presentation only; the host owns authorization and management APIs.
    Call once on the original document, before returning it to the browser.
    """
    if not isinstance(html, str):
        raise TypeError('html must be a string')
    prefix = ''
    available = bool(remote)
    if not remote and portal_url:
        try:
            parsed = _urlsplit(str(portal_url).strip())
            if (parsed.scheme in ('http', 'https') and parsed.netloc
                    and parsed.hostname and not parsed.username and not parsed.password
                    and not any(ord(c) < 32 for c in str(portal_url))):
                prefix = _urlunsplit((parsed.scheme, parsed.netloc,
                                     parsed.path.rstrip('/'), '', ''))
                available = True
        except ValueError:
            pass
    destinations = (('/', '概览'), ('/portal/devices', '在线设备'),
                    ('/portal/keys', 'Key 自助'), ('/portal/requests', '请求明细'))
    links = []
    for route, label in destinations:
        if available:
            links.append('<a class="bridge-nav-link" href="' +
                         _escape(prefix + route, quote=True) + '">' + label + '</a>')
        else:
            links.append('<span class="bridge-nav-link" aria-disabled="true" '
                         'title="门户地址暂不可用">' + label + '</span>')
    links.append('<span class="bridge-nav-link" aria-current="page">桥接配置</span>')
    nav = ('''<a class="bridge-nav-skip" href="#bridge-nav-console-title">跳至桥接配置</a>
<header class="bridge-nav-bar" id="bridge-nav"><div class="bridge-nav-inner">
<div class="bridge-nav-brand"><span class="bridge-nav-mark" aria-hidden="true"><svg width="25" height="25" viewBox="0 0 28 28" fill="none"><path d="M4 19h20M7 19V8m14 11V8M7 11c4 6 10 6 14 0M4 23v-4m20 4v-4M10 14v5m4-3v3m4-5v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></span><div><div class="bridge-nav-name">LocalHttpsBridge</div><div class="bridge-nav-sub">共享接入门户</div></div></div>
<nav class="bridge-nav-links" aria-label="页面导航">''' + ''.join(links) +
           '''</nav><span class="bridge-nav-permission">VPN 成员均可管理</span></div></header>''')
    if not available:
        nav += ('<p class="bridge-nav-unavailable" role="status">概览暂不可用：'
                '尚无可访问的门户地址。桥接配置仍可使用；启动桥接器后重新打开此页。</p>')

    # Only adapt the known legacy title strip, preserving pill/quit and all IDs.
    def adapt_header(match):
        old = match.group(0)
        if not (_re.search(r'id=[\"\x27]pill[\"\x27]', old) and
                _re.search(r'id=[\"\x27]btnQuit[\"\x27]', old)):
            return old
        old = _re.sub(r'<header\b', '<header class="bridge-nav-console-head"', old, count=1)
        old = _re.sub(r'<h1>([^<]*)</h1>',
                      '<h1 id="bridge-nav-console-title" tabindex="-1">桥接配置</h1>',
                      old, count=1)
        old = _re.sub(r'(<div class="sub">)[^<]*(</div>)',
                      r'\1VPN 成员均可管理后端配置、启停与运行日志。\2', old, count=1)
        return old

    result = _re.sub(r'<header\b[^>]*>[\s\S]*?</header\s*>', adapt_header,
                     html, flags=_re.IGNORECASE)
    flag = '<script>window.BRIDGE_REMOTE_ADMIN=' + ('true' if remote else 'false') + ';</script>'
    result, found_head = _re.subn(r'(<head\b[^>]*>)', lambda m: m.group(0) + flag,
                                  result, count=1, flags=_re.IGNORECASE)
    if not found_head:
        result = flag + result
    result, found_style = _re.subn(r'</head\s*>', lambda m: _CONSOLE_NAV_STYLE + m.group(0),
                                  result, count=1, flags=_re.IGNORECASE)
    if not found_style:
        result = _CONSOLE_NAV_STYLE + result

    def add_body(match):
        tag = match.group(0)
        if _re.search(r'\bclass\s*=', tag, flags=_re.IGNORECASE):
            tag = _re.sub(r'(\bclass\s*=\s*)([\"\x27])(.*?)\2',
                          lambda m: m.group(1) + m.group(2) + m.group(3) +
                          ' bridge-nav-shell' + m.group(2), tag, count=1,
                          flags=_re.IGNORECASE)
        else:
            tag = tag[:-1] + ' class="bridge-nav-shell">'
        return tag + nav

    result, found_body = _re.subn(r'<body\b[^>]*>', add_body, result, count=1,
                                 flags=_re.IGNORECASE)
    if not found_body:
        result = '<div class="bridge-nav-shell">' + nav + result + '</div>'
    return result
