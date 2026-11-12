/* Dependency-free executable Chromium DOM tests. Node 22+, Chrome/Edge required.
 * Run: node LocalHttpsBridge/tests/portal_frontend_test.js (Node 22+, Python 3.8+).
 * Optional: PORTAL_BROWSER=<browser.exe>, PORTAL_PYTHON=<python.exe>;
 * --preview writes scratch-only demo pages. All console APIs are stubbed.
 * No production server, configuration, certificate, or real credentials are read.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const http = require('node:http');
const {spawn, spawnSync} = require('node:child_process');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '..', 'portal_ui.py'), 'utf8');
const match = source.match(/PORTAL_HTML = r'''([\s\S]*?)'''/);
assert(match, 'PORTAL_HTML raw export exists');
const html = match[1];
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length, 1);
new vm.Script(scripts[0][1], {filename:'portal-inline.js'});
assert(!/innerHTML|localStorage|sessionStorage|https?:\/\/[^'"\s]*\.(?:js|css)/.test(html), 'No HTML sinks, persistent secrets, or remote dependencies');
console.log('PASS JavaScript syntax and static security contract');

// Explicit demo fixture: this function is serialized into a scratch HTML only.
function fixture() {
  const now = Math.floor(Date.now()/1000);
  const base = {requests:128,success:124,failed:4,in_bytes:981024,out_bytes:2458128,duration_ms:192000,avg_ms:1500,input_tokens:15800,output_tokens:4200,total_tokens:20000,usage_known:100,usage_unknown:28};
  const first={...base,requests:96,success:92,in_bytes:720000,out_bytes:1900000,duration_ms:144000,input_tokens:11850,output_tokens:3150,total_tokens:15000,usage_known:75,usage_unknown:21};
  const second={...base,requests:32,success:32,failed:0,in_bytes:261024,out_bytes:558128,duration_ms:48000,input_tokens:3950,output_tokens:1050,total_tokens:5000,usage_known:25,usage_unknown:7};
  const keys = [{id:1,label:'书房电脑',prefix:'lb_demo…a12f',created:now-86400,revoked:false},{id:2,label:'随身笔记本',prefix:'lb_demo…b34e',created:now-172800,revoked:false}];
  const stats = {summary:{...base},retention_days:30,models:[{name:'gpt-4.1-mini',...first},{name:'qwen3.8-flash',...second}],ips:[{name:'26.18.6.12',...first},{name:'26.18.6.21',...second}],keys:[{name:'1',...first},{name:'2',...second}],details:Array.from({length:32},(_,i)=>({ts:now-i*61,ip:i%2?'26.18.6.21':'26.18.6.12',model:i%2?'qwen3.8-flash':'gpt-4.1-mini',key_id:i%2?2:1,path:'/v1/chat/completions',method:'POST',status:i%9?200:502,outcome:i%9?'ok':'error',duration_ms:1200+i*21,in_bytes:3200+i,out_bytes:8900+i,input_tokens:i%3?120:null,output_tokens:i%3?48:null,total_tokens:i%3?168:null}))};
  const devices=[{ip:'26.18.6.12',last_seen:now-12,active:2,online:true,requests:96,in_bytes:720000,out_bytes:1900000},{ip:'26.18.6.21',last_seen:now-80,active:0,online:true,requests:32,in_bytes:261024,out_bytes:558128}];
  window.__fixture={requests:[],delay:60,errors:{},empty:false,unknown:false,long:false,revokeFail:false,issueFail:false,clipboardFail:false,clipboard:[],keys,stats,devices};
  const f=window.__fixture;
  if(new URLSearchParams(location.search).get('initial')==='error')f.errors={info:'演示首次加载失败',stats:'演示首次加载失败',devices:'演示首次加载失败',keys:'演示首次加载失败',heartbeat:'演示首次加载失败'};
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{if(f.clipboardFail)throw Error('demo denied');f.clipboard.push(text);}}});
  window.fetch=async(url,options={})=>{
    f.requests.push({url,method:options.method,credentials:options.credentials,mode:options.mode,headers:options.headers,body:options.body});
    await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,f.delay);options.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));},{once:true});});
    const route=String(url).replace('/portal/api/','').split('?')[0];
    let status=200,data;
    if(f.errors[route]){status=503;data={ok:false,error:f.errors[route]};}
    else if(route==='heartbeat')data={ok:true};
    else if(route==='info')data={ok:true,api_url:'https://26.18.6.1:8443/v1',vpn_ip:'26.18.6.1',vpn_available:true,cert_fp:'a1b2c3d4'.repeat(8),retention_days:30,capacity:8,notice:'演示数据 · 仅用于界面预览与自动化测试，未连接真实桥接器。'};
    else if(route==='stats'){
      data=JSON.parse(JSON.stringify(stats));
      if(f.rangeTagged){const q=new URL(String(url),'http://fixture').searchParams;data.summary.requests=Math.round((Number(q.get('until'))-Number(q.get('since')))/86400);}
      if(f.empty){data.summary=Object.fromEntries(Object.keys(base).map(k=>[k,0]));data.models=[];data.ips=[];data.keys=[];data.details=[];}
      if(f.unknown){data.summary.usage_known=0;data.summary.usage_unknown=data.summary.requests;data.summary.total_tokens=null;data.models.forEach(g=>{g.usage_known=0;g.usage_unknown=g.requests;g.total_tokens=null;});}
      if(f.long){data.models[0].name='<img src=x onerror="window.PWNED=1">'+('very-long-model-name-'.repeat(30));data.details[0].path='/'+('long-path/'.repeat(60));}
    }
    else if(route==='devices')data={devices:f.empty?[]:devices};
    else if(route==='keys'&&options.method==='POST'){
      if(f.issueFail){status=409;data={ok:false,error:'演示：签发失败'};}
      else{status=201;const label=JSON.parse(options.body).label;const k={id:keys.length+1,label,prefix:'lb_demo…new0',created:Math.floor(Date.now()/1000),revoked:false};keys.push(k);data={...k,key:'lb_DEMO_ONLY_NOT_A_REAL_SECRET_123456789'};}
    }
    else if(route==='keys')data={keys:f.empty?[]:keys};
    else if(route==='revoke'){
      if(f.revokeFail){status=409;data={ok:false,error:'演示：暂时不能撤销'};}
      else{const k=keys.find(k=>k.id===JSON.parse(options.body).id);if(k)k.revoked=true;data={ok:true};}
    }
    else{status=404;data={ok:false,error:'fixture route missing'};}
    return {ok:status>=200&&status<300,status,json:async()=>JSON.parse(JSON.stringify(data))};
  };
}
const demo = html.replace('<script>', '<script>('+fixture.toString()+')();</script>\n<script>');

// Extract only a static source constant; never import/execute the bridge host.
function consoleDocuments(){
  const python=process.env.PORTAL_PYTHON || (process.platform==='win32'?'py':'python3');
  const code=`import ast,json,pathlib,sys\np=pathlib.Path(sys.argv[1]); n={}; exec(compile(p.read_text(encoding='utf-8'),str(p),'exec'),n)\na=ast.parse(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8'))\nlegacy=next(ast.literal_eval(x.value) for x in a.body if isinstance(x,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='WEB_INDEX_HTML' for t in x.targets))\nshell=n['console_shell']\nprint(json.dumps(dict(legacy=legacy,remote=shell(legacy,remote=True),local=shell(legacy,'https://26.18.6.1:8443/?fixture=discard#discard'),missing=shell(legacy),escaped=shell(legacy,'https://example.test/base\\\"x'),invalid=shell(legacy,'javascript:alert(1)')),ensure_ascii=True))`;
  const r=spawnSync(python,['-B','-c',code,path.join(__dirname,'..','portal_ui.py'),path.join(__dirname,'..','LocalHttpsBridge.py')],{encoding:'utf8',maxBuffer:4*1024*1024});
  assert.equal(r.status,0,'Python shell fixture failed: '+r.stderr);return JSON.parse(r.stdout);
}
const shells=consoleDocuments();
const legacyScripts=[...shells.legacy.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]);
for(const name of ['remote','local','missing']){
  for(const original of legacyScripts)assert(shells[name].includes(original),'old script bodies preserved: '+name);
  for(const id of [...shells.legacy.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]))assert(shells[name].includes('id="'+id+'"'),'legacy ID preserved: '+id);
  assert(shells[name].indexOf('window.BRIDGE_REMOTE_ADMIN=')<shells[name].indexOf(legacyScripts[0]),'remote flag precedes legacy code');
}
assert(!shells.local.includes('?fixture=discard'),'query/fragment not forwarded to portal');
assert(shells.remote.includes('href="/portal/keys"') && shells.local.includes('href="https://26.18.6.1:8443/portal/keys"'),'remote/local link bases');
assert(shells.escaped.includes('base&amp;') || shells.escaped.includes('base&quot;x/portal/keys'),'trusted URL attributes escaped');
assert(shells.missing.includes('概览暂不可用') && shells.invalid.includes('aria-disabled="true"'),'missing/invalid URL does not break console');
console.log('PASS console_shell exports, flag ordering, preserved IDs/scripts, relative/absolute links and unavailable state');

function consoleFixture(){
  const f=window.__consoleFixture={requests:[],running:true};
  window.fetch=async(url,options={})=>{f.requests.push({url,method:options.method||'GET',headers:options.headers||{},body:options.body});let data={ok:true};const pathname=String(url).split('?')[0];
    if(pathname.endsWith('/start'))f.running=true;if(pathname.endsWith('/stop')||pathname.endsWith('/quit'))f.running=false;
    if(pathname.endsWith('/state'))data={ok:true,running:f.running,urls:['https://26.18.6.1:8443'],preferred_url:'https://26.18.6.1:8443',replace:true,external_key:'lb_DEMO_ONLY_NOT_REAL',cert_fp:'A1B2C3D4'.repeat(8),vpn_notice:'演示数据 · VPN 成员均可管理'};
    if(pathname.endsWith('/form'))data={ok:true,form:{backend:'http://demo.invalid:8080/v1',backend_key:'',backend_key_configured:true,port:8443,replace:true}};
    if(pathname.endsWith('/logs'))data={ok:true,lines:['演示数据 · 未连接真实后端；不会发起生产推理。','[DEMO] '+('long-log-line-'.repeat(60))]};
    return{ok:true,status:200,json:async()=>data};};
  window.confirm=()=>false;
}
function consoleDemo(name){return shells[name].replace(/<script\b/,'<script>('+consoleFixture.toString()+')();</script><script');}
const tempRoot=process.env.PI_SCRATCH_DIR || process.env.PORTAL_TEST_TMP || os.tmpdir();
if(process.argv.includes('--preview')) {
  const output=path.join(tempRoot,'portal-preview.html');
  fs.writeFileSync(output,demo,'utf8');
  fs.writeFileSync(path.join(tempRoot,'console-preview.html'),consoleDemo('remote'),'utf8');
  console.log(output);
  process.exit(0);
}

const wait = ms => new Promise(r=>setTimeout(r,ms));
class CDP {
  constructor(socket){this.socket=socket;this.id=0;this.pending=new Map();this.errors=[];socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){const p=this.pending.get(m.id);this.pending.delete(m.id);if(m.error)p.reject(Error(m.error.message));else p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')this.errors.push(m.params.exceptionDetails.text+': '+(m.params.exceptionDetails.exception?.description||''));});}
  send(method,params={}){return new Promise((resolve,reject)=>{const id=++this.id;this.pending.set(id,{resolve,reject});this.socket.send(JSON.stringify({id,method,params}));});}
  async eval(expression){const r=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
  async until(expression,message,timeout=5000){const start=Date.now();while(Date.now()-start<timeout){if(await this.eval(expression))return;await wait(40);}throw Error('Timed out: '+message);}
  async key(key,code=key,virtual=0,modifiers=0){await this.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:virtual,modifiers});await this.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:virtual,modifiers});}
}
async function run(){
  const browser=[process.env.PORTAL_BROWSER,'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','/usr/bin/chromium','/usr/bin/google-chrome'].filter(Boolean).find(p=>fs.existsSync(p));
  assert(browser,'Chrome/Edge not found; set PORTAL_BROWSER');
  const dir=fs.mkdtempSync(path.join(tempRoot,'portal-dom-'));
  const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});const url=new URL(req.url,'http://fixture');const name=url.searchParams.get('mode')||'remote';res.end(url.pathname==='/console'?consoleDemo(name):demo);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  const child=spawn(browser,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+dir,'about:blank'],{stdio:['ignore','ignore','pipe']});
  let cdp;
  try{
    const endpoint=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Chromium startup timeout')),20000);child.stderr.on('data',b=>{output+=b;const m=output.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1]);}});child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);reject(Error('Chromium exited '+code));});});
    const debugOrigin='http://'+new URL(endpoint).host;
    const targets=await fetch(debugOrigin+'/json/list').then(r=>r.json());
    const target=targets.find(t=>t.type==='page');
    const socket=new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
    cdp=new CDP(socket);await cdp.send('Runtime.enable');await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await cdp.send('Page.navigate',{url:'http://127.0.0.1:'+port+'/'});
    await cdp.until(`!!window.__fixture && !!document.getElementById('refresh')`,'page boot');
    const $=id=>'document.getElementById('+JSON.stringify(id)+')';
    const click=id=>cdp.eval(`(()=>{const e=${$(id)};if(!e.checkVisibility())throw Error('Cannot click hidden control: ${id}');e.click();})()`);
    const paths={overview:'/',devices:'/portal/devices',keys:'/portal/keys',requests:'/portal/requests'};
    async function navigate(key){await cdp.eval(`document.querySelector('[data-route="${key}"]').click()`);await cdp.until(`document.querySelector('[data-page="${key}"]').checkVisibility()`,'route '+key);}
    const idle=()=>cdp.until(`!${$('refresh')}.disabled`,'refresh complete');
    async function refresh(){await idle();await click('refresh');await idle();}
    async function check(expression,message){assert(await cdp.eval(expression),message);console.log('PASS '+message);}
    const cellOverflowExpression=`(()=>{const bad=[];for(const cell of document.querySelectorAll('th,td')){if(!cell.checkVisibility())continue;const box=cell.getBoundingClientRect();const walker=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT);while(walker.nextNode()){if(!walker.currentNode.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(walker.currentNode);if([...range.getClientRects()].some(r=>r.right>box.right+1||r.left<box.left-1))bad.push(cell.textContent.slice(0,48));}}return bad;})()`;
    await check(`${$('refresh')}.disabled && ${$('metrics')}.getAttribute('aria-busy')==='true'`,'initial loading state');
    await idle();
    await check(`location.pathname==='/' && document.querySelectorAll('[data-page]:not([hidden])').length===1 && document.querySelector('.nav [aria-current="page"]').dataset.route==='overview'`,'root route displays only overview with active navigation');
    await check(`document.querySelector('.nav a[href="/console"]').textContent==='桥接配置' && ${$('pageDescription')}.textContent.includes('VPN 成员均可')`,'configuration entry and equal VPN management permissions');
    await check(`${$('navOnline')}.textContent==='2' && ${$('navKeys')}.textContent==='2'`,'navigation shows online and valid-key counts');
    await check(`${$('requests')}.textContent==='128' && ${$('onlineCount')}.textContent==='2 在线'`,'summary and online activity count');
    await check(`${$('keyCount')}.textContent==='2 有效' && document.querySelectorAll('#detailRows tr').length===15`,'masked keys and detail pagination');
    await check(`${$('deviceRows')}.textContent.includes('2 个活动请求')`,'active request counts are visible');
    await navigate('requests');
    await click('nextPage');await check(`${$('pageInfo')}.textContent.includes('2 / 3')`,'next page action');await click('prevPage');
    await navigate('overview');
    await check(`__fixture.requests.filter(r=>r.method==='POST').every(r=>r.headers['X-Bridge-Portal']==='1' && r.body==='{}') && __fixture.requests.every(r=>r.credentials==='omit' && r.mode==='same-origin')`,'same-origin, no credentials, mutation headers');
    await click('copyApi');await check(`__fixture.clipboard.at(-1)==='https://26.18.6.1:8443/v1'`,'copy API base');
    await cdp.eval(`document.querySelector('.certificate').open=true`);await click('copyFp');await check(`__fixture.clipboard.at(-1)==='a1b2c3d4'.repeat(8)`,'copy unformatted root fingerprint');
    await navigate('requests');await check(`${$('statsFilters')}.checkVisibility() && ${$('requestFilterSlot')}.contains(${$('statsFilters')}) && !${$('access')}.checkVisibility()`,'requests page shares filters without connection cards');

    for(const [range,seconds]of[['today',null],['7d',7*86400],['30d',30*86400],['all',null]]){
      await cdp.eval(`document.querySelector('[data-range="${range}"]').click()`);await idle();
      const url=await cdp.eval(`__fixture.requests.filter(r=>r.url.startsWith('/portal/api/stats')).at(-1).url`);
      const u=new URL(url,'http://fixture');
      if(range==='all')assert.equal(u.search,'');else{assert(Number.isInteger(Number(u.searchParams.get('since'))));assert(Number(u.searchParams.get('until'))>Number(u.searchParams.get('since')));if(seconds)assert.equal(Number(u.searchParams.get('until'))-Number(u.searchParams.get('since')),seconds);}
    }
    console.log('PASS all / today / 7d / 30d epoch queries');
    await cdp.eval(`document.querySelector('[data-range="custom"]').click()`);await idle();
    await cdp.eval(`${$('since')}.value='2026-06-02T10:00';${$('until')}.value='2026-06-01T10:00';${$('rangeForm')}.requestSubmit()`);
    await check(`${$('rangeMessage')}.dataset.error==='true'`,'invalid custom date feedback');
    await cdp.eval(`${$('since')}.value='2026-06-01T10:00';${$('until')}.value='2026-06-02T10:00';${$('rangeForm')}.requestSubmit()`);await idle();
    await check(`${$('rangeMessage')}.dataset.error==='false' && __fixture.requests.filter(r=>r.url.startsWith('/portal/api/stats')).at(-1).url.includes('?since=')`,'valid custom datetime application');
    await cdp.eval(`__fixture.rangeTagged=true;__fixture.delay=250;document.querySelector('[data-range="today"]').click();document.querySelector('[data-range="7d"]').click()`);
    await check(`${$('requests')}.textContent==='—' && ${$('metrics')}.getAttribute('aria-busy')==='true'`,'range changes clear mismatched old metrics');
    await cdp.until(`__fixture.requests.filter(r=>r.url.startsWith('/portal/api/stats')).at(-1).url.includes('since=') && __fixture.requests.filter(r=>r.url.startsWith('/portal/api/stats')).slice(-2).length===2 && Number(new URL(__fixture.requests.filter(r=>r.url.startsWith('/portal/api/stats')).at(-1).url,location.origin).searchParams.get('until'))-Number(new URL(__fixture.requests.filter(r=>r.url.startsWith('/portal/api/stats')).at(-1).url,location.origin).searchParams.get('since'))===604800`,'queued latest range request');
    await check(`${$('requests')}.textContent==='—'`,'obsolete in-flight range response ignored');await idle();
    await check(`${$('requests')}.textContent==='7'`,'latest queued range wins');
    await cdp.eval(`__fixture.rangeTagged=false;__fixture.delay=60`);await refresh();
    await navigate('overview');await check(`${$('overview')}.contains(${$('statsFilters')}) && document.querySelector('[data-range="7d"]').getAttribute('aria-pressed')==='true'`,'shared filter state survives page navigation');

    await cdp.eval(`${$('tab-models')}.focus()`);await cdp.key('ArrowRight','ArrowRight',39);
    await check(`document.activeElement.id==='tab-ips' && ${$('tab-ips')}.getAttribute('aria-selected')==='true'`,'keyboard arrow tab selection');
    await cdp.key('End','End',35);await check(`document.activeElement.id==='tab-keys' && ${$('groupRows')}.textContent.includes('lb_demo…')`,'keyboard End and masked key groups');
    await cdp.eval(`${$('refresh')}.focus()`);await cdp.key('Tab','Tab',9);
    await check(`document.activeElement.matches(':focus-visible') && getComputedStyle(document.activeElement).outlineStyle==='solid'`,'visible keyboard focus');
    await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await check(`getComputedStyle(document.querySelector('.metric')).animationName==='none' && getComputedStyle(document.documentElement).scrollBehavior==='auto'`,'reduced motion honored');
    await cdp.send('Emulation.setEmulatedMedia',{features:[]});

    await cdp.eval(`__fixture.long=true`);await refresh();await click('tab-models');
    await check(`!window.PWNED && !document.querySelector('#groupRows img') && ${$('groupRows')}.textContent.includes('<img')`,'untrusted model text is inert');
    for(const width of [320,390,768,1024,1440,1920]){
      await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await wait(100);
      const result=await cdp.eval(`({width:innerWidth,scroll:document.documentElement.scrollWidth,grid:getComputedStyle(document.querySelector('.metrics')).gridTemplateColumns,overlaps:[...document.querySelectorAll('.metric')].some(e=>{const a=e.getBoundingClientRect();return [...document.querySelectorAll('.metric')].some(f=>{if(f===e)return false;const b=f.getBoundingClientRect();return a.left<b.right-1&&a.right>b.left+1&&a.top<b.bottom-1&&a.bottom>b.top+1;});})})`);
      assert(result.scroll<=width+1,`horizontal page overflow at ${width}: ${result.scroll}`);assert(!result.overlaps,'metric overlap at '+width);
      const overflows=await cdp.eval(cellOverflowExpression);
      assert.deepEqual(overflows,[],'table text stays in its own cell at '+width+': '+overflows.join(','));
      console.log('PASS responsive '+width+'px, grid '+result.grid);
      for(const key of ['devices','keys','requests']){
        await navigate(key);const layout=await cdp.eval(`({scroll:document.documentElement.scrollWidth,visible:[...document.querySelectorAll('[data-page]')].filter(e=>e.checkVisibility()).map(e=>e.dataset.page),hiddenFocus:[...document.querySelectorAll('[data-page][hidden] button,[data-page][hidden] input')].some(e=>e.checkVisibility())})`);
        assert(layout.scroll<=width+1,'page overflow '+key+' at '+width);assert.deepEqual(layout.visible,[key]);assert(!layout.hiddenFocus);assert.deepEqual(await cdp.eval(cellOverflowExpression),[],'table cell overflow '+key+' at '+width);
        if(width===390||width===1440){const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(tempRoot,'portal-'+key+'-'+width+'.png'),Buffer.from(shot.data,'base64'));}
      }
      await navigate('overview');
    }
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await cdp.eval(`__fixture.stats.summary.total_tokens=null;__fixture.stats.summary.input_tokens=null;__fixture.stats.details[0].total_tokens=7;__fixture.stats.details[0].input_tokens=null;__fixture.stats.details[0].output_tokens=4;__fixture.stats.details[0].outcome='interrupted';__fixture.stats.details[0].status=200`);await refresh();
    await check(`${$('tokens')}.textContent==='—' && ${$('tokensFoot')}.textContent.includes('输入 未知') && ${$('detailRows')}.textContent.includes('入 未知 / 出 4') && document.querySelector('#detailRows tr .badge').classList.contains('bad')`,'partial usage stays unknown and interrupted HTTP 200 is failed');
    await cdp.eval(`__fixture.stats.summary.total_tokens=20000;__fixture.stats.summary.input_tokens=15800`);
    await cdp.eval(`__fixture.long=false;__fixture.unknown=true`);await refresh();
    await check(`${$('tokens')}.textContent==='—' && ${$('unknown')}.textContent==='128'`,'unknown usage is not rendered as zero');
    await cdp.eval(`__fixture.unknown=false;__fixture.empty=true`);await refresh();
    await check(`${$('requests')}.textContent==='0' && ${$('keyRows')}.textContent.includes('还没有') && ${$('deviceRows')}.textContent.includes('尚未') && ${$('detailRows')}.textContent.includes('没有保留')`,'empty states in every table');
    await cdp.eval(`__fixture.empty=false`);await refresh();
    await cdp.eval(`__fixture.errors={stats:'<b>演示错误</b>',keys:'演示 Key 错误',devices:'演示设备错误',info:'演示信息错误',heartbeat:'演示心跳错误'}`);await refresh();
    await check(`!${$('statsError')}.hidden && ${$('statsError')}.textContent.includes('<b>') && !${$('statsError')}.querySelector('b') && ${$('requests')}.textContent==='128' && ${$('connection')}.dataset.state==='error'`,'isolated errors, literal error text and stale data retention');
    await cdp.eval(`__fixture.errors={}`);await refresh();await check(`${$('statsError')}.hidden && ${$('connection')}.dataset.state==='ok'`,'manual error recovery');

    await navigate('keys');
    await cdp.eval(`${$('keyLabel')}.value='   ';${$('keyForm')}.requestSubmit()`);await check(`!${$('keyError')}.hidden && ${$('keyLabel')}.getAttribute('aria-invalid')==='true'`,'blank key label validation');
    await cdp.eval(`__fixture.issueFail=true;${$('keyLabel')}.value='测试设备';${$('keyForm')}.requestSubmit()`);
    await cdp.until(`!${$('issueKey')}.disabled`,'issue failure settled');await check(`${$('keyError')}.textContent.includes('避免重复签发')`,'mutation failure and ambiguous-result guidance');
    await cdp.eval(`__fixture.issueFail=false;__fixture.delay=250;${$('keyLabel')}.value='<svg onload="window.PWNED=2">测试电脑';${$('keyForm')}.requestSubmit()`);
    await check(`${$('issueKey')}.disabled && ${$('keyLabel')}.disabled`,'signing disabled and loading states');
    await cdp.until(`${$('secretDialog')}.open`,'one-time key modal');
    await check(`${$('secretValue')}.value.startsWith('lb_DEMO_ONLY') && !window.PWNED && !${$('secretDevice')}.querySelector('svg')`,'one-time key and literal device label');
    await cdp.key('Tab','Tab',9);await cdp.key('Tab','Tab',9);await check(`${$('secretDialog')}.contains(document.activeElement)`,'native modal focus trap');
    await cdp.eval(`__fixture.clipboardFail=true`);await click('copySecret');await cdp.until(`${$('secretMessage')}.textContent.includes('Ctrl+C')`,'clipboard fallback');
    await check(`document.activeElement.id==='secretValue' && ${$('secretValue')}.selectionEnd>0`,'clipboard-denied manual selection fallback');
    await cdp.eval(`__fixture.clipboardFail=false`);await click('copySecret');await cdp.until(`${$('secretMessage')}.textContent.includes('已复制')`,'copy success');
    await cdp.key('Escape','Escape',27);await check(`!${$('secretDialog')}.open && ${$('secretValue')}.value===''`,'Escape clears one-time key');
    await check(`document.activeElement.id==='issueKey'`,'key dismissal restores useful focus');
    await idle();
    await cdp.eval(`__fixture.delay=60;document.querySelector('#keyRows button:not(:disabled)').click()`);await check(`${$('revokeDialog')}.open`,'revoke requires explicit confirmation');
    const before=await cdp.eval(`__fixture.requests.filter(r=>r.url==='/portal/api/revoke').length`);await click('cancelRevoke');assert.equal(await cdp.eval(`__fixture.requests.filter(r=>r.url==='/portal/api/revoke').length`),before);console.log('PASS cancel revoke sends no mutation');
    await cdp.eval(`document.querySelector('#keyRows button:not(:disabled)').click();__fixture.revokeFail=true`);await click('confirmRevoke');await cdp.until(`!${$('confirmRevoke')}.disabled`,'revoke failed');await check(`!${$('revokeError')}.hidden && ${$('revokeDialog')}.open`,'revoke error remains actionable');
    await cdp.eval(`__fixture.revokeFail=false`);await click('confirmRevoke');await cdp.until(`!${$('revokeDialog')}.open`,'revoke success');await idle();
    await check(`document.querySelector('#keyRows button:disabled')?.textContent==='已撤销'`,'revoke success and disabled revoked state');
    await check(`__fixture.requests.filter(r=>r.method==='POST').every(r=>r.headers['X-Bridge-Portal']==='1')`,'all mutation requests carry required header');
    await cdp.eval(`const b=document.querySelector('#keyRows button:not(:disabled)');b.focus();__fixture.focusId=b.dataset.focus;__fixture.keys.find(k=>String(k.id)===b.dataset.focus).label+='（已更新）'`);await refresh();
    await check(`document.activeElement.dataset.focus===__fixture.focusId`,'table refresh preserves focused key action');
    const beats=await cdp.eval(`__fixture.requests.filter(r=>r.url==='/portal/api/heartbeat').length`);await wait(5300);await idle();
    assert(await cdp.eval(`__fixture.requests.filter(r=>r.url==='/portal/api/heartbeat').length`)>beats);console.log('PASS automatic five-second heartbeat and refresh');
    assert.deepEqual(cdp.errors,[],'No runtime errors');
    const screenshot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(tempRoot,'portal-desktop-check.png'),Buffer.from(screenshot.data,'base64'));
    await cdp.send('Page.navigate',{url:'http://127.0.0.1:'+port+'/?initial=error'});await cdp.until(`!!window.__fixture && __fixture.errors.info && !!document.getElementById('refresh')`,'initial-error boot');await idle();
    await check(`${$('apiUrl')}.textContent==='接入信息暂不可用' && ${$('copyApi')}.disabled && ${$('keyRows')}.textContent.includes('加载失败') && ${$('requests')}.textContent==='—'`,'first-load errors do not masquerade as loading or empty data');
    await cdp.eval(`__fixture.errors={}`);await refresh();await check(`${$('requests')}.textContent==='128' && !${$('copyApi')}.disabled`,'first-load retry recovers');
    assert.deepEqual(cdp.errors,[],'No runtime errors after first-load retry');
    for(const key of ['devices','keys','requests','overview']){
      await cdp.send('Page.navigate',{url:'http://127.0.0.1:'+port+paths[key]});await cdp.until(`!!window.__fixture && !!document.querySelector('[data-page="${key}"]:not([hidden])')`,'direct URL '+key);await idle();
      await check(`document.querySelectorAll('[data-page]:not([hidden])').length===1 && document.querySelector('.nav [aria-current="page"]').dataset.route==='${key}'`,'direct URL and selected navigation: '+paths[key]);
    }
    await cdp.eval(`__fixture.navigationSentinel=123`);await navigate('devices');await navigate('keys');
    await check(`location.pathname==='/portal/keys' && __fixture.navigationSentinel===123 && document.activeElement.id==='pageTitle'`,'SPA navigation retains data and focuses page heading');
    await cdp.eval(`history.back()`);await cdp.until(`location.pathname==='/portal/devices' && document.querySelector('.nav [aria-current="page"]').dataset.route==='devices'`,'back route');
    await check(`document.activeElement.id==='pageTitle' && document.querySelectorAll('[data-page]:not([hidden])').length===1`,'browser Back restores route and useful focus');
    await cdp.eval(`history.forward()`);await cdp.until(`location.pathname==='/portal/keys' && document.querySelector('.nav [aria-current="page"]').dataset.route==='keys'`,'forward route');console.log('PASS browser Forward restores selected page');
    await cdp.eval(`document.querySelector('[data-route="requests"]').focus()`);await cdp.key('Enter','Enter',13);await cdp.until(`location.pathname==='/portal/requests'`,'Enter navigation');
    await check(`document.activeElement.id==='pageTitle' && ${$('requestsPage')}.checkVisibility()`,'top navigation works by keyboard Enter');
    await cdp.send('Page.reload');await cdp.until(`!!window.__fixture && document.querySelector('.nav [aria-current="page"]')?.dataset.route==='requests'`,'reload route');await idle();await check(`${$('requestsPage')}.checkVisibility() && ${$('statsFilters')}.checkVisibility()`,'page reload preserves direct requests route');
    await cdp.eval(`document.querySelector('.nav a[href="/console"]').click()`);await cdp.until(`!!window.__consoleFixture && !!document.getElementById('bridge-nav')`,'portal-to-console');console.log('PASS portal-to-console real link');

    for(const mode of ['remote','local','missing']){
      await cdp.send('Page.navigate',{url:'http://127.0.0.1:'+port+'/console?mode='+mode});await cdp.until(`!!window.__consoleFixture && !!document.getElementById('bridge-nav') && document.getElementById('pill').textContent.includes('运行中')`,'console '+mode);
      await check(`window.BRIDGE_REMOTE_ADMIN===${mode==='remote'} && document.querySelector('.bridge-nav-links [aria-current="page"]').textContent==='桥接配置'`,'console selected navigation and remote flag: '+mode);
      const hrefs=await cdp.eval(`[...document.querySelectorAll('.bridge-nav-links a')].map(a=>a.getAttribute('href'))`);assert.deepEqual(hrefs,mode==='missing'?[]:Object.values(paths).map(p=>(mode==='local'?'https://26.18.6.1:8443':'')+p));
      await check(`['pill','btnQuit','btnStart','btnStop','backend','log'].every(id=>document.getElementById(id).checkVisibility()) && document.getElementById('log').textContent.includes('演示数据')`,'legacy status, exit, controls and logs visible: '+mode);
      if(mode==='remote'){
        await check(`__consoleFixture.requests.every(r=>!r.url.includes('t=')&&r.headers['X-Bridge-Portal']==='1'&&!('X-Bridge-Token' in r.headers))`,'remote API uses same-origin portal header without local control token');
        await check(`document.getElementById('bkey').value==='' && document.getElementById('bkey').placeholder.includes('留空保留') && document.getElementById('btnCert').textContent==='下载根证书'`,'remote saved key stays masked and certificate action is client download');
      }
      if(mode==='missing')await check(`document.querySelector('.bridge-nav-unavailable').checkVisibility()`,'console remains usable when portal URL unavailable');
      for(const width of [320,390,768,1440]){
        await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await wait(60);
        await check(`document.documentElement.scrollWidth<=innerWidth+1 && (()=>{const p=document.getElementById('pill').getBoundingClientRect(),q=document.getElementById('btnQuit').getBoundingClientRect();return p.right<=q.left+1||p.top>=q.bottom||p.bottom<=q.top;})()`,'console responsive '+mode+' '+width+'px: no page overflow or status/exit overlap');
        const navOverlap=await cdp.eval(`(()=>{const list=[...document.querySelectorAll('.bridge-nav-link')].map(e=>e.getBoundingClientRect());return list.some((a,i)=>list.some((b,j)=>i!==j&&a.left<b.right-1&&a.right>b.left+1&&a.top<b.bottom-1&&a.bottom>b.top+1));})()`);assert(!navOverlap,'console nav overlap '+mode+' '+width);
        if(width===390){const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(tempRoot,'console-'+mode+'-390.png'),Buffer.from(shot.data,'base64'));}
      }
      await cdp.eval(`document.querySelector('.bridge-nav-links a')?.focus()`);await cdp.key('Tab','Tab',9);await check(`document.activeElement.matches(':focus-visible') && getComputedStyle(document.activeElement).outlineStyle==='solid'`,'console visible keyboard focus: '+mode);
      await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await check(`getComputedStyle(document.getElementById('pill')).animationName==='none'`,'console reduced motion: '+mode);await cdp.send('Emulation.setEmulatedMedia',{features:[]});
      const screen=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(tempRoot,'console-'+mode+'-check.png'),Buffer.from(screen.data,'base64'));
      await cdp.eval(`document.getElementById('btnStop').click()`);await cdp.until(`!__consoleFixture.running && document.getElementById('pill').textContent.includes('已停止')`,'legacy stop');
      await cdp.eval(`document.getElementById('btnStart').click()`);await cdp.until(`__consoleFixture.running && document.getElementById('pill').textContent.includes('运行中')`,'legacy start');
      await check(`__consoleFixture.requests.some(r=>r.url.split('?')[0].endsWith('/stop')) && __consoleFixture.requests.some(r=>r.url.split('?')[0].endsWith('/start'))`,'legacy start/stop handlers preserved (demo only): '+mode);
      if(mode==='remote')await check(`JSON.parse(__consoleFixture.requests.find(r=>r.url==='/api/start').body).preserve_backend_key===true`,'remote start preserves blank saved backend key');
      await cdp.eval(`window.confirm=()=>true;document.getElementById('btnQuit').click()`);await cdp.until(`document.getElementById('pill').textContent.includes('已退出')`,'legacy quit');await check(`__consoleFixture.requests.some(r=>r.url.split('?')[0].endsWith('/quit'))`,'legacy exit handler preserved (demo only): '+mode);
    }
    await cdp.send('Page.navigate',{url:'http://127.0.0.1:'+port+'/console'});await cdp.until(`!!document.querySelector('.bridge-nav-links a') && !!window.__consoleFixture`,'console link test');
    await cdp.eval(`document.querySelector('.bridge-nav-links a[href="/portal/devices"]').click()`);await cdp.until(`!!window.__fixture && !!document.querySelector('[data-page="devices"]:not([hidden])')`,'console to portal');console.log('PASS console-to-portal real link');
    assert.deepEqual(cdp.errors,[],'No runtime errors in routed portal or console shell');
    console.log('PASS no browser runtime exceptions');console.log('ALL PORTAL FRONTEND TESTS PASSED');
  } finally {
    if(cdp)cdp.socket.close();child.kill();await new Promise(resolve=>server.close(resolve));
    await wait(400);try{fs.rmSync(dir,{recursive:true,force:true});}catch{/* Chrome may release files after exit on Windows. */}
  }
}
run().catch(error=>{console.error(error.stack);process.exitCode=1;});
