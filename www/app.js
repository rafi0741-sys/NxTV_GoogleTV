'use strict';
/* =========================================================================
   NXTV — clean rebuild
   Core idea: ONE focus model. Every focusable element is `.foc`. Navigation
   is spatial (nearest neighbor) but CONSTRAINED BY SCOPE so focus never leaks
   between the sidebar, channel list, and player. The fullscreen control bar
   is a single horizontal scope with one rule:
     - Left/Right moves focus along the bar
     - EXCEPT on the scrubber, where Left/Right seeks
   ========================================================================= */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const enc = encodeURIComponent;
const esc = s => String(s ?? '').replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
// Sidecar subtitle blob URL (provider .srt/.vtt next to the video)
let sidecarSubUrl=null;

/* ---------- version badge ----------
   APP_VERSION is bumped by hand with each change. BUILD_STAMP is filled in by
   the workflow from the commit and the time the APK was built, so the badge
   identifies the exact build running on the TV rather than what the source
   happened to say. An un-stamped build (built outside CI) just shows the
   version on its own. */
const APP_VERSION = '1.7';
const BUILD_STAMP = '__BUILD_STAMP__';
function versionText(){
  const st = BUILD_STAMP;
  const stamped = st && st.indexOf('BUILD_STAMP') === -1;
  return 'v' + APP_VERSION + (stamped ? ' · ' + st : '');
}

/* ---------- wordmark injection ---------- */
function wordmark(el, size){
  const rem = $('#remTpl').content.cloneNode(true);
  el.innerHTML = '';
  const mk = (t,c)=>{ const s=document.createElement('span'); s.className=c; s.textContent=t; return s; };
  el.appendChild(mk('N','l'));
  const x=document.createElement('span'); x.className='x'; x.textContent='×'; el.appendChild(x);
  el.appendChild(rem);
  el.appendChild(mk('V','v'));
  const tm=document.createElement('span'); tm.className='tm'; tm.textContent='™'; el.appendChild(tm);
  const ver=document.createElement('span');
  ver.className='ver';
  ver.textContent = (el.id === 'wmHome') ? versionText() : ('v' + APP_VERSION);
  el.appendChild(ver);
}
['#wmLogin','#wmHome','#wmNav'].forEach(s=>wordmark($(s)));

/* ---------- loading bar ---------- */
const loadbar=$('#loadbar'); let lbTimer=null, lbP=0;
function loadStart(){ lbP=8; loadbar.style.width='8%'; clearInterval(lbTimer); lbTimer=setInterval(()=>{lbP=Math.min(lbP+Math.random()*12,88);loadbar.style.width=lbP+'%';},300); }
function loadEnd(){ clearInterval(lbTimer); loadbar.style.width='100%'; setTimeout(()=>loadbar.style.width='0',350); }

/* =========================================================================
   FOCUS ENGINE
   ========================================================================= */
let focusEl=null;
function setFocus(el){
  if(!el) return;
  if(focusEl) focusEl.classList.remove('on');
  focusEl=el; el.classList.add('on');
  if(el.tagName==='INPUT'){
    el.focus({preventScroll:true});
  } else if(document.activeElement && document.activeElement.tagName==='INPUT'){
    // Blur the input we just left so the key handler stops treating keys as
    // "typing" — otherwise OK/Enter on a focused button is ignored (the bug
    // that broke the D-pad Connect button on the TV remote).
    document.activeElement.blur();
  }
  el.scrollIntoView({block:'nearest',inline:'nearest'});
}
function focusables(scope){
  return $$('.foc').filter(el=>{
    if(el.offsetParent===null && el.tagName!=='VIDEO') return false; // visible only
    if(scope && !scope.contains(el)) return false;
    return true;
  });
}
// which scope is currently active — determines what set of elements nav can reach
function activeScope(){
  if($('#login').classList.contains('show')) return $('#login');
  if($('#editor').classList.contains('show')) return $('#editor');
  if($('#home').classList.contains('show')) return $('#home');
  const vw=$('#vwrap');
  if(vw.classList.contains('fs')){
    if($('#tpop').classList.contains('show')) return $('#tpop');
    if($('#resume').classList.contains('show')) return $('#resume');
    return $('#cbar'); // fullscreen control bar
  }
  return $('#app');
}
// spatial nearest-neighbor within a set
function nearest(dir, cur, els){
  const cr=cur.getBoundingClientRect();
  const cx=cr.left+cr.width/2, cy=cr.top+cr.height/2;
  let best=null, bestScore=Infinity;
  for(const el of els){
    if(el===cur) continue;
    const r=el.getBoundingClientRect();
    const x=r.left+r.width/2, y=r.top+r.height/2;
    const dx=x-cx, dy=y-cy;
    let primary, cross;
    if(dir==='right'){ if(dx<=6)continue; primary=dx; cross=Math.abs(dy); }
    else if(dir==='left'){ if(dx>=-6)continue; primary=-dx; cross=Math.abs(dy); }
    else if(dir==='down'){ if(dy<=6)continue; primary=dy; cross=Math.abs(dx); }
    else { if(dy>=-6)continue; primary=-dy; cross=Math.abs(dx); }
    const score=primary+cross*3;
    if(score<bestScore){ bestScore=score; best=el; }
  }
  return best;
}

/* column helper for the 3-pane app view */
function colOf(el){ const c=el && el.closest('.col'); if(!c) return -1; return [...$$('#app .col')].indexOf(c); }

/* main navigation entry point */
function navigate(dir){
  const vw=$('#vwrap');
  // ----- Fullscreen player: dedicated control model (unless a popover/resume is open) -----
  if(vw.classList.contains('fs') && !$('#tpop').classList.contains('show') && !$('#resume').classList.contains('show')){
    return navFullscreen(dir);
  }
  const scope=activeScope();
  // ----- 3-pane app view: constrain vertical to column, horizontal between columns -----
  if(scope && scope.id==='app'){
    return navApp(dir);
  }
  // ----- everything else (login/home/editor/popovers): plain spatial within scope -----
  const els=focusables(scope);
  if(!focusEl || !els.includes(focusEl)){ setFocus(els[0]); return; }
  const nx=nearest(dir, focusEl, els);
  if(nx) setFocus(nx);
}

function navApp(dir){
  const els=focusables($('#app'));
  if(!focusEl || !focusEl.isConnected || !els.includes(focusEl)){
    // Focus was lost or element was detached — land on the playing channel or first channel, not the Home button
    const target=$('#chList .ch.playing')||$('#chList .ch')||els[0];
    if(target) setFocus(target);
    return;
  }
  const vertical=(dir==='up'||dir==='down');
  const curCol=colOf(focusEl);
  let pool;
  if(vertical){
    pool=els.filter(e=>colOf(e)===curCol);       // stay in same column
  } else {
    pool=els.filter(e=>colOf(e)!==curCol);        // move between columns
  }
  const nx=nearest(dir, focusEl, pool);
  if(nx){ setFocus(nx); return; }
  // Right from a focused channel with nothing to the right → focus the video surface
  if(dir==='right' && focusEl.classList.contains('ch')){
    if($('#video').src||hls){ setFocus($('#vsurface')); }
  }
}

/* -------- Fullscreen control bar navigation (the rebuilt core) --------
   Order of focusable controls, left→right: pRew, pPlay, pFwd, [pNext], pCC, pAudio, scrub, backBtn
   Rule:
     - Up/Down: toggle between the button row and the scrub bar / back button
     - Left/Right: move along the current row
     - On scrub: Left/Right SEEK (do not move focus)
*/
const CBAR_ORDER=['#pRew','#pPlay','#pFwd','#pNext','#pAspect','#pCC','#pAudio','#pVlc'];
function cbarButtons(){ return CBAR_ORDER.map(s=>$(s)).filter(b=>b && b.style.display!=='none'); }
function navFullscreen(dir){
  showControls();
  const cur=focusEl;
  const onScrub = cur===$('#scrub');
  const onBack = cur===$('#backBtn');
  const btns=cbarButtons();
  const inRow = btns.includes(cur);

  if(onScrub){
    if(dir==='left'){ nudgeSeek(-1); return; }
    if(dir==='right'){ nudgeSeek(1); return; }
    if(dir==='up'){ setFocus($('#backBtn')); return; }
    if(dir==='down'){ setFocus(btns[0]); return; }
    return;
  }
  if(onBack){
    if(dir==='down'){ setFocus($('#scrub')); return; }
    return; // back button: up/left/right do nothing special
  }
  if(inRow){
    const i=btns.indexOf(cur);
    if(dir==='left'){ if(i>0) setFocus(btns[i-1]); return; }
    if(dir==='right'){ if(i<btns.length-1) setFocus(btns[i+1]); return; }
    if(dir==='up'){ setFocus($('#scrub')); return; }
    if(dir==='down'){ setFocus($('#backBtn')); return; }
    return;
  }
  // focus wasn't on a control yet → land on play
  setFocus($('#pPlay'));
}

/* activate the focused element (OK / Enter) */
function activate(){
  const el=focusEl;
  if(!el) return;
  if(el.tagName==='INPUT') return; // let it type
  el.click();
}

/* =========================================================================
   BACK handling — unified. Returns true if handled (don't exit app).
   ========================================================================= */
function handleBack(){
  if(document.activeElement && document.activeElement.tagName==='INPUT'){ document.activeElement.blur(); return true; }
  if($('#tpop').classList.contains('show')){ closeTrackPop(); return true; }
  if($('#resume').classList.contains('show')){ hideResume(); return true; }
  if($('#vwrap').classList.contains('fs')){ exitFs(); return true; }
  if($('#editor').classList.contains('show')){ closeEditor(); return true; }
  if($('#app').classList.contains('show')){ stopPlayback(); showHome(); return true; }
  return true; // on home/login: never exit via Back — use the Home button to leave
}

/* =========================================================================
   KEY HANDLING — single listener, clear precedence
   ========================================================================= */
const BACK_KEYS=new Set(['Backspace','XF86Back','BrowserBack','GoBack','Escape']);
const BACK_CODES=new Set([10009,461,4,8,27,166]);
document.addEventListener('keydown',e=>{
  const k=e.key, code=e.keyCode;
  const typing=document.activeElement && document.activeElement.tagName==='INPUT';

  if(BACK_KEYS.has(k)||BACK_CODES.has(code)){
    if(typing && (k==='Backspace')) return; // allow editing text
    handleBack(); // always handle — Back never exits the app
    e.preventDefault(); e.stopPropagation();
    return;
  }
  if(k==='ArrowLeft'){ if(!typing){ navigate('left'); e.preventDefault(); } }
  else if(k==='ArrowRight'){ if(!typing){ navigate('right'); e.preventDefault(); } }
  else if(k==='ArrowUp'){ navigate('up'); e.preventDefault(); }
  else if(k==='ArrowDown'){ navigate('down'); e.preventDefault(); }
  else if(k==='Enter'||code===13){
    if(typing) return;
    const vw=$('#vwrap');
    if(vw.classList.contains('fs') && ffActive()){
      ffStop(true); showControls(); e.preventDefault(); return;   // stop racing
    }
    if(vw.classList.contains('fs') && vw.classList.contains('hidebar')){
      showControls(); e.preventDefault(); return;   // first press only wakes the bar
    }
    activate(); e.preventDefault();
  }
});

/* =========================================================================
   STORAGE — accounts, recents, favorites, progress
   ========================================================================= */
const store={
  get accounts(){ try{return JSON.parse(localStorage.getItem('nxtv_accounts'))||[];}catch{return [];} },
  set accounts(v){ localStorage.setItem('nxtv_accounts',JSON.stringify(v)); },
  get activeId(){ return localStorage.getItem('nxtv_active')||null; },
  set activeId(v){ v?localStorage.setItem('nxtv_active',v):localStorage.removeItem('nxtv_active'); }
};
function getAccount(id){ return store.accounts.find(a=>a.id===id)||null; }
function saveAccount(a){ const l=store.accounts; const i=l.findIndex(x=>x.id===a.id); if(i>=0)l[i]=a; else l.push(a); store.accounts=l; }
function deleteAccount(id){ store.accounts=store.accounts.filter(a=>a.id!==id); if(store.activeId===id) store.activeId=store.accounts[0]?.id||null; }

const RECENT_CAP=30;
const recentsKey=t=>'nxtv_recent_'+(store.activeId||'x')+'_'+t;
const getRecents=t=>{ try{return JSON.parse(localStorage.getItem(recentsKey(t)))||[];}catch{return [];} };
function pushRecent(t,it){ const snap={stream_id:it.stream_id,series_id:it.series_id,name:it.name,stream_icon:it.stream_icon||it.cover||'',container_extension:it.container_extension||'',group:it.group||''};
  const id=snap.stream_id||snap.series_id; let l=getRecents(t).filter(x=>(x.stream_id||x.series_id)!==id); l.unshift(snap); l=l.slice(0,RECENT_CAP);
  try{localStorage.setItem(recentsKey(t),JSON.stringify(l));}catch{} }
const favKey=()=>'nxtv_fav_'+(store.activeId||'x')+'_live';
const getFavs=()=>{ try{return JSON.parse(localStorage.getItem(favKey()))||[];}catch{return [];} };
const isFav=id=>getFavs().some(x=>x.stream_id===id);
function toggleFav(it){ const id=it.stream_id; let l=getFavs(); if(l.some(x=>x.stream_id===id))l=l.filter(x=>x.stream_id!==id); else l.unshift({stream_id:id,name:it.name,stream_icon:it.stream_icon||'',group:it.group||''}); try{localStorage.setItem(favKey(),JSON.stringify(l));}catch{} return isFav(id); }
const progressKey=()=>'nxtv_pos_'+(store.activeId||'x')+'_'+(state.activeCh||'')+'_'+(currentEpId||'');

/* =========================================================================
   STATE
   ========================================================================= */
let CREDS=null;                 // active account (resolved)
let M3U={streams:[]};           // parsed M3U cache
let state={type:'live',cat:null,cats:[],channels:[],activeCh:null};
let hls=null;
let isVod=false;                // current stream is on-demand
let currentEpId='';
let curItemName='';
let episodeList=[];
let pendingResume=0;
let saveTimer=null;
let controlsTimer=null;

/* =========================================================================
   XTREAM / M3U DATA
   ========================================================================= */
const catAction={live:'get_live_categories',vod:'get_vod_categories',series:'get_series_categories'};
const streamAction={live:'get_live_streams',vod:'get_vod_streams',series:'get_series'};
function apiBase(){ return `${CREDS.host}/player_api.php?username=${enc(CREDS.user)}&password=${enc(CREDS.pass)}`; }
async function api(params){ const r=await fetch(`${apiBase()}&${params}`); if(!r.ok)throw new Error('HTTP '+r.status); return r.json(); }

function parseM3U(text){
  const lines=text.split(/\r?\n/); const out=[]; let cur=null; let id=0;
  for(const raw of lines){ const line=raw.trim();
    if(line.startsWith('#EXTINF')){ const c=line.indexOf(','); const name=c>=0?line.slice(c+1).trim():'Untitled';
      const attr=k=>{const m=line.match(new RegExp(k+'="([^"]*)"','i'));return m?m[1]:'';};
      cur={stream_id:++id,name,stream_icon:attr('tvg-logo'),group:attr('group-title')||'Ungrouped'};
    } else if(line && !line.startsWith('#')){ if(cur){cur.url=line;out.push(cur);cur=null;} else out.push({stream_id:++id,name:(line.split('/').pop()||'Stream'),url:line,group:'Ungrouped',stream_icon:''}); }
  }
  return out;
}
const m3uCats=streams=>{ const seen=new Map(); for(const s of streams){const g=s.group||'Ungrouped'; if(!seen.has(g))seen.set(g,{category_id:g,category_name:g});} return [...seen.values()]; };

/* =========================================================================
   LOGIN
   ========================================================================= */
async function xtreamVerify(a){
  const host=a.host.replace(/\/+$/,'');
  const r=await fetch(`${host}/player_api.php?username=${enc(a.user)}&password=${enc(a.pass)}`);
  if(!r.ok)throw new Error('Server returned '+r.status);
  const d=await r.json();
  if(!d.user_info||d.user_info.auth===0)throw new Error('Invalid username or password.');
  if(d.user_info.status && d.user_info.status.toLowerCase()!=='active')throw new Error('Account status: '+d.user_info.status);
  return d;
}
async function m3uLoad(a){
  let text;
  if(a.type==='m3u_file'){ if(!a.m3uText)throw new Error('No stored playlist.'); text=a.m3uText; }
  else { const r=await fetch(a.url); if(!r.ok)throw new Error('Could not fetch playlist ('+r.status+').'); text=await r.text(); }
  const s=parseM3U(text); if(!s.length)throw new Error('No channels found in playlist.'); return s;
}
$('#lConnect').addEventListener('click',async()=>{
  const err=$('#lErr'); err.textContent='';
  const host=$('#lHost').value, user=$('#lUser').value, pass=$('#lPass').value;
  if(!host||!user||!pass){ err.textContent='Fill in all fields.'; return; }
  loadStart();
  try{
    const a={id:'acc_'+Date.now(),type:'xtream',name:host.replace(/^https?:\/\//,'').trim(),host:host.trim(),user:user.trim(),pass:pass.trim()};
    await xtreamVerify(a); saveAccount(a); store.activeId=a.id;
    CREDS={type:'xtream',host:a.host.replace(/\/+$/,''),user:a.user,pass:a.pass};
    loadEnd(); enterApp();
  }catch(e){ loadEnd(); err.textContent=e.message.includes('Failed to fetch')?'Could not reach server. Check the URL and port.':e.message; }
});

/* =========================================================================
   ACCOUNT ACTIVATION
   ========================================================================= */
async function activate_account(id){
  const a=getAccount(id); if(!a)return;
  loadStart();
  try{
    if(a.type==='xtream'){ await xtreamVerify(a); CREDS={type:'xtream',host:a.host.replace(/\/+$/,''),user:a.user,pass:a.pass}; }
    else { const s=await m3uLoad(a); M3U={streams:s}; CREDS={type:'m3u',name:a.name}; }
    store.activeId=id; loadEnd(); enterApp();
  }catch(e){ loadEnd(); alert('Could not load "'+a.name+'": '+(e.message.includes('Failed to fetch')?'Server unreachable or blocked.':e.message)); showHome(); }
}

/* =========================================================================
   HOME
   ========================================================================= */
function showHome(){
  $('#login').classList.remove('show'); $('#editor').classList.remove('show'); $('#app').classList.remove('show');
  $('#home').classList.add('show');
  renderHome();
  setTimeout(()=>{ const f=focusables($('#home'))[0]; if(f) setFocus(f); },70);
}
function renderHome(){
  const grid=$('#grid'); grid.innerHTML='';
  for(const a of store.accounts){
    const active=a.id===store.activeId;
    const card=document.createElement('div'); card.className='acct'+(active?' active':'');
    const typeLabel=a.type==='xtream'?'Xtream':(a.type==='m3u_url'?'M3U URL':'M3U File');
    const badgeCls=a.type==='xtream'?'':'m3u';
    const meta=a.type==='xtream'?esc(a.host):(a.type==='m3u_url'?esc(a.url):(a.m3uName||'local file'));
    card.innerHTML=`<span class="badge ${badgeCls}">${typeLabel}</span>${active?'<span class="tag">● Active</span>':''}
      <h3>${esc(a.name||'Untitled')}</h3><div class="meta">${meta}</div>
      <div class="row">
        <button class="cbtn pri foc" data-act="open">${active?'Open':'Use'}</button>
        <button class="cbtn foc" data-act="reload">Reload</button>
        <button class="cbtn foc" data-act="edit">Edit</button>
        <button class="cbtn danger foc" data-act="del">Delete</button>
      </div>`;
    card.querySelector('[data-act=open]').onclick=()=>activate_account(a.id);
    card.querySelector('[data-act=reload]').onclick=()=>activate_account(a.id);
    card.querySelector('[data-act=edit]').onclick=()=>openEditor(a.id);
    card.querySelector('[data-act=del]').onclick=()=>{ if(confirm('Delete "'+(a.name||'this account')+'"?')){ deleteAccount(a.id); renderHome(); setTimeout(()=>{const f=focusables($('#home'))[0];if(f)setFocus(f);},50); } };
    grid.appendChild(card);
  }
  const add=document.createElement('button'); add.className='add foc'; add.textContent='+  Add account'; add.onclick=()=>openEditor(null);
  grid.appendChild(add);
}
$('#navHome').addEventListener('click',()=>{ stopPlayback(); showHome(); });

/* =========================================================================
   EDITOR
   ========================================================================= */
let editingId=null, pickedSrc='xtream', pickedFile=null;
function setSrc(src){ pickedSrc=src; $$('.sbtn').forEach(b=>b.classList.toggle('sel',b.dataset.src===src)); $$('.sfields').forEach(f=>f.style.display=f.dataset.for===src?'':'none'); }
$$('.sbtn').forEach(b=>b.onclick=()=>setSrc(b.dataset.src));
$('#eM3uFile').addEventListener('change',e=>{ pickedFile=e.target.files[0]||null; $('#eFileNote').textContent=pickedFile?pickedFile.name+' selected':'No file chosen.'; });
function openEditor(id){
  editingId=id; const a=id?getAccount(id):null;
  $('#eTitle').textContent=a?'Edit account':'Add account'; $('#eErr').textContent='';
  pickedFile=null; $('#eFileNote').textContent='No file chosen.'; $('#eM3uFile').value='';
  $('#eName').value=a?.name||''; $('#eHost').value=a?.host||''; $('#eUser').value=a?.user||''; $('#ePass').value=a?.pass||''; $('#eM3uUrl').value=a?.url||'';
  setSrc(a?.type||'xtream');
  $('#home').classList.remove('show'); $('#login').classList.remove('show'); $('#editor').classList.add('show');
  setTimeout(()=>setFocus($('#eName')),70);
}
function closeEditor(){ $('#editor').classList.remove('show'); showHome(); }
$('#eCancel').addEventListener('click',closeEditor);
$('#eSave').addEventListener('click',async()=>{
  const err=$('#eErr'); err.textContent='';
  const name=$('#eName').value.trim(); const src=pickedSrc;
  const base={id:editingId||('acc_'+Date.now()),type:src,name};
  try{
    if(src==='xtream'){ let host=$('#eHost').value.trim(); const user=$('#eUser').value.trim(),pass=$('#ePass').value.trim();
      if(!host||!user||!pass){err.textContent='Fill in server, username and password.';return;}
      if(!/^https?:\/\//i.test(host))host='http://'+host; Object.assign(base,{host,user,pass}); if(!base.name)base.name=host.replace(/^https?:\/\//,'');
    } else if(src==='m3u_url'){ const url=$('#eM3uUrl').value.trim(); if(!url){err.textContent='Enter the M3U playlist URL.';return;} Object.assign(base,{url}); if(!base.name)base.name=url.split('/').pop()||'M3U playlist';
    } else { const ex=editingId?getAccount(editingId):null;
      if(pickedFile){ const text=await pickedFile.text(); const s=parseM3U(text); if(!s.length){err.textContent='That file has no channels.';return;} Object.assign(base,{m3uText:text,m3uName:pickedFile.name,m3uCount:s.length}); if(!base.name)base.name=pickedFile.name.replace(/\.(m3u8?|txt)$/i,''); }
      else if(ex&&ex.m3uText){ Object.assign(base,{m3uText:ex.m3uText,m3uName:ex.m3uName,m3uCount:ex.m3uCount}); }
      else { err.textContent='Choose an M3U file.'; return; }
    }
    saveAccount(base); closeEditor();
  }catch(e){ err.textContent=e.message||'Could not save.'; }
});

/* =========================================================================
   APP: enter, tabs, categories, channels
   ========================================================================= */
function enterApp(){
  $('#login').classList.remove('show'); $('#home').classList.remove('show'); $('#editor').classList.remove('show');
  $('#app').classList.add('show');
  const m3u=CREDS.type==='m3u';
  $('.navbtn[data-type=vod]').style.display=m3u?'none':'';
  $('.navbtn[data-type=series]').style.display=m3u?'none':'';
  state.type='live'; state.cat=null; state.channels=[]; state.activeCh=null;
  $$('.navbtn[data-type]').forEach(b=>b.classList.remove('sel'));
  $('.navbtn[data-type=live]').classList.add('sel');
  $('#chSearch').value='';
  $('#chList').innerHTML='<div class="empty">Pick a category to load channels.</div>';
  loadCategories();
  setTimeout(()=>{ const f=$('.navbtn[data-type=live]'); if(f) setFocus(f); },80);
}
$$('.navbtn[data-type]').forEach(b=>b.onclick=()=>{
  $$('.navbtn[data-type]').forEach(x=>x.classList.remove('sel')); b.classList.add('sel');
  state.type=b.dataset.type; state.cat=null; state.channels=[];
  $('#chSearch').value='';
  $('#chList').innerHTML='<div class="empty">Pick a category to load channels.</div>';
  loadCategories();
});

async function loadCategories(){
  const list=$('#catList'); list.innerHTML='<div class="empty">Loading…</div>'; loadStart();
  try{
    if(CREDS.type==='m3u'){ state.cats=m3uCats(M3U.streams); }
    else { const c=await api('action='+catAction[state.type]); state.cats=Array.isArray(c)?c:[]; }
    renderCategories();
  }catch{ list.innerHTML='<div class="empty">Failed to load categories.</div>'; }
  finally{ loadEnd(); }
}
function renderCategories(){
  const list=$('#catList'); list.innerHTML='';
  const pin=(id,label)=>{ const d=document.createElement('div'); d.className='cat foc'+(state.cat===id?' sel':''); d.textContent=label;
    d.onclick=()=>{ state.cat=id; markCat(); loadChannels(id); }; list.appendChild(d); };
  pin('__all__','★ All');
  if(getRecents(state.type).length) pin('__recent__','⟳ Recent');
  if(state.type==='live' && getFavs().length) pin('__fav__','♥ Favorites');
  for(const c of state.cats){ const d=document.createElement('div'); d.className='cat foc'+(state.cat===c.category_id?' sel':''); d.textContent=c.category_name;
    d.onclick=()=>{ state.cat=c.category_id; markCat(); loadChannels(c.category_id); }; list.appendChild(d); }
}
function markCat(){ $$('#catList .cat').forEach(d=>d.classList.remove('sel')); }

async function loadChannels(catId){
  const list=$('#chList'); list.innerHTML='<div class="empty">Loading channels…</div>'; loadStart();
  try{
    if(catId==='__recent__'){ state.channels=getRecents(state.type).slice(); }
    else if(catId==='__fav__'){ state.channels=getFavs().slice(); }
    else if(CREDS.type==='m3u'){ state.channels=catId==='__all__'?M3U.streams.slice():M3U.streams.filter(s=>(s.group||'Ungrouped')===catId); }
    else { const q=catId==='__all__'?`action=${streamAction[state.type]}`:`action=${streamAction[state.type]}&category_id=${catId}`; const s=await api(q); state.channels=Array.isArray(s)?s:[]; }
    renderChannels();
    setTimeout(()=>{ const first=$('#chList .ch'); if(first) setFocus(first); },60);
  }catch{ list.innerHTML='<div class="empty">Failed to load.</div>'; }
  finally{ loadEnd(); }
}
const RENDER_CAP=300;
function renderChannels(){
  const q=$('#chSearch').value.toLowerCase().trim(), list=$('#chList');
  const items=state.channels.filter(c=>(c.name||'').toLowerCase().includes(q));
  if(!items.length){ list.innerHTML='<div class="empty">No channels.</div>'; return; }
  list.innerHTML='';
  const head=document.createElement('div'); head.className='chcount';
  head.textContent=items.length>RENDER_CAP?`${items.length} results · showing first ${RENDER_CAP} — type to narrow`:`${items.length} result${items.length===1?'':'s'}`;
  list.appendChild(head);
  items.slice(0,RENDER_CAP).forEach(c=>{
    const id=c.stream_id||c.series_id, logo=c.stream_icon||c.cover;
    const div=document.createElement('div'); div.className='ch foc'+(state.activeCh===id?' playing':''); div._id=id;
    const img=logo?`<img src="${esc(logo)}" loading="lazy" onerror="this.outerHTML='<div class=noimg>◉</div>'">`:`<div class="noimg">◉</div>`;
    const sub=state.type==='live'?'LIVE':(c.rating?'★ '+c.rating:(state.type==='series'?'SERIES':'MOVIE'));
    const heart=state.type==='live'?`<button class="heart foc${isFav(c.stream_id)?' fav':''}" data-fav="1">${isFav(c.stream_id)?'♥':'♡'}</button>`:'';
    div.innerHTML=`${img}<div class="meta"><div class="t">${esc(c.name||'Untitled')}</div><div class="s">${sub}</div></div>${heart}`;
    div.onclick=e=>{ if(e.target.closest('.heart'))return; play(c); };
    const hb=div.querySelector('.heart');
    if(hb) hb.onclick=e=>{ e.stopPropagation(); const on=toggleFav(c); hb.classList.toggle('fav',on); hb.textContent=on?'♥':'♡';
      if(state.cat==='__fav__'&&!on){ state.channels=getFavs().slice(); renderChannels(); } renderCategories(); };
    list.appendChild(div);
  });
}
$('#chSearch').addEventListener('input',renderChannels);

/* =========================================================================
   PLAYBACK
   ========================================================================= */
function streamUrl(c){
  if(CREDS.type==='m3u') return c.url;
  const id=c.stream_id, ext=c.container_extension||(state.type==='live'?'m3u8':'mp4');
  if(state.type==='live') return `${CREDS.host}/live/${enc(CREDS.user)}/${enc(CREDS.pass)}/${id}.m3u8`;
  if(state.type==='vod') return `${CREDS.host}/movie/${enc(CREDS.user)}/${enc(CREDS.pass)}/${id}.${ext}`;
  return null;
}
async function play(c){
  if(state.type==='series' && CREDS.type!=='m3u') return playSeries(c);
  currentEpId=''; episodeList=[]; updateNextBtn(); curItemName=c.name||'';
  pushRecent(state.type,c);
  state.activeCh=c.stream_id; markPlaying();
  $('#placeholder').style.display='none';
  const url=streamUrl(c);
  const live=CREDS.type==='m3u'?(url||'').includes('.m3u8'):state.type==='live';
  const fmt=((url||'').split('.').pop().split('?')[0]||'').toUpperCase().slice(0,4)||'M3U8';
  $('#now').innerHTML=`${live?'<div class="live-tag"><span class="dot"></span>Live</div>':''}<h2>${esc(c.name)}</h2><div class="nsub">${live?'Live stream':'On demand'} · ${fmt}</div><div class="buffering" id="buf">Connecting…</div><div class="hint-play">Press OK or ► on the video to go fullscreen.</div>`;
  loadStream(url,live);
}
function markPlaying(){ $$('#chList .ch').forEach(d=>d.classList.toggle('playing', d._id===state.activeCh)); }

async function playSeries(c){
  pushRecent('series',c); state.activeCh=c.series_id; markPlaying(); $('#placeholder').style.display='none'; curItemName=c.name||'';
  $('#now').innerHTML=`<h2>${esc(c.name)}</h2><div class="buffering">Loading episodes…</div>`;
  try{
    const info=await api(`action=get_series_info&series_id=${c.series_id}`);
    const seasons=info.episodes||{}, keys=Object.keys(seasons);
    if(!keys.length)throw new Error('No episodes found.');
    episodeList=[];
    keys.forEach(sk=>seasons[sk].forEach(e=>episodeList.push({id:String(e.id),season:parseInt(sk,10)||0,episode:parseInt(e.episode_num,10)||0,label:'S'+sk+' · '+(e.title||('Ep '+e.episode_num)),url:`${CREDS.host}/series/${enc(CREDS.user)}/${enc(CREDS.pass)}/${e.id}.${e.container_extension||'mp4'}`})));
    let epHtml='<div class="nsub" style="margin-top:16px">Episodes</div><div class="eplist">';
    episodeList.forEach(ep=>{ epHtml+=`<div class="ep foc" data-ep="${esc(ep.id)}"><div class="noimg">▶</div><div class="meta"><div class="t">${esc(ep.label)}</div></div></div>`; });
    epHtml+='</div>';
    $('#now').innerHTML=`<h2>${esc(c.name)}</h2><div class="nsub">${keys.length} season(s)</div><div id="buf" class="buffering">Loading…</div>${epHtml}`;
    $$('#now .ep').forEach(el=>{ el.onclick=()=>{ const ep=episodeList.find(x=>x.id===el.dataset.ep); if(ep){ currentEpId=ep.id; updateNextBtn(); $('#placeholder').style.display='none'; loadStream(ep.url,false); } }; });
    const first=episodeList[0]; currentEpId=first.id; updateNextBtn(); loadStream(first.url,false);
  }catch(e){ $('#now').innerHTML=`<h2>${esc(c.name)}</h2><div class="serr">${esc(e.message)}</div>`; }
}
function currentEpIndex(){ return episodeList.findIndex(e=>e.id===currentEpId); }
function updateNextBtn(){ const i=currentEpIndex(); $('#pNext').style.display=(episodeList.length&&i>=0&&i<episodeList.length-1)?'':'none'; }
function playNext(){ const i=currentEpIndex(); if(i>=0&&i<episodeList.length-1){ const n=episodeList[i+1]; currentEpId=n.id; updateNextBtn(); loadStream(n.url,false); showControls(); } }
$('#pNext').addEventListener('click',playNext);

function loadStream(url,live){
  currentStreamUrl=url||'';
  clearSidecarSubs(); clearOsSubs(); ffStop(false); cancelSeekPreview(); stopAudioWatch(); $('#pCC').classList.remove('active');
  const v=$('#video');
  if(hls){ hls.destroy(); hls=null; }
  v.pause(); v.removeAttribute('src'); v.load();
  isVod=!live;
  if(!live) trySidecarSubs(url);
  aspectIdx=0; $('#vwrap').classList.remove('mode-zoom','mode-stretch'); const _ab=$('#pAspect'); if(_ab)_ab.textContent=ASPECT_MODES[0].label;
  const onErr=m=>{ const b=$('#buf'); if(b){ b.className='serr'; b.textContent=m; } };
  const onReady=()=>{ const b=$('#buf'); if(b)b.remove(); };
  const m3u8=(url||'').includes('.m3u8');
  if(m3u8 && window.Hls && Hls.isSupported()){
    hls=new Hls({lowLatencyMode:live,enableWorker:true,maxBufferLength:live?10:30});
    hls.loadSource(url); hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED,()=>{ onReady(); maybeResume(); v.play().catch(()=>{}); populateTrackButtons(); });
    hls.on(Hls.Events.ERROR,(_,d)=>{ if(d.fatal){ if(d.type===Hls.ErrorTypes.NETWORK_ERROR)onErr('Network error — stream offline or unreachable.'); else if(d.type===Hls.ErrorTypes.MEDIA_ERROR)hls.recoverMediaError(); else onErr('Playback failed: '+d.details); } });
  } else {
    v.src=url;
    v.addEventListener('loadeddata',()=>{ onReady(); maybeResume(); populateTrackButtons(); },{once:true});
    v.addEventListener('error',()=>onErr('Could not play this stream.'),{once:true});
    v.play().catch(()=>{});
  }
}
function stopPlayback(){ if(hls){hls.destroy();hls=null;} const v=$('#video'); v.pause(); v.removeAttribute('src'); v.load(); clearInterval(saveTimer); }

/* =========================================================================
   FULLSCREEN + CONTROL BAR
   ========================================================================= */
function enterFs(){ const vw=$('#vwrap'); if(!($('#video').src||hls))return; vw.classList.add('fs'); showControls();
  setTimeout(()=>setFocus(isVod?$('#pPlay'):$('#backBtn')),60); }
function exitFs(){ const vw=$('#vwrap'); clearTimeout(controlsTimer); vw.classList.remove('fs','hidebar'); closeTrackPop();
  setTimeout(()=>{ const cur=$('#chList .ch.playing')||$('#chList .ch'); if(cur) setFocus(cur); },60); }
function showControls(){ const vw=$('#vwrap'); vw.classList.remove('hidebar'); clearTimeout(controlsTimer);
  controlsTimer=setTimeout(()=>{ if(vw.classList.contains('fs')&&!$('#tpop').classList.contains('show')) vw.classList.add('hidebar'); },4500); }

// video surface (preview pane): OK/Right → fullscreen
$('#vsurface').addEventListener('click',()=>{ if($('#video').src||hls) enterFs(); });
$('#backBtn').addEventListener('click',()=>exitFs());

function togglePlay(){ const v=$('#video'); if(ffActive()){ ffStop(true); return; } commitSeek(); if(v.paused)v.play().catch(()=>{}); else v.pause(); }
$('#pPlay').addEventListener('click',togglePlay);
function seek(d){ const v=$('#video'); if(!isNaN(v.duration)) v.currentTime=Math.min(v.duration,Math.max(0,v.currentTime+d)); showControls(); }
const ASPECT_MODES=[{id:'fit',label:'⬛ Fit',cls:'mode-fit'},{id:'zoom',label:'⛶ Zoom',cls:'mode-zoom'},{id:'stretch',label:'↔ Stretch',cls:'mode-stretch'}];
let aspectIdx=0;
function cycleAspect(){ aspectIdx=(aspectIdx+1)%ASPECT_MODES.length; const m=ASPECT_MODES[aspectIdx]; const vw=$('#vwrap'); vw.classList.remove('mode-fit','mode-zoom','mode-stretch'); vw.classList.add(m.cls); $('#pAspect').textContent=m.label; showControls(); }
$('#pAspect').addEventListener('click',cycleAspect);
$('#pRew').addEventListener('click',()=>ffStart(-1));
$('#pFwd').addEventListener('click',()=>ffStart(1));
$('#pRew').textContent='◀◀';
$('#pFwd').textContent='▶▶';
addVlcButton();
$('#scrub').addEventListener('click',e=>{
  const v=$('#video');
  // A remote's OK arrives here as a synthetic click with no pointer position,
  // which used to compute position 0 and restart the film. detail is 0 for
  // those and 1+ for a real mouse click.
  if(!e.detail){
    if(ffActive()){ ffStop(true); showControls(); return; }
    if(seekPreview!==null){ commitSeek(); return; }
    showControls(); return;
  }
  ffStop(false); cancelSeekPreview();
  const r=$('#scrub').getBoundingClientRect();
  if(!r.width || isNaN(v.duration) || !isFinite(v.duration)) return;
  const p=Math.min(1,Math.max(0,(e.clientX-r.left)/r.width));
  v.currentTime=p*v.duration;
});

const fmtTime=s=>{ s=Math.max(0,Math.floor(s||0)); const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60; return h>0?`${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`:`${m}:${String(ss).padStart(2,'0')}`; };
const video=$('#video');
video.addEventListener('timeupdate',()=>{ if(seekPreview!==null) return; paintScrub(video.currentTime); });

/* =========================================================================
   HAND OFF TO VLC
   Some releases carry DTS or Dolby audio, which the system WebView has no
   decoder for: perfect picture, no sound. VLC ships its own decoders, so the
   stream is handed to it whole. Capacitor's bridge fires a bare ACTION_VIEW
   with no MIME type, which Android sends to a browser, so a small native
   plugin builds the intent VLC actually documents.
   ========================================================================= */
let currentStreamUrl='';
function vlcPlugin(){
  const P=window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Vlc;
  return (P && typeof P.open==='function') ? P : null;
}
function addVlcButton(){
  const row=document.querySelector('.cbar-btns');
  if(!row || $('#pVlc')) return;
  const b=document.createElement('button');
  b.className='pbtn foc'; b.id='pVlc'; b.textContent='▶ VLC';
  b.title='Play this in VLC';
  b.addEventListener('click',openInVlc);
  row.appendChild(b);
}
async function openInVlc(){
  const P=vlcPlugin();
  if(!P){ toastShow('The VLC handoff needs a newer build of this app.'); return; }
  if(!currentStreamUrl){ toastShow('Nothing is playing yet.'); return; }
  const v=video;
  const pos = (!isNaN(v.currentTime) && v.currentTime>5) ? Math.floor(v.currentTime*1000) : 0;
  try{
    v.pause();
    await P.open({ url: currentStreamUrl, title: curItemName||'', position: pos });
  }catch(err){
    const m = (err && (err.message||err.errorMessage)) ? (err.message||err.errorMessage) : String(err);
    toastShow(/player/i.test(m) ? 'No video player found. Install VLC from the Play Store, then try again.' : ('Could not open VLC: '+m));
  }
}

/* =========================================================================
   SCRUBBING AND FAST-FORWARD
   Left/Right on the scrub bar moves a PREVIEW marker and only commits the
   real seek once you stop pressing, so a network stream rebuffers once
   instead of once per press. Holding the D-pad accelerates the step.
   The ◀◀ / ▶▶ buttons cycle 2x, 4x, 8x, 16x. Low rates play the video
   faster; high rates step through it, which a network stream can keep up
   with. OK, play/pause or a seek drops back to normal speed.
   ========================================================================= */
/* Chromium counts the bytes it has actually decoded. Video climbing while
   audio stays at zero means the track is there but no decoder will touch it —
   DTS or Dolby, which the system WebView cannot play. */
let audioWatch=null, audioToast=null;
function toastShow(msg){
  if(!audioToast){
    audioToast=document.createElement('div');
    audioToast.style.cssText='position:absolute;left:50%;bottom:14%;transform:translateX(-50%);'+
      'max-width:78%;padding:14px 20px;border-radius:12px;background:rgba(0,0,0,.8);'+
      'color:#e8f0e8;font-size:17px;line-height:1.45;text-align:center;z-index:97;'+
      'pointer-events:none;display:none';
    $('#vwrap').appendChild(audioToast);
  }
  audioToast.textContent=msg;
  audioToast.style.display='block';
  clearTimeout(audioToast._t);
  audioToast._t=setTimeout(()=>{ audioToast.style.display='none'; },9000);
}
function stopAudioWatch(){ if(audioWatch){ clearTimeout(audioWatch); audioWatch=null; } }
function startAudioWatch(){
  stopAudioWatch();
  audioWatch=setTimeout(()=>{
    const v=video;
    if(!v || v.muted || ffActive() || v.paused) return;
    const a=v.webkitAudioDecodedByteCount, vid=v.webkitVideoDecodedByteCount;
    if(typeof a!=='number'||typeof vid!=='number') return;   // not exposed: say nothing
    if(vid>0 && a===0){
      toastShow('No sound: this copy uses an audio format this TV cannot decode (usually DTS or Dolby). Try another version of the title.');
    }
  },7000);
}

function paintScrub(t){
  const v=video;
  if(isNaN(v.duration)||!v.duration) return;
  const pct=Math.min(100,Math.max(0,(t/v.duration)*100));
  $('#scrubFill').style.width=pct+'%';
  $('#scrubKnob').style.left=pct+'%';
  $('#curTime').textContent=fmtTime(t);
  $('#durTime').textContent=fmtTime(v.duration);
  try{ if(v.buffered.length)$('#scrubBuf').style.width=((v.buffered.end(v.buffered.length-1)/v.duration)*100)+'%'; }catch(e){}
}

/* ---- preview scrubbing ---- */
let seekPreview=null, seekCommitTimer=null, seekRuns=0, seekLastAt=0;
function seekStepSize(){
  const now=Date.now();
  if(now-seekLastAt>700) seekRuns=0;
  seekLastAt=now;
  seekRuns++;
  if(seekRuns<=3) return 10;
  if(seekRuns<=8) return 30;
  if(seekRuns<=16) return 60;
  return 120;
}
function nudgeSeek(dir){
  const v=video;
  if(isNaN(v.duration)||!v.duration) return;
  ffStop(false);
  if(seekPreview===null) seekPreview=v.currentTime;
  seekPreview=Math.min(v.duration, Math.max(0, seekPreview + dir*seekStepSize()));
  paintScrub(seekPreview);
  showControls();
  clearTimeout(seekCommitTimer);
  seekCommitTimer=setTimeout(commitSeek,450);
}
function commitSeek(){
  clearTimeout(seekCommitTimer); seekCommitTimer=null;
  if(seekPreview===null) return;
  const t=seekPreview;
  seekPreview=null; seekRuns=0;
  try{ video.currentTime=t; }catch(e){}
}
function cancelSeekPreview(){
  clearTimeout(seekCommitTimer); seekCommitTimer=null;
  seekPreview=null; seekRuns=0;
}

/* ---- fast forward / rewind ---- */
const FF_RATES=[2,4,8,16];
let ffDir=0, ffIdx=-1, ffTimer=null, ffBadge=null, ffWasMuted=false;
function ffActive(){ return ffDir!==0; }
function ffShow(txt){
  if(!ffBadge){
    ffBadge=document.createElement('div');
    ffBadge.id='ffBadge';
    ffBadge.style.cssText='position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);'+
      'padding:14px 28px;border-radius:14px;background:rgba(0,0,0,.72);color:#e8f0e8;'+
      'font-size:36px;font-weight:800;font-style:italic;letter-spacing:.02em;z-index:96;'+
      'pointer-events:none;display:none';
    $('#vwrap').appendChild(ffBadge);
  }
  ffBadge.textContent=txt;
  ffBadge.style.display='block';
}
function ffHide(){ if(ffBadge) ffBadge.style.display='none'; }
function ffStart(dir){
  const v=video;
  if(isNaN(v.duration)||!isFinite(v.duration)||!v.duration) return;   // live: nothing to race through
  cancelSeekPreview();
  if(!ffActive()) ffWasMuted=v.muted;
  if(dir!==ffDir){ ffDir=dir; ffIdx=-1; }
  ffIdx++;
  if(ffIdx>=FF_RATES.length){ ffStop(true); return; }
  ffApply();
}
function ffApply(){
  const v=video, rate=FF_RATES[ffIdx];
  clearInterval(ffTimer); ffTimer=null;
  if(ffDir>0 && rate<=4){
    v.muted=true;
    try{ v.playbackRate=rate; }catch(e){}
    v.play().catch(()=>{});
  } else {
    try{ v.playbackRate=1; }catch(e){}
    v.muted=true;
    v.pause();
    ffTimer=setInterval(()=>{
      const t=v.currentTime + ffDir*rate*0.4;
      if(t<=0){ try{ v.currentTime=0; }catch(e){} ffStop(true); return; }
      if(t>=v.duration-1){ try{ v.currentTime=Math.max(0,v.duration-1); }catch(e){} ffStop(true); return; }
      try{ v.currentTime=t; }catch(e){}
      paintScrub(v.currentTime);
    },400);
  }
  ffShow((ffDir>0?'▶▶ ':'◀◀ ')+rate+'x');
  showControls();
}
function ffStop(resume){
  if(ffTimer){ clearInterval(ffTimer); ffTimer=null; }
  if(!ffActive()){ ffHide(); return; }
  const v=video;
  ffDir=0; ffIdx=-1;
  try{ v.playbackRate=1; }catch(e){}
  v.muted=ffWasMuted;
  ffHide();
  if(resume!==false) v.play().catch(()=>{});
}
video.addEventListener('playing',()=>{ startAudioWatch(); });
video.addEventListener('play',()=>{ $('#pPlay').textContent='❚❚'; clearInterval(saveTimer); saveTimer=setInterval(saveProgress,5000); });
video.addEventListener('pause',()=>{ $('#pPlay').textContent='►'; saveProgress(); });
video.addEventListener('ended',()=>{ ffStop(false); cancelSeekPreview(); localStorage.removeItem(progressKey()); });

/* resume */
function saveProgress(){ if(!isVod)return; const v=video; if(!v.duration||isNaN(v.duration))return; if(v.currentTime<5||v.currentTime>v.duration-15){localStorage.removeItem(progressKey());return;} try{localStorage.setItem(progressKey(),JSON.stringify({t:v.currentTime,d:v.duration}));}catch{} }
function maybeResume(){ if(!isVod){hideResume();return;} let s=null; try{s=JSON.parse(localStorage.getItem(progressKey()));}catch{} if(s&&s.t>10){ pendingResume=s.t; $('#rAt').textContent=fmtTime(s.t); $('#resume').classList.add('show'); setTimeout(()=>setFocus($('#rResume')),60); } else { pendingResume=0; hideResume(); } }
function hideResume(){ $('#resume').classList.remove('show'); }
$('#rResume').addEventListener('click',()=>{ if(pendingResume)video.currentTime=pendingResume; hideResume(); video.play().catch(()=>{}); if($('#vwrap').classList.contains('fs'))setFocus($('#pPlay')); });
$('#rRestart').addEventListener('click',()=>{ video.currentTime=0; hideResume(); video.play().catch(()=>{}); if($('#vwrap').classList.contains('fs'))setFocus($('#pPlay')); });

/* audio / subtitle tracks */
function audioTracks(){ if(hls&&hls.audioTracks&&hls.audioTracks.length)return hls.audioTracks.map((t,i)=>({i,label:t.name||t.lang||('Audio '+(i+1))})); const v=video,l=[]; if(v.audioTracks)for(let i=0;i<v.audioTracks.length;i++){const t=v.audioTracks[i];l.push({i,label:t.label||t.language||('Audio '+(i+1))});} return l; }
function captionTracks(){ if(hls&&hls.subtitleTracks&&hls.subtitleTracks.length){return hls.subtitleTracks.map((t,i)=>({i,label:t.name||t.lang||('Subtitle '+(i+1))}));} const v=video,l=[]; if(v.textTracks)for(let i=0;i<v.textTracks.length;i++){const t=v.textTracks[i];if(t.kind==='subtitles'||t.kind==='captions')l.push({i,label:t.label||t.language||('Subtitle '+(i+1))});} return l; }
function populateTrackButtons(){ /* buttons always present; menus show 'none available' when empty */ }
let trackMode='audio';
function openTrackPop(mode){
  trackMode=mode; showControls();
  const pop=$('#tpop'), list=$('#tpopList');
  $('#tpopTitle').textContent=mode==='audio'?'Audio track':'Subtitles';
  list.innerHTML='';
  let items=mode==='audio'?audioTracks():captionTracks();
  if(mode==='caps') items=[{i:-1,label:'Off'}].concat(items);
  if(!items.length || (mode==='caps'&&items.length===1)){ const d=document.createElement('div'); d.className='tnone'; d.textContent=mode==='audio'?'Only one audio track.':'No subtitles in this stream.'; list.appendChild(d); }
  items.forEach(it=>{ const d=document.createElement('div'); d.className='titem foc'; d.textContent=it.label;
    if(mode==='audio'){ const cur=hls&&hls.audioTracks?hls.audioTrack:(video.audioTracks?[...video.audioTracks].findIndex(t=>t.enabled):0); if(cur===it.i)d.classList.add('sel'); }
    else { let act=-1; if(hls&&hls.subtitleTracks&&hls.subtitleTracks.length){act=hls.subtitleTrack;} else if(video.textTracks)for(let i=0;i<video.textTracks.length;i++)if(video.textTracks[i].mode==='showing')act=i; if(act===it.i)d.classList.add('sel'); }
    d.onclick=()=>{ selectTrack(mode,it.i); closeTrackPop(); }; list.appendChild(d); });
  if(mode==='caps') osAppendMenu(list);
  pop.classList.add('show');
  setTimeout(()=>{ const f=list.querySelector('.titem'); if(f)setFocus(f); },50);
}
function closeTrackPop(){ $('#tpop').classList.remove('show'); if($('#vwrap').classList.contains('fs')) setFocus(trackMode==='audio'?$('#pAudio'):$('#pCC')); }
function selectTrack(mode,idx){ const v=video;
  if(mode==='audio'){ if(hls&&hls.audioTracks&&hls.audioTracks.length)hls.audioTrack=idx; else if(v.audioTracks)for(let i=0;i<v.audioTracks.length;i++)v.audioTracks[i].enabled=(i===idx); }
  else { if(hls&&hls.subtitleTracks&&hls.subtitleTracks.length){hls.subtitleTrack=idx;} else if(v.textTracks)for(let i=0;i<v.textTracks.length;i++)v.textTracks[i].mode=(i===idx?'showing':'disabled'); $('#pCC').classList.toggle('active',idx>=0); } }
/* ---- Sidecar subtitles (provider .srt/.vtt next to the video) ---- */
function clearSidecarSubs(){ if(sidecarSubUrl){ URL.revokeObjectURL(sidecarSubUrl); sidecarSubUrl=null; } $$('#video track[data-sidecar]').forEach(t=>t.remove()); }
function srtToVtt(s){ return 'WEBVTT\n\n'+s.replace(/\r/g,'').replace(/^\d+\n(?=\d{2}:)/gm,'').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g,'$1.$2'); }
async function trySidecarSubs(url){
  const base=(url||'').replace(/\.[^./?]+(\?.*)?$/,'');
  for(const ext of ['srt','vtt']){
    const cand=base+'.'+ext;
    try{
      const r=await fetch(cand);
      if(!r.ok) continue;
      let text=await r.text();
      if(!/^\s*(WEBVTT|\d+\s*\n\d{2}:|\d{2}:\d{2}:)/.test(text)) continue; // not a subtitle file
      if(ext==='srt' || !/^\s*WEBVTT/.test(text)) text=srtToVtt(text);
      clearSidecarSubs();
      const blob=new Blob([text],{type:'text/vtt'}); sidecarSubUrl=URL.createObjectURL(blob);
      const v=$('#video');
      const tk=document.createElement('track'); tk.kind='subtitles'; tk.label='Provider'; tk.srclang='und'; tk.src=sidecarSubUrl; tk.setAttribute('data-sidecar','1'); v.appendChild(tk);
      break;
    }catch{}
  }
}

/* =========================================================================
   ONLINE SUBTITLES — OpenSubtitles REST API v1
   Requests go through Capacitor's native HTTP plugin, so they are NOT subject
   to the WebView's CORS rules and CAN send the User-Agent header the API
   requires. On a plain browser (desktop testing) it falls back to fetch().
   ========================================================================= */
const OS_API = 'https://api.opensubtitles.com/api/v1';
const OS_APP_UA = 'NXTV v1.1';
// Replaced at build time by scripts/inject_key.py from the OPENSUBTITLES_API_KEY
// repository secret. Left as the placeholder, online search just stays off.
const OS_KEY_BUILTIN = '__OPENSUBTITLES_API_KEY__';
const OS_LANGS = ['en','tl','es','fr','de','it','pt','id','zh-cn'];
let osSubUrl = null;
let osLastTransport = '';

function osKey(){
  const typed = (localStorage.getItem('nxtv_os_key')||'').trim();
  if(typed) return typed;
  // The build-time placeholder is full of underscores, so an un-injected build
  // reads as "no key" instead of sending the placeholder to the API.
  return /^[A-Za-z0-9]{16,}$/.test(OS_KEY_BUILTIN) ? OS_KEY_BUILTIN : '';
}
function osLang(){
  const l = (localStorage.getItem('nxtv_os_lang')||'en').toLowerCase();
  return OS_LANGS.includes(l) ? l : 'en';
}
function osCycleLang(){
  const i = OS_LANGS.indexOf(osLang());
  localStorage.setItem('nxtv_os_lang', OS_LANGS[(i+1)%OS_LANGS.length]);
}

/* ---- transport ---- */
function osPlugin(){
  const P = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) || window.CapacitorHttp;
  return (P && typeof P.request === 'function') ? P : null;
}
async function osHttp(opts){
  const P = osPlugin();
  if(P){
    osLastTransport = 'native';
    const r = await P.request({
      url: opts.url,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      data: opts.data,
      responseType: 'text',
      connectTimeout: 20000,
      readTimeout: 30000
    });
    let body = r && r.data;
    if(body == null) body = '';
    else if(typeof body !== 'string'){ try{ body = JSON.stringify(body); }catch(e){ body = String(body); } }
    return { status: (r && r.status)|0, text: body };
  }
  osLastTransport = 'web';
  const r = await fetch(opts.url, {
    method: opts.method || 'GET',
    headers: opts.headers || {},
    body: opts.data ? JSON.stringify(opts.data) : undefined
  });
  return { status: r.status, text: await r.text() };
}
function osJson(res){ try{ return JSON.parse(res.text); }catch(e){ return null; } }
function osErrText(res){
  const d = osJson(res);
  let msg = 'HTTP ' + res.status;
  if(d){
    if(d.message) msg = d.message;
    else if(Array.isArray(d.errors) && d.errors.length) msg = d.errors.join(', ');
  }
  if(res.status===401||res.status===403) msg += ' — check the API key';
  if(res.status===406||res.status===429) msg += ' — daily download limit reached';
  return msg;
}
function osHeaders(json){
  const h = { 'Api-Key': osKey(), 'User-Agent': OS_APP_UA, 'Accept': 'application/json' };
  if(json) h['Content-Type'] = 'application/json';
  return h;
}

/* ---- what to search for ---- */
const OS_JUNK = /\b(4k|uhd|fhd|hd|sd|hq|cam|ts|2160p|1080p?|720p?|480p|web-?dl|webrip|bluray|blu-ray|brrip|bdrip|hdrip|dvdrip|x264|x265|h264|h265|hevc|aac|ac3|eac3|dts|ddp5|5 1|multi|dual|dub|dubbed|subbed|remux|extended|uncut|imax|hdr|sdr)\b/gi;
function osCleanTitle(raw){
  let s = String(raw||'');
  s = s.replace(/^\s*[A-Z0-9]{2,5}\s*[|:\-–]\s*/, '');     // provider prefix: "EN| Title", "VIP - Title"
  s = s.replace(/\.(mp4|mkv|avi|m3u8|ts)$/i, '');
  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');
  s = s.replace(/\b(19|20)\d{2}\b[\s\S]*$/, ' ');            // cut at the year
  s = s.replace(OS_JUNK, ' ');
  s = s.replace(/[._]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return s;
}
function osYear(raw){ const m = String(raw||'').match(/\b(19|20)\d{2}\b/); return m ? parseInt(m[0],10) : 0; }
function osCurrentTarget(){
  const q = osCleanTitle(curItemName);
  const t = { query: q, year: osYear(curItemName), season: 0, episode: 0 };
  const i = currentEpIndex();
  if(i >= 0 && episodeList[i]){ t.season = episodeList[i].season||0; t.episode = episodeList[i].episode||0; }
  return t;
}

/* ---- API calls ---- */
async function osSearch(t){
  if(!osKey()) throw new Error('No OpenSubtitles API key in this build.');
  if(!t.query) throw new Error('Could not work out a title to search for.');
  const p = new URLSearchParams({
    query: t.query.toLowerCase(),
    languages: osLang(),
    order_by: 'download_count',
    order_direction: 'desc'
  });
  if(t.season > 0) p.set('season_number', String(t.season));
  if(t.episode > 0) p.set('episode_number', String(t.episode));
  if(t.year > 0 && !t.season) p.set('year', String(t.year));
  p.sort();   // the API redirects unless the parameters are sorted
  const res = await osHttp({ url: OS_API + '/subtitles?' + p.toString().replace(/\+/g,'%20'), headers: osHeaders() });
  if(res.status < 200 || res.status >= 300) throw new Error(osErrText(res));
  const d = osJson(res);
  if(!d) throw new Error('OpenSubtitles sent a reply the app could not read.');
  const out = [];
  (Array.isArray(d.data) ? d.data : []).forEach(it => {
    const a = it && it.attributes; if(!a) return;
    const f = Array.isArray(a.files) && a.files[0];
    if(!f || !f.file_id) return;
    out.push({
      fileId: f.file_id,
      name: a.release || (f.file_name||'') || 'Subtitle',
      lang: (a.language||'').toUpperCase(),
      downloads: a.download_count||0,
      hearing: !!a.hearing_impaired
    });
  });
  return out;
}
async function osDownload(fileId){
  const res = await osHttp({
    url: OS_API + '/download', method: 'POST', headers: osHeaders(true),
    data: { file_id: fileId, sub_format: 'srt' }
  });
  if(res.status < 200 || res.status >= 300) throw new Error(osErrText(res));
  const info = osJson(res) || {};
  if(!info.link) throw new Error(info.message || 'No download link returned.');
  let u; try{ u = new URL(info.link); }catch(e){ throw new Error('No usable download link returned.'); }
  const host = u.hostname.toLowerCase();
  const allowed = ['opensubtitles.com','oscdn.net'].some(d => host===d || host.endsWith('.'+d));
  if(u.protocol !== 'https:' || !allowed) throw new Error('Unexpected download host: ' + host);
  const file = await osHttp({ url: u.href });
  if(file.status < 200 || file.status >= 300) throw new Error('Subtitle file download failed (HTTP ' + file.status + ').');
  if(!file.text || file.text.length < 20) throw new Error('Subtitle file came back empty.');
  return { text: file.text, name: info.file_name||'', remaining: (info.remaining==null?null:info.remaining) };
}

/* ---- attach to the video ---- */
function clearOsSubs(){
  if(osSubUrl){ URL.revokeObjectURL(osSubUrl); osSubUrl = null; }
  $$('#video track[data-os]').forEach(t => t.remove());
}
function loadOsSubs(text, label){
  clearOsSubs();
  const vtt = /^\s*WEBVTT/.test(text) ? text : srtToVtt(text);
  osSubUrl = URL.createObjectURL(new Blob([vtt], {type:'text/vtt'}));
  const v = $('#video');
  const tk = document.createElement('track');
  tk.kind = 'subtitles';
  // hls.js disables text tracks that carry a label, so stay unlabelled on HLS
  tk.label = hls ? '' : (label || 'OpenSubtitles');
  tk.srclang = 'und';
  tk.setAttribute('data-os','1');
  tk.src = osSubUrl;
  v.appendChild(tk);
  const show = () => {
    try{
      for(let i=0;i<v.textTracks.length;i++) v.textTracks[i].mode = 'disabled';
      if(tk.track) tk.track.mode = 'showing';
    }catch(e){}
  };
  tk.addEventListener('load', show, {once:true});
  setTimeout(show, 250);
  setTimeout(show, 1200);
  $('#pCC').classList.add('active');
}

/* ---- the menu, drawn inside the existing subtitle popover ---- */
function osNote(list, text, cls){
  const d = document.createElement('div');
  d.className = cls || 'tnone';
  d.textContent = text;
  list.appendChild(d);
  return d;
}
function osItem(list, text, onPick){
  const d = document.createElement('div');
  d.className = 'titem foc';
  d.textContent = text;
  d.onclick = onPick;
  list.appendChild(d);
  return d;
}
function osRefocus(){
  setTimeout(() => { const f = $('#tpopList .titem'); if(f) setFocus(f); }, 50);
}
function osAppendMenu(list){
  const t = osCurrentTarget();
  const sep = document.createElement('div');
  sep.className = 'tpop-title';
  sep.style.borderTop = '1px solid var(--line)';
  sep.style.marginTop = '6px';
  sep.textContent = 'Online';
  list.appendChild(sep);
  if(!osKey()){
    osNote(list, 'No API key in this build — see the build step.');
    return;
  }
  const what = t.season > 0 ? `${t.query} S${t.season}E${t.episode}` : (t.query || '—');
  osItem(list, `🔍 Search “${what}”`, () => osRunSearch(t));
  osItem(list, '✎ Type a title…', () => osAskQuery(t));
  const langRow = osItem(list, `🌐 Language: ${osLang().toUpperCase()}`, () => {
    osCycleLang();
    langRow.textContent = `🌐 Language: ${osLang().toUpperCase()}`;
    setFocus(langRow);
  });
}
function osAskQuery(t){
  const list = $('#tpopList');
  $('#tpopTitle').textContent = 'Search subtitles';
  list.innerHTML = '';
  osNote(list, 'Edit the title, then choose Search.');
  const wrap = document.createElement('div');
  wrap.style.cssText = 'padding:4px 4px 10px';
  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'foc'; inp.id = 'osQ';
  inp.value = t.query || '';
  inp.autocomplete = 'off'; inp.spellcheck = false;
  inp.style.cssText = 'width:100%;padding:12px 14px;background:var(--bg);border:1px solid var(--line);'+
    'border-radius:9px;color:var(--text);font-size:16px';
  wrap.appendChild(inp);
  list.appendChild(wrap);
  const go = () => {
    const raw = (inp.value || '').trim();
    if(!raw){ setFocus(inp); return; }
    const year = osYear(raw);
    const q = raw.replace(/\b(19|20)\d{2}\b/, ' ').replace(/\s{2,}/g, ' ').trim();
    osRunSearch({ query: q || raw, year: year, season: t.season || 0, episode: t.episode || 0 });
  };
  inp.addEventListener('keydown', e => {
    if(e.key === 'Enter' || e.keyCode === 13){ e.preventDefault(); go(); }
  });
  osItem(list, '🔍 Search', go);
  const langRow2 = osItem(list, `🌐 Language: ${osLang().toUpperCase()}`, () => {
    osCycleLang();
    langRow2.textContent = `🌐 Language: ${osLang().toUpperCase()}`;
    setFocus(langRow2);
  });
  osItem(list, '↩ Back', () => openTrackPop('caps'));
  setTimeout(() => setFocus(inp), 60);
}
async function osRunSearch(t){
  const list = $('#tpopList');
  $('#tpopTitle').textContent = 'Online subtitles';
  list.innerHTML = '';
  osNote(list, 'Searching OpenSubtitles…');
  let results;
  try{
    results = await osSearch(t);
  }catch(err){
    list.innerHTML = '';
    osNote(list, 'Search failed: ' + (err && err.message ? err.message : String(err)));
    osNote(list, 'via ' + (osLastTransport || 'unknown') + ' HTTP');
    osItem(list, '↩ Back', () => openTrackPop('caps'));
    osRefocus();
    return;
  }
  list.innerHTML = '';
  if(!results.length){
    osNote(list, `Nothing found for “${t.query}” in ${osLang().toUpperCase()}.`);
    osItem(list, '✎ Type a title…', () => osAskQuery(t));
    osItem(list, '🌐 Try another language', () => { osCycleLang(); osRunSearch(t); });
    osItem(list, '↩ Back', () => openTrackPop('caps'));
    osRefocus();
    return;
  }
  results.slice(0, 20).forEach(r => {
    const tag = (r.hearing ? ' [SDH]' : '');
    osItem(list, `${r.lang} · ${String(r.name).slice(0,46)}${tag}`, () => osPick(r));
  });
  osItem(list, '↩ Back', () => openTrackPop('caps'));
  osRefocus();
}
async function osPick(r){
  const list = $('#tpopList');
  list.innerHTML = '';
  osNote(list, 'Downloading subtitle…');
  try{
    const f = await osDownload(r.fileId);
    loadOsSubs(f.text, r.lang ? ('OpenSubtitles ' + r.lang) : 'OpenSubtitles');
    list.innerHTML = '';
    osNote(list, 'Subtitles on' + (f.remaining!=null ? ` · ${f.remaining} downloads left today` : ''));
    setTimeout(closeTrackPop, 1400);
  }catch(err){
    list.innerHTML = '';
    osNote(list, 'Download failed: ' + (err && err.message ? err.message : String(err)));
    osItem(list, '↩ Back', () => openTrackPop('caps'));
    osRefocus();
  }
}

$('#pAudio').addEventListener('click',()=>openTrackPop('audio'));
$('#pCC').addEventListener('click',()=>openTrackPop('caps'));

/* quit (desktop exe only) */
if(window.__NXTV_DESKTOP){ const q=$('#quitBtn'); if(q){ q.style.display='inline-block'; q.addEventListener('click',()=>{ if(confirm('Quit NXTV?')){ fetch('/quit').catch(()=>{}); document.body.innerHTML='<div style="color:#8fae98;font-family:sans-serif;padding:60px;text-align:center;font-size:18px">NXTV closed. You can close this tab.</div>'; } }); } }

/* =========================================================================
   NATIVE BACK (Android TV via Capacitor)
   ========================================================================= */
(function nativeBack(){
  let done=false;
  function attach(App){ if(done||!App)return; try{ App.addListener('backButton',()=>{ if(!handleBack()){ try{App.exitApp();}catch(e){} } }); done=true; }catch(e){} }
  function tryAttach(){ if(done)return true; if(window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.App){ attach(window.Capacitor.Plugins.App); return true; } return false; }
  if(!tryAttach()){ document.addEventListener('deviceready',tryAttach); document.addEventListener('DOMContentLoaded',tryAttach); let n=0; const iv=setInterval(()=>{ if(tryAttach()||++n>40)clearInterval(iv); },250); }
})();

/* =========================================================================
   BOOT
   ========================================================================= */
(function boot(){
  // migrate legacy single-account key if present
  try{ const legacy=JSON.parse(localStorage.getItem('xtream_creds')); if(legacy && !store.accounts.length){ const a={id:'acc_'+Date.now(),type:'xtream',name:legacy.host.replace(/^https?:\/\//,''),host:legacy.host,user:legacy.user,pass:legacy.pass}; store.accounts=[a]; store.activeId=a.id; localStorage.removeItem('xtream_creds'); } }catch{}
  if(store.accounts.length){ showHome(); }
  else { $('#login').classList.add('show'); setTimeout(()=>setFocus($('#lHost')),80); }
})();
