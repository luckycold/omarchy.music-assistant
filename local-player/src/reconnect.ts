interface Session{status():{ready:boolean};connect():Promise<unknown>;disconnect():void;health():Promise<void>}
export class ReconnectLoop {
 private stopped=true;private timer?:ReturnType<typeof setTimeout>;private failures=0;private generation=0;
 constructor(private session:Session,private update:()=>void,private options={minMs:1000,maxMs:30000,pollMs:5000}){}
 start(){if(!this.stopped)return;this.stopped=false;void this.tick(++this.generation);}
 stop(){this.stopped=true;this.generation++;clearTimeout(this.timer);this.session.disconnect();this.update();}
 private async tick(g:number){let delay=this.options.pollMs;try{if(this.session.status().ready)await this.session.health();else await this.session.connect();if(this.session.status().ready)this.failures=0;}catch{delay=Math.min(this.options.maxMs,this.options.minMs*2**Math.min(this.failures++,10));}finally{this.update();if(!this.stopped&&g===this.generation)this.timer=setTimeout(()=>void this.tick(g),delay);}}
}
