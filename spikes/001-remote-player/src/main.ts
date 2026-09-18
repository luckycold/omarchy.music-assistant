import {createSpike, type SpikeConfig} from './session';
declare global { interface Window {MA_SPIKE_CONFIG?: SpikeConfig; maSpike: ReturnType<typeof createSpike>;} }
const config = window.MA_SPIKE_CONFIG;
delete window.MA_SPIKE_CONFIG;
// Do not touch storage until connecting; preserve a deterministic, side-effect-free initial page.
const storage = {getItem:(k:string)=>window.localStorage.getItem(k),setItem:(k:string,v:string)=>window.localStorage.setItem(k,v),removeItem:(k:string)=>window.localStorage.removeItem(k)};
window.maSpike = createSpike(config ?? {token:'',remoteId:'',signalingUrl:''}, {storage});
const render = () => {document.getElementById('status')!.textContent=JSON.stringify(window.maSpike.status(),null,2);};
document.getElementById('connect')!.addEventListener('click',()=>{void window.maSpike.connect().catch(()=>{}).finally(render);});
document.getElementById('disconnect')!.addEventListener('click',()=>{window.maSpike.disconnect();render();});
document.getElementById('test')!.addEventListener('click',()=>{void window.maSpike.playSilentTest().catch(()=>{}).finally(render);});
window.addEventListener('beforeunload',()=>window.maSpike.disconnect());
setInterval(render,500);render();
