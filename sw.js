/* 地籍瀏覽器 service worker（PWA 離線快取；和選點 repo 同網域，快取名稱用 cv- 開頭，兩邊互不刪除）
   - 網頁（index.html）與已知點 CTL、ctl/list.txt：先抓網路（最多等 NET_WAIT 毫秒），失敗或逾時才用快取 → 上傳新版後重新整理就會更新
   - Leaflet、Firebase SDK、字型、圖示：版本固定，先用快取
   - NLSC 底圖圖磚：看過才存，全部圖層合計有張數上限，超過刪最舊的
   - Firestore 連線不經過這裡（由 Firebase 自己的離線快取處理）
   改了這個檔才需要把 VER 加一；只改 index.html 不用動。 */
const VER='v1';
const SHELL='cv-shell-'+VER, LIB='cv-lib-'+VER, TILE='cv-tile';
const NET_WAIT=4000;
const TILE_MAX_CORS=2000, TILE_MAX_OPAQUE=300; /* 沒有 CORS 的圖磚（opaque）佔配額很大，上限放小 */
const LIB_URLS=[
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
];
const LIB_HOSTS=['cdnjs.cloudflare.com','fonts.googleapis.com','fonts.gstatic.com'];
const SCOPE=self.registration.scope;
const PAGE_KEY=SCOPE; /* index.html 不論網址怎麼寫都存在同一把 key */
const ICONS=['manifest.json','icon-192.png','icon-512.png','apple-touch-icon.png'];
function pageKey(u){const p=u.origin+u.pathname;return(p===SCOPE||p===SCOPE+'index.html')?PAGE_KEY:p}

self.addEventListener('install',e=>{
  e.waitUntil((async()=>{
    const s=await caches.open(SHELL);
    await Promise.all(['index.html'].concat(ICONS).map(async f=>{
      try{const r=await fetch(SCOPE+f,{cache:'no-cache'});if(r.ok)await s.put(f==='index.html'?PAGE_KEY:SCOPE+f,r)}catch(err){}
    }));
    const l=await caches.open(LIB);
    await Promise.all(LIB_URLS.map(async u=>{
      try{const r=await fetch(u,{mode:u.endsWith('.js')&&u.includes('gstatic')?'cors':'no-cors'});if(r.ok||r.type==='opaque')await l.put(u,r)}catch(err){}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate',e=>{
  e.waitUntil((async()=>{
    const keep=[SHELL,LIB,TILE];
    for(const k of await caches.keys())if(k.startsWith('cv-')&&!keep.includes(k))await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET')return;
  const u=new URL(req.url);
  if(req.mode==='navigate'&&req.url.startsWith(SCOPE)){e.respondWith(netFirst(req,pageKey(u)));return}
  if(u.origin===location.origin){
    if(!req.url.startsWith(SCOPE))return; /* 同網域的選點頁不歸這裡管 */
    if(u.pathname.endsWith('/sw.js'))return;
    if(/\.ctl$/i.test(u.pathname)||/\/ctl\/list\.txt$/.test(u.pathname)){e.respondWith(netFirst(req,u.origin+u.pathname));return}
    if(ICONS.some(f=>u.pathname.endsWith('/'+f))){e.respondWith(cacheFirst(req,SHELL));return}
    return;
  }
  if(u.hostname==='wmts.nlsc.gov.tw'){e.respondWith(tile(req));return}
  if(LIB_HOSTS.includes(u.hostname)||(u.hostname==='www.gstatic.com'&&u.pathname.startsWith('/firebasejs/'))){e.respondWith(cacheFirst(req,LIB));return}
});

/* 先網路：成功就更新快取；失敗或超過 NET_WAIT 才回快取（之後網路回來仍會更新快取） */
async function netFirst(req,key){
  const c=await caches.open(SHELL);
  const net=fetch(req).then(r=>{if(r.ok)c.put(key,r.clone());return r});
  let timer;
  const wait=new Promise(res=>{timer=setTimeout(res,NET_WAIT)});
  try{
    const r=await Promise.race([net,wait.then(()=>null)]);
    clearTimeout(timer);
    if(r)return r;
    const hit=await c.match(key);
    if(hit){net.catch(()=>{});return hit}
    return await net;
  }catch(err){
    clearTimeout(timer);
    const hit=await c.match(key);
    if(hit)return hit;
    throw err;
  }
}

async function cacheFirst(req,name){
  const c=await caches.open(name);
  const hit=await c.match(req,{ignoreVary:true});
  if(hit)return hit;
  const r=await fetch(req);
  if(r.ok||r.type==='opaque')c.put(req,r.clone());
  return r;
}

/* 底圖：先快取；沒有就抓網路。先試 CORS（配額小），對方不支援就改用原本方式（opaque） */
let corsOk=null; /* null＝還不知道 */
async function tile(req){
  const c=await caches.open(TILE);
  const hit=await c.match(req.url);
  if(hit)return hit;
  let r=null;
  if(corsOk!==false){
    try{r=await fetch(req.url,{mode:'cors',credentials:'omit'});corsOk=true}catch(err){r=null}
  }
  if(!r){r=await fetch(req);if(corsOk===null)corsOk=false} /* 原本方式抓得到、CORS 抓不到＝對方沒開 CORS */
  if(r.ok||r.type==='opaque'){
    await c.put(req.url,r.clone());
    trim(c,r.type==='opaque'?TILE_MAX_OPAQUE:TILE_MAX_CORS);
  }
  return r;
}
let trimming=false,lastTrim=0;
async function trim(c,max){
  if(trimming||Date.now()-lastTrim<10000)return;
  trimming=true;lastTrim=Date.now();
  try{const ks=await c.keys();for(let i=0;i<ks.length-max;i++)await c.delete(ks[i])}catch(err){}
  trimming=false;
}
