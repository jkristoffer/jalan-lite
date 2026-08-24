(()=>{
const ROUTE_KEY='jalan-lite-routes-v1';
const SG_CENTER={lat:1.3521,lng:103.8198};
const shell=document.createElement('section');
const launcher=document.createElement('button');
let route=loadRoute();
let draft=makeDraft(route);
let pickerField=null;
let picker={center:{...SG_CENTER},zoom:14,label:'Singapore'};
let routeState={status:'idle',data:null,error:null};
let drag=null;

shell.className='route-shell';
launcher.className='route-launcher';
launcher.type='button';
launcher.textContent='Commute';
launcher.hidden=true;

function esc(value=''){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function makeDraft(value){return{origin:value?.origin||'',destination:value?.destination||'',originPoint:value?.originPoint||null,destinationPoint:value?.destinationPoint||null}}
function loadRoute(){try{const v=JSON.parse(localStorage.getItem(ROUTE_KEY));return v&&typeof v.origin==='string'&&typeof v.destination==='string'?v:null}catch{return null}}
function saveRoute(next){route=next;draft=makeDraft(next);localStorage.setItem(ROUTE_KEY,JSON.stringify(next))}
function networkBadges(){return`<div class="sg-network"><span class="sg-line ns">NS</span><span class="sg-line ew">EW</span><span class="sg-line ne">NE</span><span class="sg-line cc">CC</span><span class="sg-line dt">DT</span><span class="sg-line te">TE</span></div>`}
function brand(){return`<div class="route-brand"><div class="route-wordmark">jalan</div><div class="route-country">SG</div></div>`}
function staticMapUrl(){const p=new URLSearchParams({layerchosen:'default',latitude:String(picker.center.lat),longitude:String(picker.center.lng),postal:'',zoom:String(picker.zoom),width:'512',height:'512',points:`[${picker.center.lat},${picker.center.lng}]`});return`https://www.onemap.gov.sg/api/staticmap/getStaticImage?${p}`}
function fmtDuration(seconds){const min=Math.max(1,Math.round(Number(seconds||0)/60));return`${min} min`}
function fmtDistance(m){const n=Number(m||0);return n>=1000?`${(n/1000).toFixed(1)} km`:`${Math.round(n)} m`}

function setupView(){
 const canSave=draft.origin&&draft.destination;
 const row=(field,label,placeholder,node)=>`<button class="route-location-row" type="button" data-route-pick="${field}"><span class="route-node ${node}" aria-hidden="true"></span><span class="route-field-copy"><span class="route-field-label">${label}</span><span class="route-location-value${draft[field]?'':' placeholder'}">${esc(draft[field]||placeholder)}</span></span><span class="route-map-action">Choose</span></button>`;
 return`<div class="route-panel">${brand()}<div class="route-setup-copy"><div class="route-kicker">Bus + MRT · Singapore</div><h1>Where are you going?</h1><p>Pick a point on OneMap, use your location, or enter a Singapore place manually.</p>${networkBadges()}</div><div class="route-form"><div class="route-input-card">${row('origin','From','Choose where you start','origin')}${row('destination','To','Choose where you’re going','destination')}</div><div class="route-form-hint">Exact map coordinates unlock public-transport routing.</div><button class="route-primary" type="button" data-route-action="save-route" ${canSave?'':'disabled'}>${route?'Update commute':'Save commute'}</button></div><button class="route-link" type="button" data-route-action="bus">I only need bus arrivals</button></div>`
}

function pickerView(){
 const current=draft[pickerField]||'';
 return`<div class="route-picker"><div class="picker-topbar"><button class="picker-back" type="button" data-route-action="cancel-picker" aria-label="Back">‹</button><div><div class="route-kicker">${pickerField==='origin'?'From':'To'}</div><div class="picker-title">Choose on OneMap</div></div></div><div class="onemap-stage" id="onemap-stage"><img id="onemap-image" src="${esc(staticMapUrl())}" alt="OneMap Singapore map" draggable="false"><div class="picker-crosshair" aria-hidden="true"><span></span></div><div class="map-tools"><button type="button" data-route-action="zoom-in">+</button><button type="button" data-route-action="zoom-out">−</button></div><button class="picker-locate" type="button" data-route-action="my-location">◎ My location</button><div class="onemap-attrib">OneMap · Singapore Land Authority</div></div><div class="picker-sheet"><div class="route-card-label">Selected area</div><div id="picker-label" class="picker-place">${esc(picker.label)}</div><div class="picker-coords">${picker.center.lat.toFixed(5)}, ${picker.center.lng.toFixed(5)}</div><button class="route-primary" type="button" data-route-action="confirm-picker">Use this point</button><div class="picker-divider"><span>or type a place</span></div><div class="picker-manual-row"><input id="picker-manual-input" class="picker-manual-input" value="${esc(current)}" placeholder="Tampines MRT, postal code, Blk 123…" autocomplete="street-address" enterkeyhint="done"><button class="picker-manual-button" type="button" data-route-action="use-manual" ${current?'':'disabled'}>Use</button></div><div id="picker-manual-hint" class="picker-manual-hint">OneMap search will resolve the text to coordinates when API credentials are configured.</div></div></div>`
}

function journeyCard(){return`<section class="journey-card"><div class="journey-row"><span class="route-node origin"></span><div><div class="journey-label">From${route.originPoint?' · mapped':''}</div><div class="journey-place">${esc(route.origin)}</div></div></div><div class="journey-row"><span class="route-node destination"></span><div><div class="journey-label">To${route.destinationPoint?' · mapped':''}</div><div class="journey-place">${esc(route.destination)}</div></div></div></section>`}
function routeCard(){
 if(!route.originPoint||!route.destinationPoint)return`<section class="best-route-card"><div class="route-card-label">Best route</div><h2>Map both endpoints</h2><p>Edit the commute and choose exact points so Jalan can calculate a bus + MRT route.</p></section>`;
 if(routeState.status==='loading')return`<section class="best-route-card"><div class="route-card-label">Best route</div><h2>Finding route…</h2><p>Checking OneMap public transport options.</p></section>`;
 if(routeState.status==='error')return`<section class="best-route-card"><div class="route-card-label">Best route</div><h2>Routing unavailable</h2><p>${esc(routeState.error||'Could not load a route.')}</p><button class="route-link" data-route-action="retry-route">Retry</button></section>`;
 const itinerary=routeState.data?.itinerary;
 if(!itinerary)return`<section class="best-route-card"><div class="route-card-label">Best route</div><h2>Ready to route</h2><p>Route data will load automatically when OneMap routing credentials are available.</p></section>`;
 const legs=(itinerary.legs||[]).map(leg=>`<div class="route-leg"><span class="leg-mode ${String(leg.mode||'').toLowerCase()}">${esc(leg.mode||'PT')}</span><div><strong>${esc(leg.label||leg.mode||'Travel')}</strong><span>${esc(leg.detail||'')}</span></div></div>`).join('');
 return`<section class="best-route-card"><div class="route-card-top"><div><div class="route-card-label">Best route now</div><h2>${fmtDuration(itinerary.duration)}</h2></div><div class="route-summary-meta">${itinerary.transfers??0} transfer${itinerary.transfers===1?'':'s'}</div></div><div class="route-legs">${legs}</div></section>`
}
function dashboardView(){return`<div class="route-panel">${brand()}<div class="route-header"><div><div class="route-kicker">Saved commute</div><h1>Ready when you are.</h1></div><button class="route-link compact" data-route-action="edit">Edit</button></div>${journeyCard()}${routeCard()}<section class="timing-card"><div class="timing-heading"><div><div class="route-card-label">Live timings</div><h2>Bus live · MRT next</h2></div><span class="live-state">LTA</span></div><p>Bus arrivals remain available now. MRT real-time data will plug into the calculated route separately.</p></section><div class="route-actions"><button class="route-primary" data-route-action="bus">Open bus arrivals</button><button class="route-link" data-route-action="clear">Remove saved commute</button></div></div>`}

function render(){shell.innerHTML=pickerField?pickerView():(route?dashboardView():setupView());bind();if(route&&!pickerField&&route.originPoint&&route.destinationPoint&&routeState.status==='idle')loadRouteData();if(pickerField)refreshPickerLabel()}
function openPicker(field){pickerField=field;const point=draft[`${field}Point`];picker={center:point?{...point}:{...SG_CENTER},zoom:point?17:14,label:draft[field]||'Pinned location'};render()}
function closePicker(){pickerField=null;render()}
function confirmPicker(){draft[pickerField]=picker.label==='Singapore'?'Pinned location':picker.label;draft[`${pickerField}Point`]={...picker.center};closePicker()}

async function refreshPickerLabel(){
 const labelEl=document.getElementById('picker-label');
 try{const r=await fetch(`/api/location?lat=${picker.center.lat}&lng=${picker.center.lng}`);const d=await r.json();if(r.ok&&d.label){picker.label=d.label;if(labelEl)labelEl.textContent=d.label}else if(labelEl)labelEl.textContent='Pinned location'}catch{if(labelEl)labelEl.textContent='Pinned location'}
}
async function useManual(){
 const input=document.getElementById('picker-manual-input');const button=shell.querySelector('[data-route-action="use-manual"]');const hint=document.getElementById('picker-manual-hint');const q=String(input?.value||'').trim();if(!q)return;
 if(button){button.disabled=true;button.textContent='Finding…'}if(hint)hint.textContent='Searching OneMap…';
 try{const r=await fetch(`/api/location?q=${encodeURIComponent(q)}`);const d=await r.json();if(r.ok&&d.point){draft[pickerField]=d.label||q;draft[`${pickerField}Point`]=d.point}else{draft[pickerField]=q;draft[`${pickerField}Point`]=null}}catch{draft[pickerField]=q;draft[`${pickerField}Point`]=null}closePicker()
}
function useMyLocation(){
 if(!navigator.geolocation)return;
 const b=shell.querySelector('[data-route-action="my-location"]');if(b){b.disabled=true;b.textContent='Locating…'};
 navigator.geolocation.getCurrentPosition(pos=>{picker.center={lat:pos.coords.latitude,lng:pos.coords.longitude};picker.zoom=17;picker.label='My location';render()},()=>{if(b){b.disabled=false;b.textContent='Location unavailable'}},{enableHighAccuracy:true,timeout:7000,maximumAge:60000})
}

function mercatorPx(lat,lng,zoom){const size=256*Math.pow(2,zoom);const x=(lng+180)/360*size;const sin=Math.sin(lat*Math.PI/180);const y=(.5-Math.log((1+sin)/(1-sin))/(4*Math.PI))*size;return{x,y,size}}
function fromMercator(x,y,zoom){const size=256*Math.pow(2,zoom);const lng=x/size*360-180;const n=Math.PI-2*Math.PI*y/size;const lat=180/Math.PI*Math.atan(.5*(Math.exp(n)-Math.exp(-n)));return{lat:Math.max(1.15,Math.min(1.49,lat)),lng:Math.max(103.55,Math.min(104.1,lng))}}
function shiftMap(dx,dy){const stage=document.getElementById('onemap-stage');if(!stage)return;const scale=512/stage.clientWidth;const p=mercatorPx(picker.center.lat,picker.center.lng,picker.zoom);picker.center=fromMercator(p.x-dx*scale,p.y-dy*scale,picker.zoom);picker.label='Pinned location';render()}

function normalizeItinerary(raw){
 const plan=raw?.plan||raw?.data?.plan;const it=plan?.itineraries?.[0];if(!it)return null;
 const legs=(it.legs||[]).map(leg=>{const mode=String(leg.mode||'').toUpperCase();const from=leg.from?.name||'';const to=leg.to?.name||'';const routeName=leg.routeShortName||leg.route||leg.agencyName||'';let label=mode==='WALK'?`Walk ${fmtDistance(leg.distance)}`:(routeName?`${mode} ${routeName}`:mode);return{mode,label,detail:[from,to].filter(Boolean).join(' → ')}});
 return{duration:Number(it.duration||0),transfers:Number(it.transfers||0),legs}
}
async function loadRouteData(){
 routeState={status:'loading',data:null,error:null};render();
 const start=`${route.originPoint.lat},${route.originPoint.lng}`,end=`${route.destinationPoint.lat},${route.destinationPoint.lng}`;
 try{const r=await fetch(`/api/route?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);const d=await r.json();if(!r.ok)throw new Error(d.error||'Routing unavailable.');const itinerary=normalizeItinerary(d);if(!itinerary)throw new Error('OneMap returned no public-transport itinerary.');routeState={status:'ready',data:{itinerary},error:null}}catch(e){routeState={status:'error',data:null,error:e.message}}render()
}

function bind(){
 shell.querySelectorAll('[data-route-pick]').forEach(b=>b.addEventListener('click',()=>openPicker(b.dataset.routePick)));
 const manual=document.getElementById('picker-manual-input'),manualBtn=shell.querySelector('[data-route-action="use-manual"]');if(manual){manual.addEventListener('input',()=>{if(manualBtn)manualBtn.disabled=!manual.value.trim()});manual.addEventListener('keydown',e=>{if(e.key==='Enter'&&manual.value.trim()){e.preventDefault();useManual()}})}
 shell.querySelectorAll('[data-route-action]').forEach(b=>b.addEventListener('click',()=>{const a=b.dataset.routeAction;if(a==='bus'){shell.hidden=true;launcher.hidden=false}else if(a==='edit'){draft=makeDraft(route);route=null;routeState={status:'idle',data:null,error:null};render()}else if(a==='save-route'){if(!draft.origin||!draft.destination)return;saveRoute({id:'route-1',...draft,updatedAt:new Date().toISOString()});routeState={status:'idle',data:null,error:null};render()}else if(a==='clear'){localStorage.removeItem(ROUTE_KEY);route=null;draft=makeDraft(null);routeState={status:'idle',data:null,error:null};render()}else if(a==='cancel-picker')closePicker();else if(a==='confirm-picker')confirmPicker();else if(a==='use-manual')useManual();else if(a==='my-location')useMyLocation();else if(a==='zoom-in'){picker.zoom=Math.min(19,picker.zoom+1);render()}else if(a==='zoom-out'){picker.zoom=Math.max(11,picker.zoom-1);render()}else if(a==='retry-route'){routeState={status:'idle',data:null,error:null};render()}}));
 const stage=document.getElementById('onemap-stage'),img=document.getElementById('onemap-image');if(stage&&img){stage.addEventListener('pointerdown',e=>{if(e.target.closest('button'))return;drag={x:e.clientX,y:e.clientY};stage.setPointerCapture(e.pointerId)});stage.addEventListener('pointermove',e=>{if(!drag)return;img.style.transform=`translate(${e.clientX-drag.x}px,${e.clientY-drag.y}px)`});stage.addEventListener('pointerup',e=>{if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag=null;img.style.transform='';if(Math.abs(dx)+Math.abs(dy)>4)shiftMap(dx,dy)});stage.addEventListener('pointercancel',()=>{drag=null;img.style.transform=''})}
}
launcher.addEventListener('click',()=>{shell.hidden=false;launcher.hidden=true;render()});document.body.append(shell,launcher);render();
})();