import express from 'express';
import {fileURLToPath} from 'node:url';
import {Pipeline, createGateStore} from './gate';
import {Step, stepProblem, summarizeStep} from './pipeline';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};
const rows: RecordRow[] = [
  {id:'alpha',name:'Primary transform runs',revision:3,content:'transform runs: alpha\nstate: active',updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary transform runs',revision:5,content:'transform runs: beta\nstate: review',updatedAt:new Date(1000).toISOString()},
];

function pipelineDto(pipeline: Pipeline){
  return {
    id: pipeline.id,
    name: pipeline.name,
    revision: pipeline.revision,
    schemaRevision: pipeline.schema.revision,
    steps: pipeline.steps.map((step: Step, index: number) => {
      const summary = summarizeStep(step, index);
      return {
        ...step,
        reads: summary.reads,
        writes: summary.writes.map(write => ({raw: write.raw, dynamic: write.dynamic})),
      };
    }),
    schema: {id: pipeline.schema.id, revision: pipeline.schema.revision, node: pipeline.schema.node},
    updatedAt: pipeline.updatedAt,
  };
}

export function createApp(){
  const app=express();
  const gate=createGateStore();
  const findPipeline=(id:string)=>gate.pipelines.find(pipeline=>pipeline.id===id);

  app.use(express.json({limit:'1mb'}));
  app.get('/api/bootstrap',(_req,res)=>res.json({family:"migration-mapping",count:rows.length}));
  app.get('/api/mappings',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/mappings/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/mappings/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/mappings/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});

  // Target schema gate
  app.get('/api/pipelines',(_req,res)=>res.json(gate.pipelines.map(pipeline=>({id:pipeline.id,name:pipeline.name,revision:pipeline.revision,schemaRevision:pipeline.schema.revision,stepCount:pipeline.steps.length,sampleCount:pipeline.samples.length}))));
  app.get('/api/pipelines/:id',(req,res)=>{const pipeline=findPipeline(req.params.id);if(!pipeline)return res.status(404).json({error:'not_found'});res.json(pipelineDto(pipeline))});
  app.get('/api/pipelines/:id/samples',(req,res)=>{const pipeline=findPipeline(req.params.id);if(!pipeline)return res.status(404).json({error:'not_found'});res.json(pipeline.samples)});

  app.put('/api/pipelines/:id/steps/:stepId',(req,res)=>{
    const pipeline=findPipeline(req.params.id);
    if(!pipeline)return res.status(404).json({error:'not_found'});
    if(req.body?.revision!==pipeline.revision)return res.status(409).json({error:'revision_conflict',current:{revision:pipeline.revision}});
    const step=req.body?.step;
    const problem=stepProblem(step);
    if(problem)return res.status(400).json({error:'invalid_step',message:problem});
    if(step.id!==req.params.stepId)return res.status(400).json({error:'invalid_step',message:'step.id must match the URL'});
    const index=pipeline.steps.findIndex(existing=>existing.id===step.id);
    if(index<0)return res.status(404).json({error:'not_found'});
    pipeline.steps[index]=step as Step;
    pipeline.revision+=1;
    pipeline.updatedAt=new Date().toISOString();
    const invalidated=gate.invalidate(pipeline.id);
    res.json({pipeline:pipelineDto(pipeline),invalidated});
  });

  app.put('/api/pipelines/:id/schema',(req,res)=>{
    const pipeline=findPipeline(req.params.id);
    if(!pipeline)return res.status(404).json({error:'not_found'});
    if(req.body?.revision!==pipeline.schema.revision)return res.status(409).json({error:'revision_conflict',current:{revision:pipeline.schema.revision}});
    const node=req.body?.schema;
    if(node===null||typeof node!=='object'||Array.isArray(node))return res.status(400).json({error:'invalid_schema',message:'schema must be an object'});
    pipeline.schema.node=node;
    pipeline.schema.revision+=1;
    pipeline.updatedAt=new Date().toISOString();
    const invalidated=gate.invalidate(pipeline.id);
    res.json({pipeline:pipelineDto(pipeline),invalidated});
  });

  app.post('/api/pipelines/:id/validate',(req,res)=>{
    const pipeline=findPipeline(req.params.id);
    if(!pipeline)return res.status(404).json({error:'not_found'});
    const ids=req.body?.sampleIds;
    const samples=Array.isArray(ids)?pipeline.samples.filter(sample=>ids.includes(sample.id)):pipeline.samples;
    res.json({
      pipelineId:pipeline.id,
      pipelineRevision:pipeline.revision,
      schemaRevision:pipeline.schema.revision,
      validatedAt:new Date().toISOString(),
      results:gate.validate(pipeline,samples),
    });
  });

  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
