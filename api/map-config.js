export default function handler(req,res){
  res.setHeader('Cache-Control','s-maxage=300, stale-while-revalidate=3600');
  const token=process.env.MAPBOX_PUBLIC_TOKEN||process.env.MAPBOX_TOKEN||'';
  if(!token){
    return res.status(503).json({error:'MAPBOX_PUBLIC_TOKEN is not configured.'});
  }
  if(!token.startsWith('pk.')){
    return res.status(500).json({error:'Mapbox token must be a public token starting with pk.'});
  }
  return res.status(200).json({token});
}
