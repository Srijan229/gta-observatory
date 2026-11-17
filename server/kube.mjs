import fs from 'node:fs';
import https from 'node:https';
const account='/var/run/secrets/kubernetes.io/serviceaccount/';
export function kube(path, method='GET', body) {
  return new Promise((resolve,reject)=>{
    const req=https.request({hostname:process.env.KUBERNETES_SERVICE_HOST,port:process.env.KUBERNETES_SERVICE_PORT_HTTPS||443,path,method,ca:fs.readFileSync(account+'ca.crt'),headers:{Authorization:'Bearer '+fs.readFileSync(account+'token','utf8').trim(),...(body?{'Content-Type':'application/json'}:{})}},res=>{
      let text='';res.on('data',chunk=>{text+=chunk;if(text.length>4e6)req.destroy(Error('Kubernetes response too large'));});
      res.on('end',()=>{if(res.statusCode<200||res.statusCode>=300)return reject(Error(`Kubernetes ${res.statusCode}`));try{resolve(JSON.parse(text||'{}'));}catch{resolve(text);}});
    });req.setTimeout(5000,()=>req.destroy(Error('Kubernetes timeout')));req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
}
