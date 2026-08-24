const {getOneMapToken}=require('./_onemap-auth');
module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  try{
    const token=await getOneMapToken();
    const q=String(req.query?.q||'').trim();
    const lat=Number(req.query?.lat),lng=Number(req.query?.lng);
    if(q){
      const url=new URL('https://www.onemap.gov.sg/api/common/elastic/search');
      url.searchParams.set('searchVal',q);url.searchParams.set('returnGeom','Y');url.searchParams.set('getAddrDetails','Y');url.searchParams.set('pageNum','1');
      const response=await fetch(url,{headers:{Authorization:token}});const data=await response.json();
      if(!response.ok||data.error)throw new Error(data.error||'OneMap search failed.');
      const item=data.results?.[0];if(!item)return res.status(404).json({error:'No Singapore location found.'});
      const label=[item.SEARCHVAL,item.ADDRESS].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).join(' · ');
      return res.status(200).json({label,point:{lat:Number(item.LATITUDE),lng:Number(item.LONGITUDE)}});
    }
    if(Number.isFinite(lat)&&Number.isFinite(lng)){
      const url=new URL('https://www.onemap.gov.sg/api/public/revgeocode?location='+encodeURIComponent(`${lat},${lng}`)+'&buffer=80&addressType=All&otherFeatures=N');
      const response=await fetch(url,{headers:{Authorization:token}});const data=await response.json();
      if(!response.ok||data.error)throw new Error(data.error||'OneMap reverse geocode failed.');
      const item=data.GeocodeInfo?.find(x=>!x.error);const label=item?[item.BUILDINGNAME,item.BLOCK,item.ROAD,item.POSTALCODE].filter(v=>v&&v!=='NIL').join(' ').replace(/\s+/g,' ').trim():'';
      return res.status(200).json({label:label||'Pinned location',point:{lat,lng}});
    }
    return res.status(400).json({error:'Provide q or lat/lng.'});
  }catch(error){const status=error.code==='ONEMAP_NOT_CONFIGURED'?503:502;return res.status(status).json({error:error.message});}
}
