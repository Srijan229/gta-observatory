import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {snapshot,collect} from './collector.mjs';
import {kube} from './kube.mjs';
import {loadConfig} from './model.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const csrf=randomBytes(32).toString('hex'), clients=new Set();
const loadBase='/apis/batch/v1/namespaces/observability/jobs';
let collecting=false,controlBusy=false, lastCollection=0;
function send(res,status,value){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));}
async function loads(){const result=await kube(loadBase+'?labelSelector=app%3Dgta-observatory-load');return result.items.map(j=>({name:j.metadata.name,active:j.status.active||0,finished:!!j.status.completionTime||!!j.status.failed,createdAt:j.metadata.creationTimestamp,config:JSON.parse(j.metadata.annotations?.['gta.dev/load']||'{}')})).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));}
async function body(req){let text='';for await(const chunk of req){text+=chunk;if(text.length>4096)throw Error('Request too large');}return JSON.parse(text||'{}');}
function loadJob(config){return {apiVersion:'batch/v1',kind:'Job',metadata:{name:'gta-load-'+Date.now(),namespace:'observability',labels:{app:'gta-observatory-load'},annotations:{'gta.dev/load':JSON.stringify(config)}},spec:{backoffLimit:0,activeDeadlineSeconds:config.duration+30,ttlSecondsAfterFinished:300,template:{metadata:{labels:{app:'gta-observatory-load'}},spec:{restartPolicy:'Never',automountServiceAccountToken:false,securityContext:{runAsNonRoot:true,runAsUser:1000,runAsGroup:1000,seccompProfile:{type:'RuntimeDefault'}},containers:[{name:'load',image:'gta-observatory:demo',imagePullPolicy:'IfNotPresent',command:['node','server/load.mjs'],env:[{name:'LOAD_CONFIG',value:JSON.stringify(config)}],resources:{requests:{cpu:'50m',memory:'48Mi'},limits:{cpu:'300m',memory:'128Mi'}},securityContext:{allowPrivilegeEscalation:false,capabilities:{drop:['ALL']}}}]}}}};}
async function poll(){if(collecting)return;collecting=true;try{await collect();lastCollection=Date.now();const message='data: '+JSON.stringify(snapshot)+'\n\n';for(const res of clients){if(res.writableLength>1e6){res.destroy();clients.delete(res);}else res.write(message);}}catch{console.error('Collection failed; preserving previous snapshot');}finally{collecting=false;}}
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  const url=new URL(req.url,'http://localhost');
  try{
    if(req.method==='POST'){
      if(req.headers['x-observatory-token']!==csrf || !req.headers['content-type']?.startsWith('application/json'))return send(res,403,{error:'Invalid control request'});
      if(req.headers.origin && new URL(req.headers.origin).host!==req.headers.host)return send(res,403,{error:'Origin rejected'});
    }
    if(url.pathname==='/healthz')return send(res,200,{ok:true});
    if(url.pathname==='/readyz')return send(res,lastCollection&&Date.now()-lastCollection<30000?200:503,{lastCollection});
    if(url.pathname==='/api/session'&&req.method==='GET')return send(res,200,{token:csrf});
    if(url.pathname==='/api/snapshot'&&req.method==='GET')return send(res,200,snapshot);
    if(url.pathname==='/api/stream'&&req.method==='GET'){
      res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive'});res.write('data: '+JSON.stringify(snapshot)+'\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;
    }
    if(url.pathname==='/api/load'&&req.method==='GET'){
      const jobs=await loads();
      if(jobs[0])try{
        const pods=await kube('/api/v1/namespaces/observability/pods?labelSelector=job-name%3D'+encodeURIComponent(jobs[0].name));
        const pod=pods.items[0];
        if(pod){const text=await kube('/api/v1/namespaces/observability/pods/'+encodeURIComponent(pod.metadata.name)+'/log?tailLines=1&limitBytes=2048');jobs[0].progress=typeof text==='string'?JSON.parse(text):text;}
      }catch{}
      return send(res,200,{jobs});
    }
    if(url.pathname==='/api/load'&&req.method==='POST'){
      if(controlBusy)return send(res,409,{error:'Another load control is in progress'});
      controlBusy=true;try{const config=loadConfig(await body(req));if((await loads()).some(j=>!j.finished))return send(res,409,{error:'A load run is already active'});const result=await kube(loadBase,'POST',loadJob(config));return send(res,201,{name:result.metadata.name,config});}finally{controlBusy=false;}
    }
    if(url.pathname==='/api/load/stop'&&req.method==='POST'){
      if(controlBusy)return send(res,409,{error:'Another load control is in progress'});
      controlBusy=true;try{for(const job of (await loads()).filter(j=>!j.finished)){if(/^gta-load-\d+$/.test(job.name))await kube(loadBase+'/'+job.name,'DELETE',{propagationPolicy:'Foreground'});}return send(res,200,{stopped:true});}finally{controlBusy=false;}
    }
    if(url.pathname==='/api/logs'&&req.method==='GET'){
      const name=url.searchParams.get('pod');if(!snapshot.pods.some(p=>p.name===name))return send(res,404,{error:'Select a monitored app pod'});
      const value=await kube('/api/v1/namespaces/gta-demo/pods/'+encodeURIComponent(name)+'/log?tailLines=60&limitBytes=16000');
      const text=String(value).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email]').replace(/postgres(?:ql)?:\/\/\S+/gi,'[database URL]').replace(/(Bearer\s+)\S+/gi,'$1[redacted]');return send(res,200,{text});
    }
    if(req.method!=='GET'&&req.method!=='HEAD')return send(res,405,{error:'Method not allowed'});
    const allowed={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
    if(!allowed[url.pathname])return send(res,404,{error:'Not found'});
    res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'text/html');fs.createReadStream(path.join(root,allowed[url.pathname])).pipe(res);
  }catch(e){send(res,400,{error:e.message});}
});
server.listen(8090,'0.0.0.0',()=>console.log('GTA Observatory listening on 8090'));
poll();const timer=setInterval(poll,5000);
process.on('SIGTERM',()=>{clearInterval(timer);for(const client of clients)client.end();server.close();});
