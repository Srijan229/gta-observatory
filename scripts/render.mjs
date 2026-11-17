import fs from 'node:fs';
fs.mkdirSync('.local',{recursive:true});
const ns='observability';
const rules=[
  {apiGroups:[''],resources:['pods','pods/log','services','events'],verbs:['get','list']},
  {apiGroups:['apps'],resources:['deployments','replicasets'],verbs:['get','list']},
  {apiGroups:['batch'],resources:['jobs','cronjobs'],verbs:['get','list']},
  {apiGroups:['autoscaling'],resources:['horizontalpodautoscalers'],verbs:['get','list']},
  {apiGroups:['portfolio.gta.dev'],resources:['applicationscalingpolicies'],verbs:['get','list']},
  {apiGroups:['metrics.k8s.io'],resources:['pods'],verbs:['get','list']}
];
const items=[
  {apiVersion:'v1',kind:'Namespace',metadata:{name:ns}},
  {apiVersion:'v1',kind:'ServiceAccount',metadata:{name:'observatory',namespace:ns}},
  {apiVersion:'rbac.authorization.k8s.io/v1',kind:'Role',metadata:{name:'gta-observatory-reader',namespace:'gta-demo'},rules},
  {apiVersion:'rbac.authorization.k8s.io/v1',kind:'RoleBinding',metadata:{name:'gta-observatory-reader',namespace:'gta-demo'},roleRef:{apiGroup:'rbac.authorization.k8s.io',kind:'Role',name:'gta-observatory-reader'},subjects:[{kind:'ServiceAccount',name:'observatory',namespace:ns}]},
  {apiVersion:'rbac.authorization.k8s.io/v1',kind:'ClusterRole',metadata:{name:'gta-observatory-nodes'},rules:[{apiGroups:[''],resources:['nodes'],verbs:['get','list']},{apiGroups:['metrics.k8s.io'],resources:['nodes'],verbs:['get','list']}]},
  {apiVersion:'rbac.authorization.k8s.io/v1',kind:'ClusterRoleBinding',metadata:{name:'gta-observatory-nodes'},roleRef:{apiGroup:'rbac.authorization.k8s.io',kind:'ClusterRole',name:'gta-observatory-nodes'},subjects:[{kind:'ServiceAccount',name:'observatory',namespace:ns}]},
  {apiVersion:'rbac.authorization.k8s.io/v1',kind:'Role',metadata:{name:'observatory-load',namespace:ns},rules:[{apiGroups:['batch'],resources:['jobs'],verbs:['get','list','create','delete']},{apiGroups:[''],resources:['pods','pods/log'],verbs:['get','list']}]},
  {apiVersion:'rbac.authorization.k8s.io/v1',kind:'RoleBinding',metadata:{name:'observatory-load',namespace:ns},roleRef:{apiGroup:'rbac.authorization.k8s.io',kind:'Role',name:'observatory-load'},subjects:[{kind:'ServiceAccount',name:'observatory',namespace:ns}]},
  {apiVersion:'v1',kind:'PersistentVolumeClaim',metadata:{name:'observatory-history',namespace:ns},spec:{accessModes:['ReadWriteOnce'],resources:{requests:{storage:'128Mi'}}}},
  {apiVersion:'apps/v1',kind:'Deployment',metadata:{name:'observatory',namespace:ns},spec:{replicas:1,strategy:{type:'Recreate'},selector:{matchLabels:{app:'gta-observatory'}},template:{metadata:{labels:{app:'gta-observatory'}},spec:{serviceAccountName:'observatory',securityContext:{runAsNonRoot:true,runAsUser:1000,runAsGroup:1000,fsGroup:1000,seccompProfile:{type:'RuntimeDefault'}},containers:[{name:'observatory',image:'gta-observatory:demo',imagePullPolicy:'IfNotPresent',ports:[{containerPort:8090}],resources:{requests:{cpu:'75m',memory:'96Mi'},limits:{cpu:'400m',memory:'256Mi'}},securityContext:{allowPrivilegeEscalation:false,capabilities:{drop:['ALL']}},volumeMounts:[{name:'history',mountPath:'/data'}],startupProbe:{httpGet:{path:'/healthz',port:8090},periodSeconds:5,timeoutSeconds:5,failureThreshold:36},readinessProbe:{httpGet:{path:'/readyz',port:8090},periodSeconds:5,timeoutSeconds:5},livenessProbe:{httpGet:{path:'/healthz',port:8090},periodSeconds:10,timeoutSeconds:5,failureThreshold:6}}],volumes:[{name:'history',persistentVolumeClaim:{claimName:'observatory-history'}}]}}}},
  {apiVersion:'v1',kind:'Service',metadata:{name:'observatory',namespace:ns},spec:{type:'ClusterIP',selector:{app:'gta-observatory'},ports:[{port:8090,targetPort:8090}]}},
  {apiVersion:'v1',kind:'ResourceQuota',metadata:{name:'observatory-budget',namespace:ns},spec:{hard:{pods:'4','requests.cpu':'500m','requests.memory':'512Mi','limits.cpu':'1500m','limits.memory':'768Mi'}}}
];
fs.writeFileSync('.local/resources.json',JSON.stringify({apiVersion:'v1',kind:'List',items},null,2));
console.log('Rendered observability namespace; app access is read-only, load Jobs are isolated.');
