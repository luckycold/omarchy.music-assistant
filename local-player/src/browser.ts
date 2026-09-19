import {createSession} from './session';
import {ReconnectLoop} from './reconnect';
import {safeCode,MAX_PENDING,MAX_RESPONSE} from './protocol';
declare global {interface Window {MA_BOOTSTRAP?:{secret:string;port:number}}}
const boot=window.MA_BOOTSTRAP!;delete window.MA_BOOTSTRAP;
const ws=new WebSocket(`ws://127.0.0.1:${boot.port}/bridge`);
let session:ReturnType<typeof createSession>|undefined;let loop:ReconnectLoop|undefined;let pending=0;
const send=(m:unknown)=>{if(ws.readyState===WebSocket.OPEN){const text=JSON.stringify(m);if(text.length<=MAX_RESPONSE)ws.send(text);}};
const update=()=>send({type:'status',status:session?.status()??{phase:'starting'}});
ws.onopen=()=>{send({type:'hello',secret:boot.secret});boot.secret='';};
ws.onmessage=async event=>{try{const m=JSON.parse(event.data);
 if(m.type==='config'&&!session){session=createSession(m.config,{storage:{getItem:k=>localStorage.getItem(k),setItem:(k,v)=>localStorage.setItem(k,v)}});loop=new ReconnectLoop(session,update);loop.start();}
 else if(m.type==='request'){
  if(!session||pending>=MAX_PENDING){send({type:'result',id:m.id,error:'NOT_READY'});return;}
  pending++;try{const result=await session.rpc(m.command,m.args);const response={type:'result',id:m.id,result};if(JSON.stringify(response).length>MAX_RESPONSE)send({type:'result',id:m.id,error:'RPC_LIMIT'});else send(response);}catch(e){send({type:'result',id:m.id,error:safeCode(e instanceof Error?e.message:null)});}finally{pending--;}
 }
 }catch{ws.close();}};
const heartbeat=setInterval(update,1000);
ws.onclose=()=>{clearInterval(heartbeat);loop?.stop();};ws.onerror=()=>ws.close();
window.addEventListener('beforeunload',()=>{loop?.stop();ws.close();});
