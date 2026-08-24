(()=>{
const ROUTE_KEY='jalan-lite-routes-v1';
const shell=document.createElement('section');
const launcher=document.createElement('button');
const SG_CENTER={lng:103.8198,lat:1.3521};
const MAPBOX_JS='https://api.mapbox.com/mapbox-gl-js/v3.26.0/mapbox-gl.js';
const MAPBOX_CSS='https://api.mapbox.com/mapbox-gl-js/v3.26.0/mapbox-gl.css';
let route=loadRoute();
let draft=makeDraft(route);
let pickerField=null;
let pendingPoint=null;
let pickerController=null;
let mapAssetsPromise=null;
let mapTokenPromise=null;

shell.className='route-shell';
launcher.className='route-launcher';
launcher.type='button';
launcher.textContent='Commute';
launcher.hidden=true;

function esc(value=''){
  return String(value).replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
}
function makeDraft(value){return{origin:value?.origin||'',destination:value?.destination||'',originPoint:value?.originPoint||null,destinationPoint:value?.destinationPoint||null}}
function loadRoute(){try{const value=JSON.parse(localStorage.getItem(ROUTE_KEY));return value&&typeof value.origin==='string'&&typeof value.destination==='string'?value:null}catch{return null}}
function saveRoute(next){route=next;draft=makeDraft(next);localStorage.setItem(ROUTE_KEY,JSON.stringify(next))}
function timeout(promise,ms,message){return Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error(message)),ms))])}

function loadStyle(href,id){
  const previous=document.getElementById(id);
  if(previous?.dataset.ready==='1')return Promise.resolve();
  if(previous)previous.remove();
  return new Promise((resolve,reject)=>{
    const link=document.createElement('link');
    link.id=id;link.rel='stylesheet';link.href=href;
    link.onload=()=>{link.dataset.ready='1';resolve()};
    link.onerror=()=>{link.remove();reject(new Error('Unable to load map styles.'))};
    document.head.appendChild(link);
  });
}
function loadScript(src,id){
  if(window.mapboxgl)return Promise.resolve();
  const previous=document.getElementById(id);
  if(previous)previous.remove();
  return new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    script.id=id;script.src=src;script.async=true;
    script.onload=()=>window.mapboxgl?resolve():reject(new Error('Mapbox did not initialise.'));
    script.onerror=()=>{script.remove();reject(new Error('Unable to load Mapbox.'))};
    document.head.appendChild(script);
  });
}
function ensureMapbox(){
  if(window.mapboxgl)return Promise.resolve(window.mapboxgl);
  if(!mapAssetsPromise){
    mapAssetsPromise=timeout(Promise.all([loadStyle(MAPBOX_CSS,'mapbox-gl-css'),loadScript(MAPBOX_JS,'mapbox-gl-js')]).then(()=>window.mapboxgl),6000,'Map assets took too long to load.')
      .catch(error=>{mapAssetsPromise=null;throw error});
  }
  return mapAssetsPromise;
}
function getMapToken(){
  if(!mapTokenPromise){
    mapTokenPromise=timeout(fetch('/api/map-config').then(async response=>{const data=await response.json();if(!response.ok||!data.token)throw new Error(data.error||'Map is not configured.');return data.token}),4000,'Map configuration timed out.')
      .catch(error=>{mapTokenPromise=null;throw error});
  }
  return mapTokenPromise;
}
function cleanSingaporeLabel(value){return String(value||'').replace(/,\s*Singapore(?:\s+\d{6})?$/i,'').replace(/\s+/g,' ').trim()}
async function reverseGeocode(lng,lat){
  const token=await getMapToken();
  const url=new URL('https://api.mapbox.com/search/geocode/v6/reverse');
  url.searchParams.set('longitude',String(lng));url.searchParams.set('latitude',String(lat));url.searchParams.set('country','sg');url.searchParams.set('language','en');url.searchParams.set('limit','1');url.searchParams.set('access_token',token);
  const response=await timeout(fetch(url),4000,'Location lookup timed out.');
  if(!response.ok)throw new Error('Unable to identify this area.');
  const data=await response.json();const feature=data.features?.[0];const props=feature?.properties||{};
  return cleanSingaporeLabel(props.full_address||[props.name_preferred||props.name,props.place_formatted].filter(Boolean).join(', ')||feature?.place_name||'Selected area')||'Selected area';
}
async function forwardGeocode(query){
  const token=await getMapToken();
  const url=new URL('https://api.mapbox.com/search/geocode/v6/forward');
  url.searchParams.set('q',query);url.searchParams.set('country','sg');url.searchParams.set('language','en');url.searchParams.set('limit','1');url.searchParams.set('proximity',`${SG_CENTER.lng},${SG_CENTER.lat}`);url.searchParams.set('access_token',token);
  const response=await timeout(fetch(url),4000,'Address lookup timed out.');
  if(!response.ok)throw new Error('Unable to resolve this location.');
  const data=await response.json();const feature=data.features?.[0];if(!feature)return null;
  const coords=feature.geometry?.coordinates;if(!Array.isArray(coords)||coords.length<2)return null;
  const props=feature.properties||{};
  const label=cleanSingaporeLabel(props.full_address||[props.name_preferred||props.name,props.place_formatted].filter(Boolean).join(', ')||feature.place_name||query)||query;
  return{label,lng:Number(coords[0]),lat:Number(coords[1])};
}

function networkBadges(){return`<div class="sg-network" aria-label="Singapore MRT line colours"><span class="sg-line ns">NS</span><span class="sg-line ew">EW</span><span class="sg-line ne">NE</span><span class="sg-line cc">CC</span><span class="sg-line dt">DT</span><span class="sg-line te">TE</span></div>`}
function brand(){return`<div class="route-brand"><div class="route-wordmark">jalan</div><div class="route-country">SG</div></div>`}
function showShell(){shell.hidden=false;launcher.hidden=true;render()}
function showLegacyBus(){destroyPicker();shell.hidden=true;launcher.hidden=false}
function locationValue(field){if(draft[field])return esc(draft[field]);return field==='origin'?'Choose where you start':'Choose where you’re going'}

function setupView(){
  const canSave=draft.origin&&draft.destination;
  return`<div class="route-panel">${brand()}<div class="route-setup-copy"><div class="route-kicker">Bus + MRT · Singapore</div><h1>Pick your regular trip.</h1><p>Choose an area on the map, use GPS, or type it manually.</p>${networkBadges()}</div><div class="route-form"><div class="route-input-card"><button class="route-location-row" type="button" data-route-pick="origin"><span class="route-node origin" aria-hidden="true"></span><span class="route-field-copy"><span class="route-field-label">From</span><span class="route-location-value${draft.origin?'':' placeholder'}">${locationValue('origin')}</span></span><span class="route-map-action" aria-hidden="true">Choose</span></button><button class="route-location-row" type="button" data-route-pick="destination"><span class="route-node destination" aria-hidden="true"></span><span class="route-field-copy"><span class="route-field-label">To</span><span class="route-location-value${draft.destination?'':' placeholder'}">${locationValue('destination')}</span></span><span class="route-map-action" aria-hidden="true">Choose</span></button></div><div class="route-form-hint">Manual entries are geocoded when possible so they can still be used for routing.</div><button class="route-primary" type="button" data-route-action="save-route" ${canSave?'':'disabled'}>${route?'Update commute':'Save commute'}</button></div><button class="route-link" type="button" data-route-action="bus">I only need bus arrivals</button></div>`;
}
function pickerView(){
  const fieldLabel=pickerField==='origin'?'starting point':'destination';const current=draft[pickerField]||'';
  return`<div class="route-picker"><div class="picker-topbar"><button class="picker-back" type="button" data-route-action="cancel-picker" aria-label="Back">‹</button><div><div class="route-kicker">Choose ${fieldLabel}</div><div class="picker-title">Map or type a place</div></div></div><div class="route-picker-map-wrap"><div id="route-picker-map" class="route-picker-map" aria-label="Map of Singapore"></div><div class="picker-crosshair" aria-hidden="true"><span></span></div><div id="picker-loading" class="picker-loading">Loading Singapore map…</div><button class="picker-locate" type="button" data-route-action="my-location">◎ My location</button></div><div class="picker-sheet"><div class="route-card-label">${pickerField==='origin'?'From':'To'}</div><div id="picker-label" class="picker-place">${esc(pendingPoint?.label||'Move the map to choose an area')}</div><div id="picker-coords" class="picker-coords">${pendingPoint?`${pendingPoint.lat.toFixed(5)}, ${pendingPoint.lng.toFixed(5)}`:'Singapore'}</div><button class="route-primary" type="button" data-route-action="confirm-picker" ${pendingPoint?'':'disabled'}>Use map selection</button><div class="picker-divider"><span>or type a place</span></div><div class="picker-manual-row"><input id="picker-manual-input" class="picker-manual-input" value="${esc(current)}" placeholder="Tampines MRT, Blk 123, Raffles Place…" autocomplete="street-address" enterkeyhint="done"><button class="picker-manual-button" type="button" data-route-action="use-manual" ${current?'':'disabled'}>Use</button></div><div id="picker-manual-hint" class="picker-manual-hint">We’ll try to resolve the text to exact Singapore coordinates. If lookup fails, the label is still saved.</div></div></div>`;
}
function journeyCard(){
  const originResolved=route.originPoint?' · mapped':'';const destinationResolved=route.destinationPoint?' · mapped':'';
  return`<section class="journey-card" aria-label="Saved commute"><div class="journey-row"><span class="route-node origin" aria-hidden="true"></span><div><div class="journey-label">From${originResolved}</div><div class="journey-place">${esc(route.origin)}</div></div></div><div class="journey-row"><span class="route-node destination" aria-hidden="true"></span><div><div class="journey-label">To${destinationResolved}</div><div class="journey-place">${esc(route.destination)}</div></div></div></section>`;
}
function dashboardView(){return`<div class="route-panel">${brand()}<div class="route-header"><div><div class="route-kicker">Saved commute</div><h1>Ready when you are.</h1></div><button class="route-link compact" type="button" data-route-action="edit">Edit</button></div>${journeyCard()}<section class="best-route-card" aria-labelledby="best-route-title"><div class="route-card-top"><div><div class="route-card-label">Best route</div><h2 id="best-route-title">Waiting for routing data</h2></div><div class="mode-pills"><span>BUS</span><span>MRT</span></div></div><p>Next, this card will show the fastest public-transport sequence, walking legs, transfers and total journey time.</p></section><section class="timing-card"><div class="timing-heading"><div><div class="route-card-label">MRT timings</div><h2>Live feed coming next</h2></div><span class="live-state">Not live</span></div>${networkBadges()}<p>Train estimates stay hidden until the LTA GTFS-Realtime feed is parsed and matched to this commute.</p></section><div class="route-actions"><button class="route-primary" type="button" data-route-action="bus">Open bus arrivals</button><button class="route-link" type="button" data-route-action="clear">Remove saved commute</button></div></div>`}

function destroyPicker(){if(pickerController){pickerController.destroy();pickerController=null}}
function updatePickerText(point){const label=document.getElementById('picker-label');const coords=document.getElementById('picker-coords');const confirm=shell.querySelector('[data-route-action="confirm-picker"]');if(label)label.textContent=point?.label||'Move the map to choose an area';if(coords)coords.textContent=point?`${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`:'Singapore';if(confirm)confirm.disabled=!point}
function setMapFailure(message){
  const loading=document.getElementById('picker-loading');if(!loading)return;
  loading.hidden=false;loading.innerHTML=`<div><strong>Map unavailable</strong><span>${esc(message||'Type the location below instead.')}</span><button type="button" class="route-link picker-retry">Retry map</button></div>`;
  loading.querySelector('.picker-retry')?.addEventListener('click',()=>{loading.innerHTML='Retrying map…';mountPicker()});
}
async function mountPicker(){
  const container=document.getElementById('route-picker-map');if(!container||!pickerField)return;
  const loading=document.getElementById('picker-loading');const existing=draft[`${pickerField}Point`];const center=existing||SG_CENTER;let map=null;
  try{
    const[mapboxgl,token]=await Promise.all([ensureMapbox(),getMapToken()]);
    if(!document.getElementById('route-picker-map')||!pickerField)return;
    mapboxgl.accessToken=token;
    map=new mapboxgl.Map({container,style:'mapbox://styles/mapbox/light-v11',center:[center.lng,center.lat],zoom:existing?16:13.2,minZoom:10.5,maxZoom:18.2,maxBounds:[[103.55,1.15],[104.10,1.49]],maxPitch:0,pitch:0,bearing:0,dragRotate:false,touchPitch:false,attributionControl:true,logoPosition:'bottom-left'});
    map.touchZoomRotate.disableRotation();map.addControl(new mapboxgl.NavigationControl({showCompass:false}),'top-right');
    await timeout(new Promise((resolve,reject)=>{map.once('load',resolve);map.once('error',event=>reject(event?.error||new Error('Unable to load map.')))}),6500,'Map loading timed out.');
    let requestId=0;let destroyed=false;
    const emitSelection=async()=>{const id=++requestId;const centerPoint=map.getCenter();let label='Selected area';try{label=await reverseGeocode(centerPoint.lng,centerPoint.lat)}catch{}if(destroyed||id!==requestId)return;pendingPoint={lng:centerPoint.lng,lat:centerPoint.lat,label};updatePickerText(pendingPoint)};
    map.on('moveend',emitSelection);emitSelection();
    pickerController={setCenter({lng,lat,zoom=16}){map.easeTo({center:[lng,lat],zoom,duration:300,easing:t=>1-Math.pow(1-t,3)})},destroy(){destroyed=true;requestId+=1;map.remove()}};
    if(loading)loading.hidden=true;
  }catch(error){try{map?.remove()}catch{}setMapFailure(error.message||'Type the location below instead.')}
}
function openPicker(field){destroyPicker();pickerField=field;pendingPoint=draft[`${field}Point`]?{...draft[`${field}Point`],label:draft[field]}:null;render()}
function closePicker(){destroyPicker();pickerField=null;pendingPoint=null;render()}
function confirmPicker(){if(!pickerField||!pendingPoint)return;draft[pickerField]=pendingPoint.label;draft[`${pickerField}Point`]={lat:pendingPoint.lat,lng:pendingPoint.lng};closePicker()}
async function useManual(){
  if(!pickerField)return;
  const input=shell.querySelector('#picker-manual-input');const button=shell.querySelector('[data-route-action="use-manual"]');const hint=shell.querySelector('#picker-manual-hint');const raw=String(input?.value||'').trim();if(!raw)return;
  if(button){button.disabled=true;button.textContent='Finding…'}if(input)input.disabled=true;if(hint)hint.textContent='Finding the closest Singapore match…';
  let result=null;try{result=await forwardGeocode(raw)}catch{}
  if(!pickerField)return;
  if(result){draft[pickerField]=result.label;draft[`${pickerField}Point`]={lat:result.lat,lng:result.lng}}else{draft[pickerField]=raw;draft[`${pickerField}Point`]=null}
  closePicker();
}
function useMyLocation(){
  if(!navigator.geolocation)return setMapFailure('Location is not supported here. Type it below instead.');
  const button=shell.querySelector('[data-route-action="my-location"]');if(button){button.disabled=true;button.textContent='Locating…'}
  navigator.geolocation.getCurrentPosition(async pos=>{const point={lng:pos.coords.longitude,lat:pos.coords.latitude};if(pickerController){pickerController.setCenter({...point,zoom:16})}else{let label='My location';try{label=await reverseGeocode(point.lng,point.lat)}catch{}pendingPoint={...point,label};updatePickerText(pendingPoint)}if(button){button.disabled=false;button.textContent='◎ My location'}},()=>{if(button){button.disabled=false;button.textContent='Location unavailable'}},{enableHighAccuracy:true,timeout:7000,maximumAge:60000});
}

function render(){destroyPicker();if(pickerField){shell.innerHTML=pickerView();bindActions();requestAnimationFrame(mountPicker);return}shell.innerHTML=route?dashboardView():setupView();bindActions()}
function bindActions(){
  shell.querySelectorAll('[data-route-pick]').forEach(button=>button.addEventListener('click',()=>openPicker(button.dataset.routePick)));
  const manual=shell.querySelector('#picker-manual-input');const manualButton=shell.querySelector('[data-route-action="use-manual"]');
  if(manual){const update=()=>{if(manualButton)manualButton.disabled=!manual.value.trim()};manual.addEventListener('input',update);manual.addEventListener('keydown',event=>{if(event.key==='Enter'&&manual.value.trim()){event.preventDefault();useManual()}})}
  shell.querySelectorAll('[data-route-action]').forEach(button=>button.addEventListener('click',()=>{const action=button.dataset.routeAction;if(action==='bus')showLegacyBus();else if(action==='edit'){draft=makeDraft(route);route=null;render()}else if(action==='save-route'){if(!draft.origin||!draft.destination)return;saveRoute({id:'route-1',origin:draft.origin,destination:draft.destination,originPoint:draft.originPoint,destinationPoint:draft.destinationPoint,updatedAt:new Date().toISOString()});render()}else if(action==='clear'){localStorage.removeItem(ROUTE_KEY);route=null;draft=makeDraft(null);render()}else if(action==='cancel-picker')closePicker();else if(action==='confirm-picker')confirmPicker();else if(action==='use-manual')useManual();else if(action==='my-location')useMyLocation()}));
}
launcher.addEventListener('click',showShell);document.body.append(shell,launcher);render();
})();