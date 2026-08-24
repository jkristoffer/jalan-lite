(()=>{
const ROUTE_KEY='jalan-lite-routes-v1';
const shell=document.createElement('section');
const launcher=document.createElement('button');
let route=loadRoute();

shell.className='route-shell';
launcher.className='route-launcher';
launcher.type='button';
launcher.textContent='Commute';
launcher.hidden=true;

function esc(value=''){
  return String(value).replace(/[&<>'\"]/g,char=>({
    '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'
  }[char]));
}

function loadRoute(){
  try{
    const value=JSON.parse(localStorage.getItem(ROUTE_KEY));
    return value&&typeof value.origin==='string'&&typeof value.destination==='string' ? value : null;
  }catch{
    return null;
  }
}

function saveRoute(next){
  route=next;
  localStorage.setItem(ROUTE_KEY,JSON.stringify(next));
}

function networkBadges(){
  return `<div class="sg-network" aria-label="Singapore MRT line colours">
    <span class="sg-line ns">NS</span><span class="sg-line ew">EW</span><span class="sg-line ne">NE</span>
    <span class="sg-line cc">CC</span><span class="sg-line dt">DT</span><span class="sg-line te">TE</span>
  </div>`;
}

function brand(){
  return `<div class="route-brand"><div class="route-wordmark">jalan</div><div class="route-country">SG</div></div>`;
}

function showShell(){
  shell.hidden=false;
  launcher.hidden=true;
  render();
}

function showLegacyBus(){
  shell.hidden=true;
  launcher.hidden=false;
}

function setupView(){
  return `
    <div class="route-panel">
      ${brand()}
      <div class="route-setup-copy">
        <div class="route-kicker">Bus + MRT · Singapore</div>
        <h1>Your everyday route.</h1>
        <p>Save the trip you make on repeat. Jalan will eventually combine walking, bus and MRT into one commute view.</p>
        ${networkBadges()}
      </div>

      <form id="route-form" class="route-form">
        <div class="route-input-card">
          <label class="route-location-row">
            <span class="route-node origin" aria-hidden="true"></span>
            <span class="route-field-copy">
              <span class="route-field-label">From</span>
              <input name="origin" autocomplete="street-address" inputmode="search" placeholder="Home, Tampines MRT, Blk 123…" required>
            </span>
          </label>
          <label class="route-location-row">
            <span class="route-node destination" aria-hidden="true"></span>
            <span class="route-field-copy">
              <span class="route-field-label">To</span>
              <input name="destination" autocomplete="street-address" inputmode="search" placeholder="Office, Raffles Place MRT…" required>
            </span>
          </label>
        </div>
        <div class="route-form-hint">Singapore addresses, MRT stations and landmarks work best.</div>
        <button class="route-primary" type="submit">Save commute</button>
      </form>

      <button class="route-link" type="button" data-route-action="bus">I only need bus arrivals</button>
    </div>`;
}

function journeyCard(){
  return `<section class="journey-card" aria-label="Saved commute">
    <div class="journey-row">
      <span class="route-node origin" aria-hidden="true"></span>
      <div><div class="journey-label">From</div><div class="journey-place">${esc(route.origin)}</div></div>
    </div>
    <div class="journey-row">
      <span class="route-node destination" aria-hidden="true"></span>
      <div><div class="journey-label">To</div><div class="journey-place">${esc(route.destination)}</div></div>
    </div>
  </section>`;
}

function dashboardView(){
  return `
    <div class="route-panel">
      ${brand()}
      <div class="route-header">
        <div>
          <div class="route-kicker">Saved commute</div>
          <h1>Ready when you are.</h1>
        </div>
        <button class="route-link compact" type="button" data-route-action="edit">Edit</button>
      </div>

      ${journeyCard()}

      <section class="best-route-card" aria-labelledby="best-route-title">
        <div class="route-card-top">
          <div>
            <div class="route-card-label">Best route</div>
            <h2 id="best-route-title">Waiting for routing data</h2>
          </div>
          <div class="mode-pills" aria-label="Planned transport modes"><span>BUS</span><span>MRT</span></div>
        </div>
        <p>Next, this card will show the fastest public-transport sequence, walking legs, transfers and total journey time.</p>
      </section>

      <section class="timing-card">
        <div class="timing-heading">
          <div>
            <div class="route-card-label">MRT timings</div>
            <h2>Live feed coming next</h2>
          </div>
          <span class="live-state">Not live</span>
        </div>
        ${networkBadges()}
        <p>Train estimates stay hidden until the LTA GTFS-Realtime feed is parsed and matched to this commute.</p>
      </section>

      <div class="route-actions">
        <button class="route-primary" type="button" data-route-action="bus">Open bus arrivals</button>
        <button class="route-link" type="button" data-route-action="clear">Remove saved commute</button>
      </div>
    </div>`;
}

function render(){
  shell.innerHTML=route ? dashboardView() : setupView();

  const form=shell.querySelector('#route-form');
  if(form){
    form.addEventListener('submit',event=>{
      event.preventDefault();
      const data=new FormData(form);
      const origin=String(data.get('origin')||'').trim();
      const destination=String(data.get('destination')||'').trim();
      if(!origin||!destination)return;
      saveRoute({id:'route-1',origin,destination,createdAt:new Date().toISOString()});
      render();
    });
  }

  shell.querySelectorAll('[data-route-action]').forEach(button=>{
    button.addEventListener('click',()=>{
      const action=button.dataset.routeAction;
      if(action==='bus')showLegacyBus();
      if(action==='edit'){
        const current=route;
        route=null;
        render();
        const form=shell.querySelector('#route-form');
        if(form&&current){
          form.elements.origin.value=current.origin;
          form.elements.destination.value=current.destination;
        }
      }
      if(action==='clear'){
        localStorage.removeItem(ROUTE_KEY);
        route=null;
        render();
      }
    });
  });
}

launcher.addEventListener('click',showShell);
document.body.append(shell,launcher);
render();
})();
