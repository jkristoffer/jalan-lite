(()=>{
const STORAGE_KEY='jalan-lite-presets-v1';
const urgent='#A33A24';
const runtime=window.JalanRuntime;
const routineStorage=window.JalanRoutines;
const busRequests=runtime.createRequestCoordinator();
const starter={id:'morning-commute',name:'Morning Commute',stopCode:'54009',stopName:'Blk 210 Ang Mo Kio Ave 3',services:['166','76','265'],days:[1,2,3,4,5],startTime:'07:15',endTime:'09:00'};
const state={presets:loadPresets(),selectedId:null,view:'list',focusService:'',arrivals:[],updatedAt:null,loading:false,error:'',draft:null,draftService:'',location:null,nearby:[],selectedStop:null,discoverLoading:false,discoverError:'',mapLoading:false,mapController:null,confirm:null,stopAbort:null};
let mapAssetsPromise=null;
let mapGeneration=0;
state.selectedId=(state.presets.find(isActive)||state.presets[0]||{}).id||null;
state.view=state.presets.find(isActive)?'main':'list';

function legacyLoadPresets(){try{return JSON.parse(localStorage.getItem(STORAGE_KEY))||[starter]}catch{return[starter]}}
function loadPresets(){
  if(!routineStorage)return legacyLoadPresets();
  const loaded=routineStorage.load();
  return loaded.routines.filter(routine=>routine.type==='bus').map(routineStorage.busPresetFromRoutine).filter(Boolean);
}
function savePresets(){
  localStorage.setItem(STORAGE_KEY,JSON.stringify(state.presets));
  if(!routineStorage)return;
  const loaded=routineStorage.load();
  const busRoutines=state.presets.map(routineStorage.routineFromBusPreset).filter(Boolean);
  routineStorage.save([...loaded.routines.filter(routine=>routine.type!=='bus'),...busRoutines]);
}
function selected(){return state.presets.find(p=>p.id===state.selectedId)||state.presets[0]}
function mins(t){const[h,m]=t.split(':').map(Number);return h*60+m}
function isActive(p){const n=new Date(),d=n.getDay(),m=n.getHours()*60+n.getMinutes();return p.days.includes(d)&&m>=mins(p.startTime)&&m<=mins(p.endTime)}
function esc(v=''){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function daysLabel(days){if([1,2,3,4,5].every(d=>days.includes(d))&&days.length===5)return'Mon–Fri';const labels=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];return days.map(d=>labels[d]).join(' · ')}
function arrival(v){return v===null||v===undefined?'—':v===0?'Arr':String(v)}
function updated(){return state.updatedAt?'Updated '+new Date(state.updatedAt).toLocaleTimeString('en-SG',{hour12:false}):'Not updated yet'}
function header(label,right='',back=''){return`<div class="header-row"><button class="eyebrow header-back" data-action="${back?'back':''}" ${back?'':'disabled'}>${back?'‹ ':''}${esc(label)}</button>${right}</div>`}

function loadStyle(href,id){
  if(document.getElementById(id))return Promise.resolve();
  return new Promise((resolve,reject)=>{const link=document.createElement('link');link.id=id;link.rel='stylesheet';link.href=href;link.onload=resolve;link.onerror=()=>reject(new Error('Unable to load map styles.'));document.head.appendChild(link)});
}
function loadScript(src,id){
  if(document.getElementById(id))return Promise.resolve();
  return new Promise((resolve,reject)=>{const script=document.createElement('script');script.id=id;script.src=src;script.onload=resolve;script.onerror=()=>reject(new Error('Unable to load map library.'));document.head.appendChild(script)});
}
function ensureMapAssets(){
  if(window.JalanMap)return Promise.resolve(window.JalanMap);
  if(!mapAssetsPromise){
    mapAssetsPromise=Promise.all([
      loadStyle('https://api.mapbox.com/mapbox-gl-js/v3.26.0/mapbox-gl.css','mapbox-gl-css'),
      loadStyle('/mapbox-overrides.css','mapbox-overrides-css'),
      loadStyle('/map-polish.css','map-polish-css'),
      window.mapboxgl?Promise.resolve():loadScript('https://api.mapbox.com/mapbox-gl-js/v3.26.0/mapbox-gl.js','mapbox-gl-js')
    ]).then(()=>loadScript('/mapbox-adapter.js','jalan-map-adapter')).then(()=>{
      if(!window.JalanMap)throw new Error('Map adapter failed to initialize.');
      return window.JalanMap;
    }).catch(error=>{mapAssetsPromise=null;throw error});
  }
  return mapAssetsPromise;
}
function cancelStopRequest(){if(state.stopAbort){state.stopAbort.abort();state.stopAbort=null}}
function destroyMap(){
  mapGeneration+=1;
  if(state.mapController){state.mapController.destroy();state.mapController=null}
}

function render(){
  destroyMap();
  const app=document.getElementById('app');
  app.className='screen'+(state.view==='edit'?' edit-screen':state.view==='discover'?' discover-screen':'');
  if(state.view==='list')app.innerHTML=listView();
  else if(state.view==='main')app.innerHTML=mainView();
  else if(state.view==='focus')app.innerHTML=focusView();
  else if(state.view==='discover')app.innerHTML=discoverView();
  else if(state.view==='confirm')app.innerHTML=confirmView();
  else app.innerHTML=editView();
  bind(app);
  if(state.view==='discover'&&state.location&&state.nearby.length)mountMap();
}

function listView(){return`${header('Commutes',state.presets.length?`<button class="text-button" data-action="edit-first">Edit</button>`:'')}<div class="list-lines">${state.presets.map(p=>`<button class="preset-row ${isActive(p)?'':'muted-row'}" data-action="open" data-id="${p.id}"><div class="row-between"><div class="preset-title">${esc(p.name)}</div><div class="status-label" style="color:${isActive(p)?urgent:'#9A968F'}">${isActive(p)?'Active now':'Off'}</div></div><div class="stop-line">${esc(p.stopCode)} · ${esc(p.stopName)}</div><div class="row-between row-bottom"><div class="chips">${p.services.map(s=>`<span class="chip">${esc(s)}</span>`).join('')}</div><div class="window mono">${esc(daysLabel(p.days))} · ${esc(p.startTime)}–${esc(p.endTime)}</div></div></button>`).join('')}</div><div class="grow"></div><div class="bottom-action setup-actions"><button class="primary-button" data-action="locate">Set up from my location</button><button class="secondary-link" data-action="new">Enter details manually</button><div class="setup-hint">Location is used only to find nearby bus stops.</div></div>`}
function mainView(){const p=selected();if(!p)return emptyView();return`${header(p.name,`<button class="text-button" data-action="edit">Edit</button>`,'list')}<div class="stop-name">${esc(p.stopName)}</div><div class="stop-code mono">${esc(p.stopCode)}</div><div class="arrival-list">${p.services.map(no=>{const d=state.arrivals.find(x=>x.serviceNo===no)||{arrivals:[null,null,null],load:''};const first=d.arrivals[0];return`<button class="arrival-row" data-action="focus" data-service="${esc(no)}"><div class="service-block"><div class="service-no">${esc(no)}</div><div class="load">${esc(d.load||'—')}</div></div><div class="arrival-block"><div class="first-wrap"><span class="first-arrival" style="color:${first!==null&&first<=3?urgent:'#16181A'}">${arrival(first)}</span>${first!==null&&first>0?'<span class="unit">min</span>':''}</div><div class="rest-arrivals">${d.arrivals.slice(1).map(arrival).join('  ·  ')} min</div></div></button>`}).join('')}</div><div class="grow"></div><div class="bottom-action stacked">${state.error?`<div class="error-text">${esc(state.error)}</div>`:''}<div class="updated mono">${state.loading?'Updating…':esc(updated())}</div><button class="primary-button" data-action="refresh" ${state.loading?'disabled':''}>${state.loading?'Refreshing…':'Refresh'}</button></div>`}
function focusView(){const p=selected();const d=state.arrivals.find(x=>x.serviceNo===state.focusService)||state.arrivals[0]||{serviceNo:state.focusService,arrivals:[null,null,null]};const first=d.arrivals[0];return`${header(p.name,`<button class="text-button" data-action="edit">Edit</button>`,'main')}<div class="focus-center"><div class="focus-first-wrap"><span class="focus-first" style="color:${first!==null&&first<=3?urgent:'#16181A'}">${arrival(first)}</span>${first!==null&&first>0?'<span class="focus-unit">min</span>':''}</div><div class="focus-service">${esc(d.serviceNo||'—')}</div><div class="focus-route">${esc(p.stopName)}</div><div class="focus-rest">then ${d.arrivals.slice(1).map(arrival).join('  ·  ')} min</div></div><div class="bottom-action stacked focus-actions"><div class="chips focus-tabs">${p.services.map(no=>`<button class="focus-tab ${no===d.serviceNo?'selected':''}" data-action="pick-focus" data-service="${esc(no)}">${esc(no)}</button>`).join('')}</div><div class="updated mono">${esc(updated())}</div></div>`}
function pickPanelView(){const stop=state.selectedStop;if(!stop)return`<div class="location-actions"><button class="outline-button" data-action="locate">Try location again</button></div>`;const services=state.arrivals||[];return`<div class="pick-panel"><div class="pick-top"><div><div class="pick-name">${esc(stop.name)}</div><div class="pick-meta mono">${esc(stop.stopCode)} · ${esc(stop.roadName)}</div></div><div class="pick-distance">${stop.distance} m away</div></div><div class="service-prompt">Choose your bus</div><div class="service-grid">${state.loading?'<span class="updated">Loading buses…</span>':services.length?services.map(s=>`<button class="service-choice ${s.arrivals[0]!==null?'has-arrival':''}" data-action="choose-bus" data-service="${esc(s.serviceNo)}">${esc(s.serviceNo)}<span class="service-time">${s.arrivals[0]===null?'—':arrival(s.arrivals[0])+(s.arrivals[0]>0?' min':'')}</span></button>`).join(''):'<span class="updated">No live services returned for this stop.</span>'}</div></div>`}
function discoverView(){const loadingText=state.discoverLoading?'Finding nearby bus stops…':'Loading map…';return`${header('Choose stop',`<button class="text-button" data-action="manual-from-map">Manual</button>`,'list')}<div class="discover-copy"><div class="discover-title">Which side are you on?</div><div class="discover-sub">We picked the nearest stop. Tap another pin if you are across the road.</div></div><div class="map-wrap"><div id="map" class="map"></div><div id="map-loading" class="map-loading" style="display:${state.discoverLoading||state.mapLoading?'flex':'none'}">${loadingText}</div></div><div id="discover-error-host">${state.discoverError?`<div class="discover-error">${esc(state.discoverError)}</div>`:''}</div><div id="pick-panel-host">${pickPanelView()}</div>`}
function confirmView(){const c=state.confirm;if(!c)return listView();return`${header('New commute','', 'discover')}<div class="eyebrow" style="margin-top:22px">Ready to save</div><div class="confirm-card"><div class="confirm-service">${esc(c.service)}</div><div class="confirm-stop">${esc(c.stop.name)}</div><div class="confirm-meta mono">${esc(c.stop.stopCode)} · ${esc(c.stop.roadName)}</div></div><div class="schedule-card"><div class="schedule-label">Suggested schedule</div><div class="schedule-main">Weekdays · ${esc(c.startTime)}–${esc(c.endTime)}</div><div class="schedule-sub">Based on the time you are setting this up. You can change it anytime.</div></div><div class="grow"></div><div class="bottom-action setup-actions"><button class="primary-button" data-action="save-confirm">Save commute</button><button class="secondary-link" data-action="adjust-confirm">Adjust schedule</button></div>`}
function field(label,body){return`<label class="field"><span class="field-label">${label}</span>${body}</label>`}
function editView(){const p=state.draft||starter;const dayDefs=[[1,'M'],[2,'T'],[3,'W'],[4,'T'],[5,'F'],[6,'S'],[0,'S']];const valid=/^\d{5}$/.test(p.stopCode)&&p.services.length>0&&p.days.length>0;return`${header('Edit preset',`<button class="text-button" data-action="cancel">Cancel</button>`)}<div class="form-stack">${field('Name',`<input class="line-input large" data-field="name" value="${esc(p.name)}">`)}${field('Active days',`<div class="days">${dayDefs.map(([n,l])=>`<button class="day ${p.days.includes(n)?'selected':''}" data-action="toggle-day" data-day="${n}">${l}</button>`).join('')}</div>`)}<div class="time-grid">${field('Start',`<input class="line-input time" type="time" data-field="startTime" value="${esc(p.startTime)}">`)}${field('End',`<input class="line-input time" type="time" data-field="endTime" value="${esc(p.endTime)}">`)}</div>${field('Bus stop code',`<input class="line-input code mono" inputmode="numeric" maxlength="5" data-field="stopCode" value="${esc(p.stopCode)}"><input class="sub-input" placeholder="Stop label (optional)" data-field="stopName" value="${esc(p.stopName)}">`)}${field('Bus services',`<div class="chips service-editor">${p.services.map(no=>`<button class="service-pill" data-action="remove-service" data-service="${esc(no)}">${esc(no)}<span>×</span></button>`).join('')}<input class="add-service" data-field="draftService" placeholder="Add" value="${esc(state.draftService)}"></div>`)}</div><div class="grow min-grow"></div><div class="bottom-action sticky-save"><button class="primary-button" data-action="save" ${valid?'':'disabled'}>Save</button></div>`}
function emptyView(){return`${header('Commutes')}<div class="empty"><div>No commute saved yet.</div><button class="primary-button" data-action="locate">Set up from my location</button><button class="secondary-link" data-action="new">Enter details manually</button></div>`}

function updateDiscoverUI(){
  if(state.view!=='discover')return;
  const errorHost=document.getElementById('discover-error-host');
  const panelHost=document.getElementById('pick-panel-host');
  if(errorHost)errorHost.innerHTML=state.discoverError?`<div class="discover-error">${esc(state.discoverError)}</div>`:'';
  if(panelHost){panelHost.innerHTML=pickPanelView();bind(panelHost)}
}
function updateMapLoading(){const el=document.getElementById('map-loading');if(!el)return;el.style.display=state.discoverLoading||state.mapLoading?'flex':'none';el.textContent=state.discoverLoading?'Finding nearby bus stops…':'Loading map…'}
async function mountMap(){
  const generation=mapGeneration;
  const container=document.getElementById('map');
  if(!container||!state.location||!state.nearby.length)return;
  state.mapLoading=true;updateMapLoading();
  try{
    const api=await ensureMapAssets();
    if(generation!==mapGeneration||state.view!=='discover'||!document.getElementById('map'))return;
    const controller=await api.create({container:document.getElementById('map'),center:state.location,stops:state.nearby,selectedStopCode:state.selectedStop?.stopCode,onSelect:selectStop});
    if(generation!==mapGeneration||state.view!=='discover'){controller.destroy();return}
    state.mapController=controller;
  }catch(error){
    state.discoverError=error.message||'Unable to load map.';
    updateDiscoverUI();
  }finally{
    if(generation===mapGeneration&&state.view==='discover'){state.mapLoading=false;updateMapLoading()}
  }
}

async function refresh(stopOverride){const p=stopOverride||selected();if(!p)return;const request=busRequests.start();state.loading=true;state.error='';render();try{const services=p.services||[];const q=new URLSearchParams({stopCode:p.stopCode});if(services.length)q.set('services',services.join(','));const r=await fetch('/api/bus-arrivals?'+q,{signal:request.controller.signal});const data=await runtime.readJson(r,'Bus arrivals returned an invalid response.');if(!busRequests.isCurrent(request))return;if(!r.ok||!runtime.isBusArrivalsPayload(data))throw new Error(data.error||'Unable to load bus arrivals.');state.arrivals=data.services;state.updatedAt=data.updatedAt}catch(e){if(e.name==='AbortError'||!busRequests.isCurrent(request))return;state.error=e.message||'Unable to load bus arrivals.'}finally{if(busRequests.isCurrent(request)){busRequests.finish(request);state.loading=false;render()}}}
function startEdit(p){busRequests.abort();state.loading=false;state.draft=JSON.parse(JSON.stringify(p||selected()||starter));state.draftService='';state.view='edit';render()}
function newPreset(){busRequests.abort();state.loading=false;state.draft={id:'commute-'+Date.now(),name:'New commute',stopCode:'',stopName:'',services:[],days:[1,2,3,4,5],startTime:'07:30',endTime:'09:00'};state.draftService='';state.view='edit';render()}
function addService(){const v=state.draftService.trim();if(v&&!state.draft.services.includes(v))state.draft.services.push(v);state.draftService='';render()}
function saveDraft(){const p=state.draft;p.name=p.name.trim()||'Commute';p.stopCode=p.stopCode.trim();p.stopName=p.stopName.trim()||('Bus stop '+p.stopCode);p.services=p.services.map(s=>s.trim()).filter(Boolean);p.days=[...p.days].sort();const i=state.presets.findIndex(x=>x.id===p.id);if(i>=0)state.presets[i]=p;else state.presets.push(p);savePresets();state.selectedId=p.id;state.view='main';state.arrivals=[];render();refresh()}
function roundTime(date,deltaMinutes){const d=new Date(date.getTime()+deltaMinutes*60000);d.setMinutes(Math.round(d.getMinutes()/15)*15,0,0);return`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`}
function daypartName(){const h=new Date().getHours();return h<12?'Morning commute':h<17?'Afternoon commute':'Evening commute'}
function makeConfirm(service){cancelStopRequest();const now=new Date();state.confirm={service,stop:state.selectedStop,name:daypartName(),startTime:roundTime(now,-30),endTime:roundTime(now,60)};state.view='confirm';render()}
function confirmToPreset(){const c=state.confirm;return{id:'commute-'+Date.now(),name:c.name,stopCode:c.stop.stopCode,stopName:c.stop.name,services:[c.service],days:[1,2,3,4,5],startTime:c.startTime,endTime:c.endTime}}
function saveConfirm(){const p=confirmToPreset();state.presets.push(p);savePresets();state.selectedId=p.id;state.confirm=null;state.view='main';state.arrivals=[];render();refresh()}
function adjustConfirm(){state.draft=confirmToPreset();state.draftService='';state.view='edit';render()}
function locate(){
  cancelStopRequest();destroyMap();ensureMapAssets().catch(()=>{});
  if(!navigator.geolocation){state.discoverError='Location is not supported by this browser.';state.view='discover';render();return}
  state.discoverLoading=true;state.mapLoading=false;state.discoverError='';state.nearby=[];state.selectedStop=null;state.arrivals=[];state.view='discover';render();
  navigator.geolocation.getCurrentPosition(async pos=>{
    state.location={lat:pos.coords.latitude,lng:pos.coords.longitude,accuracy:pos.coords.accuracy};
    try{
      const q=new URLSearchParams({lat:state.location.lat.toFixed(4),lng:state.location.lng.toFixed(4)});
      const r=await fetch('/api/nearby-stops?'+q);
      const data=await runtime.readJson(r,'Nearby stops returned an invalid response.');
      if(!r.ok||!runtime.isNearbyStopsPayload(data))throw new Error(data.error||'Unable to find nearby stops.');
      state.nearby=data.nearby||[];state.selectedStop=state.nearby[0]||null;
      if(!state.selectedStop)throw new Error('No serviced bus stops found nearby.');
      state.discoverLoading=false;state.mapLoading=true;render();loadSelectedStop();
    }catch(e){state.discoverLoading=false;state.mapLoading=false;state.discoverError=e.message||'Unable to find nearby stops.';render()}
  },err=>{state.discoverLoading=false;state.discoverError=err.code===1?'Location permission was denied. You can enter the stop manually instead.':'Could not get your location. Try again or enter the stop manually.';render()},{enableHighAccuracy:true,timeout:10000,maximumAge:60000});
}
async function loadSelectedStop(){
  if(!state.selectedStop)return;
  cancelStopRequest();
  const controller=new AbortController();state.stopAbort=controller;
  const stopCode=state.selectedStop.stopCode;
  state.loading=true;state.arrivals=[];state.discoverError='';updateDiscoverUI();
  try{
    const q=new URLSearchParams({stopCode});
    const r=await fetch('/api/bus-arrivals?'+q,{signal:controller.signal});
    const data=await runtime.readJson(r,'Bus arrivals returned an invalid response.');
    if(!r.ok||!runtime.isBusArrivalsPayload(data))throw new Error(data.error||'Unable to load buses for this stop.');
    if(controller.signal.aborted||state.selectedStop?.stopCode!==stopCode)return;
    state.arrivals=data.services||[];state.updatedAt=data.updatedAt;
  }catch(e){if(e.name!=='AbortError'&&state.selectedStop?.stopCode===stopCode)state.discoverError=e.message||'Unable to load buses for this stop.'}
  finally{if(state.stopAbort===controller)state.stopAbort=null;if(!controller.signal.aborted&&state.selectedStop?.stopCode===stopCode){state.loading=false;updateDiscoverUI()}}
}
function selectStop(code){
  const stop=state.nearby.find(x=>x.stopCode===code);
  if(!stop||state.selectedStop?.stopCode===code)return;
  state.selectedStop=stop;state.arrivals=[];state.mapController?.selectStop(stop);loadSelectedStop();
}

function handleAction(el){
  const a=el.dataset.action;
  if(a==='open'){state.selectedId=el.dataset.id;state.focusService=selected().services[0]||'';state.view='main';state.arrivals=[];render();refresh()}
  else if(a==='new'||a==='manual-from-map')newPreset();
  else if(a==='locate')locate();
  else if(a==='edit')startEdit();
  else if(a==='edit-first'&&state.presets[0])startEdit(state.presets[0]);
  else if(a==='refresh')refresh();
  else if(a==='focus'){state.focusService=el.dataset.service;state.view='focus';render()}
  else if(a==='pick-focus'){state.focusService=el.dataset.service;render()}
  else if(a==='choose-bus')makeConfirm(el.dataset.service);
  else if(a==='save-confirm')saveConfirm();
  else if(a==='adjust-confirm')adjustConfirm();
  else if(a==='back'){cancelStopRequest();busRequests.abort();state.loading=false;state.view=state.view==='discover'?'list':state.view==='confirm'?'discover':state.view==='focus'?'main':'list';render()}
  else if(a==='cancel'){state.view=selected()?'main':'list';render()}
  else if(a==='toggle-day'){const d=Number(el.dataset.day);const i=state.draft.days.indexOf(d);i>=0?state.draft.days.splice(i,1):state.draft.days.push(d);render()}
  else if(a==='remove-service'){state.draft.services=state.draft.services.filter(s=>s!==el.dataset.service);render()}
  else if(a==='save')saveDraft();
}
function bind(root=document){
  root.querySelectorAll('[data-action]').forEach(el=>el.addEventListener('click',()=>handleAction(el)));
  root.querySelectorAll('[data-field]').forEach(el=>{const f=el.dataset.field;const evt=f==='draftService'?'keydown':'input';el.addEventListener(evt,e=>{if(f==='draftService'){state.draftService=e.target.value;if(e.key==='Enter'){e.preventDefault();addService()}}else if(f==='stopCode')state.draft.stopCode=e.target.value.replace(/\D/g,'').slice(0,5);else state.draft[f]=e.target.value})});
  const ds=root.querySelector('[data-field="draftService"]');if(ds)ds.addEventListener('blur',()=>{if(state.draftService.trim())addService()});
}

render();
if(state.view==='main')refresh();
})();
