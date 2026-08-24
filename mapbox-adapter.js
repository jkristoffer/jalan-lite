(()=>{
  let tokenPromise;

  function getToken(){
    if(!tokenPromise){
      tokenPromise=fetch('/api/map-config')
        .then(async response=>{
          const data=await response.json();
          if(!response.ok||!data.token)throw new Error(data.error||'Mapbox is not configured.');
          return data.token;
        });
    }
    return tokenPromise;
  }

  function markerElement(stop,selected,onSelect){
    const button=document.createElement('button');
    button.type='button';
    button.className=`stop-marker${selected?' selected':''}`;
    button.dataset.stopCode=stop.stopCode;
    button.textContent=stop.stopCode;
    button.setAttribute('aria-label',`${stop.name}, bus stop ${stop.stopCode}`);
    button.addEventListener('click',()=>onSelect(stop.stopCode));
    return button;
  }

  async function create({container,center,stops,selectedStopCode,onSelect}){
    if(typeof mapboxgl==='undefined')throw new Error('Mapbox failed to load.');
    const token=await getToken();
    mapboxgl.accessToken=token;

    const map=new mapboxgl.Map({
      container,
      style:'mapbox://styles/mapbox/standard',
      center:[center.lng,center.lat],
      zoom:16.8,
      minZoom:15.2,
      maxZoom:18.2,
      maxPitch:0,
      pitch:0,
      bearing:0,
      dragRotate:false,
      touchPitch:false,
      attributionControl:true,
      logoPosition:'bottom-left',
      config:{
        basemap:{
          theme:'monochrome',
          lightPreset:'day',
          showPointOfInterestLabels:false,
          showTransitLabels:false,
          show3dObjects:false,
          showPlaceLabels:true,
          showRoadLabels:true,
          font:'Barlow'
        }
      }
    });
    map.touchZoomRotate.disableRotation();

    await new Promise((resolve,reject)=>{
      map.once('load',resolve);
      map.once('error',event=>reject(event?.error||new Error('Unable to load map.')));
    });

    const locationEl=document.createElement('div');
    locationEl.className='location-dot';
    locationEl.setAttribute('aria-hidden','true');
    new mapboxgl.Marker({element:locationEl,anchor:'center'})
      .setLngLat([center.lng,center.lat])
      .addTo(map);

    const markerEls=new Map();
    const markers=[];
    stops.forEach(stop=>{
      const el=markerElement(stop,stop.stopCode===selectedStopCode,onSelect);
      markerEls.set(stop.stopCode,el);
      markers.push(new mapboxgl.Marker({element:el,anchor:'center'})
        .setLngLat([stop.lng,stop.lat])
        .addTo(map));
    });

    function selectStop(stop){
      markerEls.forEach((el,code)=>el.classList.toggle('selected',code===stop.stopCode));
      map.easeTo({
        center:[stop.lng,stop.lat],
        zoom:17.05,
        offset:[0,-34],
        duration:260,
        easing:t=>1-Math.pow(1-t,3)
      });
    }

    const initial=stops.find(stop=>stop.stopCode===selectedStopCode);
    if(initial)selectStop(initial);

    return {
      selectStop,
      destroy(){
        markers.forEach(marker=>marker.remove());
        map.remove();
      }
    };
  }

  window.JalanMap={create};
})();
