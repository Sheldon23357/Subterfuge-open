/** One serialized public view per console. Polling only reads the published
 * body; progress updates coalesce independently of the number of clients. */
export class PublishedConsoleStatus {
  private body:string|null=null;
  private activeUntil=0;
  private publishedAt=0;
  private readonly timer:ReturnType<typeof setInterval>;
  constructor(private readonly build:()=>unknown){
    this.publish();
    this.timer=setInterval(()=>{if(Date.now()<this.activeUntil)this.publish();},500).unref();
  }
  publish(){
    this.publishedAt=Date.now();
    try{this.body=JSON.stringify(this.build());}catch{this.body=null;}
  }
  read(){const now=Date.now();if(now>=this.activeUntil&&now-this.publishedAt>=500)this.publish();this.activeUntil=now+2000;return this.body;}
  close(){clearInterval(this.timer);}
}
