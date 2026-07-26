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

/* ---------- wordmark injection ---------- */
function wordmark(el, size){
  const rem = $('#remTpl').content.cloneNode(true);
  el.innerHTML = '';
  const mk = (t,c)=>{ const s=document.createElement('span'); s.className=c; s.textContent=t; return s; };
  el.appendChild(mk('N','l'));
  const x=document.createElement('span'); x.className='x'; x.textContent='×'; el.appendChild(x);
  el.appendChild(rem);
  el.appendChild(mk('T','l'));
  el.appendChild(mk('V','v'));
  const tm=document.createElement('span'); tm.className='tm'; tm.textContent='™'; el.appendChild(tm);
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
const CBAR_ORDER=['#pRew','#pPlay','#pFwd','#pNext','#pAspect','#pCC','#pAudio'];
function cbarButtons(){ return CBAR_ORDER.map(s=>$(s)).filter(b=>b && b.style.display!=='none'); }
function navFullscreen(dir){
  showControls();
  const cur=focusEl;
  const onScrub = cur===$('#scrub');
  const onBack = cur===$('#backBtn');
  const btns=cbarButtons();
  const inRow = btns.includes(cur);

  if(onScrub){
    if(dir==='left'){ seek(-10); return; }
    if(dir==='right'){ seek(10); return; }
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
    keys.forEach(sk=>seasons[sk].forEach(e=>episodeList.push({id:String(e.id),label:'S'+sk+' · '+(e.title||('Ep '+e.episode_num)),url:`${CREDS.host}/series/${enc(CREDS.user)}/${enc(CREDS.pass)}/${e.id}.${e.container_extension||'mp4'}`})));
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
  clearSidecarSubs(); $('#pCC').classList.remove('active');
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

function togglePlay(){ const v=$('#video'); if(v.paused)v.play().catch(()=>{}); else v.pause(); }
$('#pPlay').addEventListener('click',togglePlay);
function seek(d){ const v=$('#video'); if(!isNaN(v.duration)) v.currentTime=Math.min(v.duration,Math.max(0,v.currentTime+d)); showControls(); }
const ASPECT_MODES=[{id:'fit',label:'⬛ Fit',cls:'mode-fit'},{id:'zoom',label:'⛶ Zoom',cls:'mode-zoom'},{id:'stretch',label:'↔ Stretch',cls:'mode-stretch'}];
let aspectIdx=0;
function cycleAspect(){ aspectIdx=(aspectIdx+1)%ASPECT_MODES.length; const m=ASPECT_MODES[aspectIdx]; const vw=$('#vwrap'); vw.classList.remove('mode-fit','mode-zoom','mode-stretch'); vw.classList.add(m.cls); $('#pAspect').textContent=m.label; showControls(); }
$('#pAspect').addEventListener('click',cycleAspect);
$('#pRew').addEventListener('click',()=>seek(-10));
$('#pFwd').addEventListener('click',()=>seek(10));
$('#scrub').addEventListener('click',e=>{ const v=$('#video'); const r=$('#scrub').getBoundingClientRect(); const p=Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)); if(!isNaN(v.duration))v.currentTime=p*v.duration; });

const fmtTime=s=>{ s=Math.max(0,Math.floor(s||0)); const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60; return h>0?`${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`:`${m}:${String(ss).padStart(2,'0')}`; };
const video=$('#video');
video.addEventListener('timeupdate',()=>{ const v=video; if(isNaN(v.duration))return; const pct=(v.currentTime/v.duration)*100;
  $('#scrubFill').style.width=pct+'%'; $('#scrubKnob').style.left=pct+'%'; $('#curTime').textContent=fmtTime(v.currentTime); $('#durTime').textContent=fmtTime(v.duration);
  try{ if(v.buffered.length)$('#scrubBuf').style.width=((v.buffered.end(v.buffered.length-1)/v.duration)*100)+'%'; }catch{} });
video.addEventListener('play',()=>{ $('#pPlay').textContent='❚❚'; clearInterval(saveTimer); saveTimer=setInterval(saveProgress,5000); });
video.addEventListener('pause',()=>{ $('#pPlay').textContent='►'; saveProgress(); });
video.addEventListener('ended',()=>{ localStorage.removeItem(progressKey()); });

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
