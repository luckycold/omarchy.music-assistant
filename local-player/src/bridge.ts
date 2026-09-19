import {createServer as httpServer} from 'node:http';
import {createServer as netServer, type Socket} from 'node:net';
import {chmod,lstat,unlink} from 'node:fs/promises';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {join} from 'node:path';
import {WebSocketServer,WebSocket} from 'ws';
import {privateDirectory} from './config';
import {MAX_REQUEST,MAX_RESPONSE,MAX_PENDING,validateRequest,sanitizeStatus,safeCode} from './protocol';
export async function createBridge(options:{state:string;config:unknown;deadlineMs?:number;authMs?:number;healthMs?:number;onUnhealthy?:()=>void}){
 await privateDirectory(options.state);const socketPath=join(options.state,'player.sock');
 try{const s=await lstat(socketPath);if(!s.isSocket()||s.uid!==process.getuid?.())throw Error('CONFIG_PRIVATE');await unlink(socketPath);}catch(e:any){if(e.code!=='ENOENT')throw e;}
 const secret=randomBytes(32).toString('hex');let browser:WebSocket|undefined;let status=sanitizeStatus();let next=0;let heartbeat=Date.now();let closed=false;
 const pending=new Map<number,{resolve:(v:unknown)=>void;timer:ReturnType<typeof setTimeout>}>();const clients=new Set<Socket>();
 const settle=(id:number,value:unknown)=>{const p=pending.get(id);if(p){clearTimeout(p.timer);pending.delete(id);p.resolve(value);}};
 const lost=()=>{browser=undefined;status=sanitizeStatus({phase:'failed',error:'BRIDGE_CLOSED'});for(const id of pending.keys())settle(id,{error:'BRIDGE_CLOSED'});};
 const server=httpServer((_req,res)=>{res.writeHead(404);res.end();});
 const wss=new WebSocketServer({noServer:true,maxPayload:MAX_RESPONSE,perMessageDeflate:false});
 server.on('upgrade',(req,socket,head)=>{
  if(req.headers.origin!=='null'||req.url!=='/bridge'||req.headers.host!==`127.0.0.1:${(server.address() as any).port}`||wss.clients.size>=2){socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,w=>wss.emit('connection',w,req));
 });
 wss.on('connection',w=>{
  let authed=false;const timer=setTimeout(()=>w.terminate(),options.authMs??3000);w.on('error',()=>{});
  w.on('close',()=>{clearTimeout(timer);if(browser===w)lost();});
  w.on('message',(data,isBinary)=>{try{
   if(isBinary)throw 0;const m=JSON.parse(data.toString());
   if(!authed){const incoming=Buffer.from(typeof m.secret==='string'?m.secret:'');const expected=Buffer.from(secret);
    if(m.type!=='hello'||incoming.length!==expected.length||!timingSafeEqual(incoming,expected)||browser)throw 0;
    authed=true;clearTimeout(timer);browser=w;heartbeat=Date.now();w.send(JSON.stringify({type:'config',config:options.config}));return;}
   if(m.type==='status'){status=sanitizeStatus(m.status);heartbeat=Date.now();}
   else if(m.type==='result'&&Number.isSafeInteger(m.id)){settle(m.id,m.error?{error:safeCode(m.error)}:{result:m.result??null});}
   else throw 0;
  }catch{w.terminate();}});
 });
 const ipc=netServer({allowHalfOpen:true},s=>{
  if(clients.size>=64){s.end(JSON.stringify({error:'RPC_LIMIT'})+'\n');return;}clients.add(s);s.on('error',()=>{});s.on('close',()=>clients.delete(s));s.setTimeout(options.deadlineMs??35000,()=>s.destroy());
  let data=Buffer.alloc(0);let handled=false;
  const reply=(obj:unknown)=>{if(s.destroyed)return;let text=JSON.stringify(obj);if(Buffer.byteLength(text)>MAX_RESPONSE)text=JSON.stringify({error:'RPC_LIMIT'});s.end(text+'\n');};
  s.on('data',chunk=>{
   if(handled)return;data=Buffer.concat([data,chunk]);if(data.length>MAX_REQUEST){handled=true;reply({error:'RPC_LIMIT'});return;}
   const idx=data.indexOf(10);if(idx<0)return;handled=true;
   try{if(data.subarray(idx+1).toString().trim())throw Error('BAD_REQUEST');const m=validateRequest(JSON.parse(data.subarray(0,idx).toString()));
    if(m.command==='local/status'){reply({result:status});return;}
    if(!browser||browser.readyState!==WebSocket.OPEN){reply({error:'NOT_READY'});return;}
    if(pending.size>=MAX_PENDING){reply({error:'RPC_LIMIT'});return;}
    const id=++next;const promise=new Promise(resolve=>{const timer=setTimeout(()=>settle(id,{error:'BRIDGE_TIMEOUT'}),options.deadlineMs??35000);pending.set(id,{resolve,timer});});
    s.once('close',()=>settle(id,{error:'BRIDGE_CLOSED'}));browser.send(JSON.stringify({type:'request',id,...m}));void promise.then(reply);
   }catch(e){reply({error:safeCode(e instanceof Error?e.message:'BAD_REQUEST')});}
  });
  s.on('end',()=>{if(!handled){handled=true;reply({error:'BAD_REQUEST'});}});
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 await new Promise<void>((resolve,reject)=>{ipc.once('error',reject);ipc.listen(socketPath,resolve);});await chmod(socketPath,0o600);
 const health=setInterval(()=>{if(Date.now()-heartbeat>(options.healthMs??15000)){browser?.terminate();lost();heartbeat=Date.now();options.onUnhealthy?.();}},Math.min(options.healthMs??15000,1000));
 return {socketPath,secret,url:`ws://127.0.0.1:${(server.address() as any).port}/bridge`,port:(server.address() as any).port as number,
 async close(){if(closed)return;closed=true;clearInterval(health);for(const w of wss.clients)w.terminate();lost();for(const s of clients)s.destroy();await Promise.all([new Promise<void>(r=>ipc.close(()=>r())),new Promise<void>(r=>server.close(()=>r()))]);wss.close();await unlink(socketPath).catch(()=>{});}};
}
