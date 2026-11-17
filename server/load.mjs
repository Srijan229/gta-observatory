// Fixed read-only target: callers cannot supply a URL, method, headers, or body.
import {loadConfig} from './model.mjs';
const {rps,concurrency,duration}=loadConfig(JSON.parse(process.env.LOAD_CONFIG));
const end=Date.now()+duration*1000;
let active=0,sent=0,completed=0,failed=0,totalMs=0,skipped=0;
const pending=new Set();
function report(){console.log(JSON.stringify({sent,completed,failed,active,skipped,meanMs:completed?totalMs/completed:0,at:new Date().toISOString()}));}
const reporting=setInterval(report,5000);
const interval=setInterval(()=>{
  if(Date.now()>=end){clearInterval(interval);clearInterval(reporting);Promise.allSettled([...pending]).then(report);return;}
  if(active>=concurrency){skipped++;return;}
  active++;sent++;
  const start=performance.now();
  const task=fetch('http://frontend.gta-demo.svc:8080/api/applications',{signal:AbortSignal.timeout(4000)})
    .then(async r=>{await r.arrayBuffer();if(!r.ok)failed++;})
    .catch(()=>failed++).finally(()=>{completed++;active--;totalMs+=performance.now()-start;pending.delete(task);});
  pending.add(task);
},1000/rps);
