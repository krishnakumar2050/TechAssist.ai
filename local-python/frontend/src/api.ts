export async function api<T>(path:string, options:RequestInit={}):Promise<T> {
  const response=await fetch('/api'+path,{credentials:'same-origin',...options});
  if(!response.ok){let message='The request could not be completed.';try{const data=await response.json();message=typeof data.detail==='string'?data.detail:message;}catch{}throw new Error(message);}
  return response.json() as Promise<T>;
}
export async function streamReply(path:string, csrf:string, body:unknown, onEvent:(event:string,data:any)=>void){
  const response=await fetch('/api'+path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});
  if(!response.ok){let data;try{data=await response.json();}catch{}throw new Error(typeof data?.detail==='string'?data.detail:'The request could not be completed.');}
  if(!response.body)throw new Error('Streaming is unavailable in this browser.');
  const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';let complete=false;
  try{while(true){const {done,value}=await reader.read();buffer+=decoder.decode(value,{stream:!done});let boundary;
    while((boundary=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const event=frame.split('\n').find(l=>l.startsWith('event:'))?.slice(6).trim();const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
      if(event&&data){const payload=JSON.parse(data);if(event==='error')throw new Error(payload.message);if(event==='completed')complete=true;onEvent(event,payload);}}
    if(done)break;
  }}finally{reader.releaseLock();}
  if(!complete)throw new Error('The connection ended before the reply arrived. Retry to recover your saved response.');
}
