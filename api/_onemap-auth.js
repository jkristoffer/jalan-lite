let cachedToken=null;
let cachedExpiry=0;

async function getOneMapToken(){
  const directToken=process.env.ONEMAP_ACCESS_TOKEN||process.env.ONEMAP_TOKEN;
  if(directToken)return directToken;
  const now=Math.floor(Date.now()/1000);
  if(cachedToken&&cachedExpiry>now+300)return cachedToken;
  const email=process.env.ONEMAP_EMAIL;
  const password=process.env.ONEMAP_PASSWORD||process.env.ONEMAP_EMAIL_PASSWORD;
  if(!email||!password){
    const error=new Error('OneMap routing is not configured. Add ONEMAP_ACCESS_TOKEN, or ONEMAP_EMAIL and ONEMAP_PASSWORD in Vercel.');
    error.code='ONEMAP_NOT_CONFIGURED';
    throw error;
  }
  const response=await fetch('https://www.onemap.gov.sg/api/auth/post/getToken',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({email,password})
  });
  const data=await response.json();
  if(!response.ok||!data.access_token)throw new Error(data.error||'Unable to authenticate with OneMap.');
  cachedToken=data.access_token;
  cachedExpiry=Number(data.expiry_timestamp||now+3600);
  return cachedToken;
}

module.exports={getOneMapToken};
