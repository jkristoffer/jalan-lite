const {getOneMapToken}=require('./_onemap-auth');

function sgDateTime(){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Singapore',month:'2-digit',day:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
  const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));
  return{date:`${p.month}-${p.day}-${p.year}`,time:`${p.hour}:${p.minute}:${p.second}`,hour:Number(p.hour)};
}
function addDay(date){
  const[month,day,year]=date.split('-').map(Number);
  const next=new Date(Date.UTC(year,month-1,day+1));
  return`${String(next.getUTCMonth()+1).padStart(2,'0')}-${String(next.getUTCDate()).padStart(2,'0')}-${next.getUTCFullYear()}`;
}
function validCoord(value){return /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(value)}
function isNoRoute(response,data){return response.status===404||/no .*route found/i.test(String(data?.error||data?.message||''))}
async function requestRoute({token,start,end,date,time,numItineraries='3',maxWalkDistance='2000'}){
  const url=new URL('https://www.onemap.gov.sg/api/public/routingsvc/route');
  url.searchParams.set('start',start);
  url.searchParams.set('end',end);
  url.searchParams.set('routeType','pt');
  url.searchParams.set('date',date);
  url.searchParams.set('time',time);
  url.searchParams.set('mode','TRANSIT');
  url.searchParams.set('maxWalkDistance',maxWalkDistance);
  url.searchParams.set('numItineraries',numItineraries);
  const response=await fetch(url,{headers:{Authorization:token}});
  let data={};
  try{data=await response.json()}catch{}
  return{response,data};
}

module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  try{
    const start=String(req.query?.start||''),end=String(req.query?.end||'');
    if(!validCoord(start)||!validCoord(end))return res.status(400).json({error:'Valid start and end coordinates are required.'});

    const token=await getOneMapToken();
    const now=sgDateTime();
    const current=await requestRoute({token,start,end,date:now.date,time:now.time});
    if(current.response.ok&&!current.data.error){
      current.data._jalan={service:'now',requestedDate:now.date,requestedTime:now.time};
      return res.status(200).json(current.data);
    }

    if(isNoRoute(current.response,current.data)){
      const nextDate=now.hour<5?now.date:addDay(now.date);
      const nextTime='05:30:00';
      const next=await requestRoute({token,start,end,date:nextDate,time:nextTime});
      if(next.response.ok&&!next.data.error){
        next.data._jalan={service:'next',requestedDate:nextDate,requestedTime:nextTime,reason:'No public transport route was available for the current time.'};
        return res.status(200).json(next.data);
      }
      return res.status(current.response.status||404).json({error:current.data.error||'No public transport route is available now.',nextServiceError:next.data.error||null});
    }

    return res.status(current.response.status||502).json({error:current.data.error||current.data.message||'OneMap routing failed.',details:current.data});
  }catch(error){
    const status=error.code==='ONEMAP_NOT_CONFIGURED'?503:502;
    return res.status(status).json({error:error.message});
  }
}
