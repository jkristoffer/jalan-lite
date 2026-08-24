(()=>{
const ROUTE_KEY='jalan-lite-routes-v1';
const shell=document.createElement('section');
const launcher=document.createElement('button');
let route=loadRoute();

shell.className='route-shell';
launcher.className='route-launcher';
launcher.type='button';
launcher.textContent='Route';
launcher.hidden=true;

function esc(value=''){
  return String(value).replace(/[&<>'"]/g,char=>({
    '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'
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
      <div class="route-kicker">Jalan Lite</div>
      <div class="route-setup-copy">
        <h1>Where are you going?</h1>
        <p>Save one regular journey. Jalan Lite will use bus and MRT data to surface the best public-transport route and its next timings.</p>
      </div>

      <form id="route-form" class="route-form">
        <label>
          <span>From</span>
          <input name="origin" autocomplete="street-address" placeholder="Home or an address" required>
        </label>
        <label>
          <span>To</span>
          <input name="destination" autocomplete="street-address" placeholder="Work or a destination" required>
        </label>
        <button class="route-primary" type="submit">Save route</button>
      </form>

      <button class="route-link" type="button" data-route-action="bus">Use bus-stop arrivals instead</button>
    </div>`;
}

function dashboardView(){
  return `
    <div class="route-panel">
      <div class="route-header">
        <div>
          <div class="route-kicker">Saved route</div>
          <h1>${esc(route.origin)} <span aria-hidden="true">→</span> ${esc(route.destination)}</h1>
        </div>
        <button class="route-link compact" type="button" data-route-action="edit">Edit</button>
      </div>

      <section class="best-route-card" aria-labelledby="best-route-title">
        <div class="route-card-top">
          <div>
            <div class="route-card-label">Best route</div>
            <h2 id="best-route-title">Not calculated yet</h2>
          </div>
          <div class="mode-pills" aria-label="Supported transport">
            <span>Bus</span><span>MRT</span>
          </div>
        </div>
        <p>Routing data is not connected yet. This card will hold the optimal bus and MRT sequence, walking legs, transfers, and total journey time.</p>
      </section>

      <section class="timing-card">
        <div>
          <div class="route-card-label">MRT timings</div>
          <h2>Live feed not connected</h2>
        </div>
        <p>No estimated train times are shown until the GTFS-Realtime feed is parsed and matched to this route.</p>
      </section>

      <div class="route-actions">
        <button class="route-primary" type="button" data-route-action="bus">Open bus arrivals</button>
        <button class="route-link" type="button" data-route-action="clear">Remove saved route</button>
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