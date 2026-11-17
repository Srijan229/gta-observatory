export function cpu(value) {
  if (value == null) return null;
  const match = String(value).match(/^([\d.]+)(n|u|m)?$/);
  if (!match) return null;
  return Number(match[1]) * ({n:1e-6,u:1e-3,m:1,'':1000}[match[2] || '']);
}
export function memory(value) {
  if (value == null) return null;
  const match = String(value).match(/^([\d.]+)(Ki|Mi|Gi|Ti|K|M|G|T)?$/);
  if (!match) return null;
  return Number(match[1]) * ({Ki:1024,Mi:1024**2,Gi:1024**3,Ti:1024**4,K:1e3,M:1e6,G:1e9,T:1e12,'':1}[match[2] || '']);
}
export function loadConfig(input) {
  const limits = {rps:[1,40],concurrency:[1,12],duration:[10,120]};
  const result = {};
  for (const [key,[min,max]] of Object.entries(limits)) {
    if (!Number.isInteger(input[key]) || input[key] < min || input[key] > max) throw Error(`${key} must be an integer from ${min} to ${max}`);
    result[key] = input[key];
  }
  return result;
}
export function deltaTelemetry(previous, current, seconds) {
  if (!previous || seconds <= 0) return null;
  let requests=0, errors=0, ms=0, observed=0;
  const histogram=Array(9).fill(0);
  for (const item of current) {
    const before=previous.find(p => p.pod===item.pod && p.startedAt===item.startedAt);
    if (!before || item.requests < before.requests) continue;
    observed++;
    requests+=item.requests-before.requests; errors+=item.errors-before.errors; ms+=item.totalMs-before.totalMs;
    item.histogram.forEach((v,i)=>histogram[i]+=Math.max(0,v-before.histogram[i]));
  }
  if (!observed) return null;
  const target=Math.ceil(requests*.95); let sum=0, p95=null;
  if (requests) for (let i=0;i<histogram.length;i++) {sum+=histogram[i];if(sum>=target){p95=[5,10,25,50,100,250,500,1000,null][i];break;}}
  return {rps:requests/seconds,requests,errors,errorPercent:requests?errors/requests*100:0,meanMs:requests?ms/requests:null,p95UpperMs:p95,overOneSecond:requests>0&&p95===null};
}
