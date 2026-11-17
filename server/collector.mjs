import fs from 'node:fs';
import {kube} from './kube.mjs';
import {cpu,memory,deltaTelemetry} from './model.mjs';
const base='/api/v1/namespaces/gta-demo';
let previousTelemetry=null,previousTime=0;
const spans=new Map(),timeline=[];
let lastFingerprint='';
export let snapshot={at:null,errors:['Waiting for first collection'],pods:[],nodes:[],deployments:[],events:[],traces:[],alerts:[],history:[],timeline:[]};
let history=[];
try{history=JSON.parse(fs.readFileSync('/data/history.json','utf8')).slice(-720);}catch{}
async function json(url){const r=await fetch(url,{signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error('Probe '+r.status);return r.json();}
export async function collect(){
  const errors=[];
  const paths={pods:base+'/pods',services:base+'/services',events:base+'/events',deployments:'/apis/apps/v1/namespaces/gta-demo/deployments',jobs:'/apis/batch/v1/namespaces/gta-demo/jobs',cronjobs:'/apis/batch/v1/namespaces/gta-demo/cronjobs',hpas:'/apis/autoscaling/v2/namespaces/gta-demo/horizontalpodautoscalers',policies:'/apis/portfolio.gta.dev/v1alpha1/namespaces/gta-demo/applicationscalingpolicies',podMetrics:'/apis/metrics.k8s.io/v1beta1/namespaces/gta-demo/pods',nodes:'/api/v1/nodes',nodeMetrics:'/apis/metrics.k8s.io/v1beta1/nodes'};
  const data={};
  await Promise.all(Object.entries(paths).map(async([key,path])=>{try{data[key]=(await kube(path)).items||[];}catch(e){data[key]=[];errors.push(`${key}: ${e.message}`);}}));
  const now=Date.now();
  const pods=data.pods.map(p=>{
    const metric=data.podMetrics.find(m=>m.metadata.name===p.metadata.name);
    const states=[...(p.status.initContainerStatuses||[]),...(p.status.containerStatuses||[])];
    const reason=states.find(s=>s.state?.waiting)?.state.waiting.reason || (p.metadata.deletionTimestamp?'Terminating':p.status.phase);
    return {name:p.metadata.name,app:p.metadata.labels?.app||'job',phase:reason,ready:(p.status.containerStatuses||[]).filter(s=>s.ready).length,total:p.spec.containers.length,restarts:states.reduce((n,s)=>n+s.restartCount,0),cpu:metric?metric.containers.reduce((n,c)=>n+cpu(c.usage.cpu),0):null,memory:metric?metric.containers.reduce((n,c)=>n+memory(c.usage.memory),0):null,requestCpu:p.spec.containers.reduce((n,c)=>n+(cpu(c.resources?.requests?.cpu)||0),0),limitCpu:p.spec.containers.reduce((n,c)=>n+(cpu(c.resources?.limits?.cpu)||0),0),limitMemory:p.spec.containers.reduce((n,c)=>n+(memory(c.resources?.limits?.memory)||0),0),node:p.spec.nodeName,startedAt:p.status.startTime};
  });
  const telemetry=[],traceErrors=[];
  await Promise.all(data.pods.filter(p=>['frontend','backend'].includes(p.metadata.labels?.app)&&p.status.podIP&&p.status.phase==='Running'&&!p.metadata.deletionTimestamp).map(async p=>{
    const component=p.metadata.labels.app;
    try{const value=await json(`http://${p.status.podIP}:${component==='backend'?3002:8082}/telemetry`);telemetry.push({...value,component});for(const span of value.spans||[])if(!spans.has(span.spanId))spans.set(span.spanId,span);}catch{traceErrors.push(`${p.metadata.name}: telemetry unavailable`);}
  }));
  for(const [key,span] of spans) if(span.start<now-15*60e3)spans.delete(key);
  while(spans.size>2500)spans.delete(spans.keys().next().value);
  const flow={frontend:null,backend:null,database:null,signal:null};
  await Promise.all([
    ['frontend','http://frontend.gta-demo.svc:8080/healthz'],['backend','http://backend.gta-demo.svc:3001/health'],['database','http://backend.gta-demo.svc:3002/readyz']
  ].map(async([key,url])=>{const start=performance.now();try{const r=await fetch(url,{signal:AbortSignal.timeout(3000)});await r.text();flow[key]={ok:r.ok,ms:performance.now()-start,checkedAt:now};}catch{flow[key]={ok:false,ms:null,checkedAt:now};}}));
  try{flow.signal=await json('http://backend.gta-demo.svc:3002/scaling-signal');}catch{errors.push('Application availability signal unavailable');}
  const deployments=data.deployments.map(d=>({name:d.metadata.name,desired:d.spec.replicas||0,ready:d.status.readyReplicas||0,available:d.status.availableReplicas||0}));
  const hpa=data.hpas.find(h=>h.metadata.name==='backend');
  const hpaView=hpa?{min:hpa.spec.minReplicas,max:hpa.spec.maxReplicas,current:hpa.status.currentReplicas??null,desired:hpa.status.desiredReplicas??null,cpuPercent:hpa.status.currentMetrics?.[0]?.resource?.current?.averageUtilization??null,target:60,conditions:hpa.status.conditions||[]}:null;
  const policy=data.policies.find(p=>p.metadata.name==='application-window');
  const policyView=policy?{spec:policy.spec,status:policy.status}:null;
  const metric=deltaTelemetry(previousTelemetry,telemetry.filter(t=>t.component==='frontend'),(now-previousTime)/1000);
  previousTelemetry=telemetry.filter(t=>t.component==='frontend');previousTime=now;
  const running=pods.filter(p=>p.phase==='Running');
  const cpuTotal=running.length&&running.every(p=>p.cpu!==null)?running.reduce((s,p)=>s+p.cpu,0):null;
  const memoryTotal=running.length&&running.every(p=>p.memory!==null)?running.reduce((s,p)=>s+p.memory,0):null;
  history.push({at:now,cpu:cpuTotal,memory:memoryTotal,rps:metric?.rps??null,meanMs:metric?.meanMs??null,errorPercent:metric?.errorPercent??null,replicas:deployments.find(d=>d.name==='backend')?.ready??null,min:hpaView?.min??null});history=history.slice(-720);
  const fingerprint=JSON.stringify([policyView?.status?.windowState,hpaView?.min,hpaView?.desired,deployments.find(d=>d.name==='backend')?.ready]);
  if(fingerprint!==lastFingerprint){timeline.unshift({at:now,state:policyView?.status?.windowState||'Unknown',minimum:hpaView?.min,desired:hpaView?.desired,ready:deployments.find(d=>d.name==='backend')?.ready});lastFingerprint=fingerprint;}timeline.splice(60);
  const tracesById=new Map();
  for(const span of spans.values()){if(!tracesById.has(span.traceId))tracesById.set(span.traceId,[]);tracesById.get(span.traceId).push(span);}
  const traces=[...tracesById].map(([id,items])=>{const root=items.find(s=>s.component==='frontend');return {id,start:Math.min(...items.map(s=>s.start)),durationMs:root?.durationMs??Math.max(...items.map(s=>s.durationMs)),status:root?.status??items[0].status,operation:root?.operation??items[0].operation,complete:!!root&&items.some(s=>s.component==='backend'),spans:items.sort((a,b)=>a.start-b.start)};}).sort((a,b)=>b.start-a.start).slice(0,60);
  const events=data.events.map(e=>({name:e.metadata.name,type:e.type,reason:e.reason,message:e.message,resource:e.involvedObject?.name,count:e.count||1,at:e.lastTimestamp||e.eventTime||e.metadata.creationTimestamp})).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)).slice(0,30);
  const alerts=[];
  for(const p of pods){if(p.phase!=='Succeeded'&&p.ready<p.total)alerts.push({severity:'warning',resource:p.name,message:`${p.phase}: ${p.ready}/${p.total} ready`});if(p.restarts)alerts.push({severity:'warning',resource:p.name,message:`${p.restarts} container restarts recorded`});if(p.limitMemory&&p.memory>p.limitMemory*.85)alerts.push({severity:'warning',resource:p.name,message:'Memory above 85% of limit'});}
  for(const [key,value] of Object.entries(flow))if(value&&value.ok===false)alerts.push({severity:'critical',resource:key,message:'Health probe failed'});
  if(policyView?.status?.conditions?.[0]?.status!=='True')alerts.push({severity:'warning',resource:'application-window',message:'Scaling policy is not ready'});
  for(const message of errors)alerts.push({severity:'warning',resource:'collector',message});
  if(metric?.errorPercent>5)alerts.push({severity:'critical',resource:'frontend',message:'Server error rate above 5% in latest interval'});
  const nodes=data.nodes.map(n=>{const m=data.nodeMetrics.find(v=>v.metadata.name===n.metadata.name);return {name:n.metadata.name,ready:n.status.conditions.find(c=>c.type==='Ready')?.status==='True',pressures:n.status.conditions.filter(c=>c.type.endsWith('Pressure')&&c.status==='True').map(c=>c.type),cpu:m?cpu(m.usage.cpu):null,memory:m?memory(m.usage.memory):null,cpuCapacity:cpu(n.status.allocatable.cpu),memoryCapacity:memory(n.status.allocatable.memory)};});
  for(const n of nodes)if(!n.ready||n.pressures.length)alerts.push({severity:'critical',resource:n.name,message:!n.ready?'Node is not ready':n.pressures.join(', ')});
  snapshot={at:now,errors,traceErrors,pods,nodes,deployments,services:data.services.map(s=>({name:s.metadata.name,type:s.spec.type,ports:s.spec.ports.map(p=>p.port)})),jobs:data.jobs.map(j=>({name:j.metadata.name,active:j.status.active||0,succeeded:j.status.succeeded||0,failed:j.status.failed||0})),cronjobs:data.cronjobs.map(j=>({name:j.metadata.name,suspended:j.spec.suspend,schedule:j.spec.schedule})),events,traces,alerts,history,timeline,metric,flow,hpa:hpaView,policy:policyView,totals:{cpu:cpuTotal,memory:memoryTotal},instrumentedPods:telemetry.length};
  try{fs.writeFileSync('/data/history.tmp',JSON.stringify(history));fs.renameSync('/data/history.tmp','/data/history.json');}catch{snapshot.errors.push('History could not be persisted');}
  return snapshot;
}
