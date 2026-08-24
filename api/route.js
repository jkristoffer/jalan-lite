const {getOneMapToken}=require('./_onemap-auth');
function sgDateTime(){const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Singapore',month:'2-digit',day:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date());const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));return{date:`${p.month}-${p.day}-${p.year}`,time:`${p.hour}:${p.minute}:${p.second}`}}
function validCoord(value){return /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(value)}
module.exports=async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 try{
  const start=String(req.query?.start||''),end=String(req.query?.end||'');if(!validCoord(start)||!validCoord(end))return res.status(400).json({error:'Valid start and end coordinates are required.'});
  const token=await getOneMapToken();const now=sgDateTime();const url=new URL('https://www.onemap.gov.sg/api/public/routingsvc/route');
  url.searchParams.set('start',start);url.searchParams.set('end',end);url.searchParams.set('routeType','pt');url.searchParams.set('date',now.date);url.searchParams.set('time',now.time);url.searchParams.set('mode','TRANSIT');url.searchParams.set('maxWalkDistance','1200');url.searchParams.set('numItineraries','1');
  const response=await fetch(url,{headers:{Authorization:token}});const data=await response.json();if(!response.ok||data.error)return res.status(response.status||502).json({error:data.error||data.message||'OneMap routing failed.',details:data});return res.status(200).json(data);
 }catch(error){const status=error.code==='ONEMAP_NOT_CONFIGURED'?503:502;return res.status(status).json({error:error.message});}
}
