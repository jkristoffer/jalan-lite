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

  function toBounds(bounds){
    if(!bounds||!bounds.sw||!bounds.ne)return undefined;
    return [[bounds.sw.lng,bounds.sw.lat],[bounds.ne.lng,bounds.ne.lat]];
  }

  class MapWrapper{
    constructor(container,options={}){
      this.container=typeof container==='string'?document.getElementById(container):container;
      this.options=options;
      this.map=null;
      this.center=[103.8198,1.3521];
      this.zoom=16.6;
      this.queue=[];
      this.destroyed=false;
      this.ready=this.init();
    }

    async init(){
      try{
        const token=await getToken();
        if(this.destroyed)return;
        mapboxgl.accessToken=token;
        this.map=new mapboxgl.Map({
          container:this.container,
          style:'mapbox://styles/mapbox/standard',
          center:this.center,
          zoom:this.zoom,
          minZoom:this.options.minZoom||11,
          maxZoom:this.options.maxZoom||19,
          maxPitch:0,
          pitch:0,
          bearing:0,
          dragRotate:false,
          touchPitch:false,
          maxBounds:toBounds(this.options.maxBounds),
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
        this.map.touchZoomRotate.disableRotation();
        this.map.once('load',()=>{
          if(this.destroyed)return;
          this.queue.splice(0).forEach(fn=>fn());
        });
      }catch(error){
        if(this.container&&!this.destroyed){
          this.container.innerHTML=`<div class="map-loading">${error.message||'Unable to load Mapbox.'}</div>`;
        }
      }
    }

    whenReady(fn){
      if(this.destroyed)return;
      if(this.map&&this.map.loaded())fn();
      else this.queue.push(fn);
    }

    setView(latLng,zoom){
      this.center=[latLng[1],latLng[0]];
      this.zoom=Math.min(17.25,Math.max(16.55,Number(zoom)||16.7));
      if(this.map)this.map.jumpTo({center:this.center,zoom:this.zoom});
      return this;
    }

    panTo(latLng){
      const center=[latLng[1],latLng[0]];
      this.center=center;
      this.whenReady(()=>this.map.easeTo({center,zoom:17.05,duration:320,easing:t=>1-Math.pow(1-t,3)}));
      return this;
    }

    addMarker(marker){
      this.whenReady(()=>marker.mount(this.map));
      return this;
    }

    remove(){
      this.destroyed=true;
      this.queue=[];
      if(this.map){
        this.map.remove();
        this.map=null;
      }
      if(this.container)this.container.innerHTML='';
    }
  }

  class MarkerWrapper{
    constructor(latLng,options={}){
      this.latLng=latLng;
      this.options=options;
      this.mapboxMarker=null;
      this.clickHandlers=[];
    }

    makeElement(){
      const icon=this.options.icon||{};
      const wrapper=document.createElement('div');
      wrapper.className=(icon.className||'').replace('leaflet-div-icon','').trim();
      wrapper.innerHTML=icon.html||'';
      const element=wrapper.firstElementChild||wrapper;
      if(this.options.interactive===false)element.style.pointerEvents='none';
      this.clickHandlers.forEach(handler=>element.addEventListener('click',handler));
      return element;
    }

    mount(map){
      if(this.mapboxMarker)return;
      const element=this.makeElement();
      this.mapboxMarker=new mapboxgl.Marker({element,anchor:'center'})
        .setLngLat([this.latLng[1],this.latLng[0]])
        .addTo(map);
    }

    addTo(mapWrapper){
      mapWrapper.addMarker(this);
      return this;
    }

    on(event,handler){
      if(event==='click')this.clickHandlers.push(handler);
      return this;
    }
  }

  window.L={
    latLng:(lat,lng)=>({lat,lng}),
    latLngBounds:(sw,ne)=>({sw,ne}),
    map:(container,options)=>new MapWrapper(container,options),
    tileLayer:()=>({addTo:()=>({})}),
    divIcon:options=>options,
    marker:(latLng,options)=>new MarkerWrapper(latLng,options)
  };
})();
