import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { compileMarkdown, compileMarkdownFile } from '../tools/authoring/compile-markdown.mjs';
import { compileStory } from '../packages/content/dist/index.js';
import { createSession } from '../packages/core/dist/index.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const example=resolve(root,'examples/minimal-markdown');
const [source,portraits,stage,config]=await Promise.all(['story.md','portraits.json','stage.json','compiler.json'].map(async file=>{
 const text=await readFile(resolve(example,file),'utf8'); return file.endsWith('.json')?JSON.parse(text):text;
}));
const options={...config,...config.metadata,portraits,stage};
const compile=(text=source,overrides={})=>compileMarkdown(text,{...options,...overrides});
const finish=(story,number)=>{
 const session=createSession(compileStory(story),{seed:42});let result=session.start(),steps=0;
 while(result.view.awaiting!=='ended'){
  assert.ok(++steps<100,'bounded fresh-session route');
  result=result.view.awaiting==='continue'?session.dispatch({type:'continue'}):session.dispatch({type:'choose',optionId:'o'+number});
 }
 return session.snapshot().state;
};

test('Markdown example compiles both legal endings and explicit feedback/stage',()=>{
 const story=compile();assert.equal(story.id,'minimal-markdown');assert.equal(story.nodes.filter(n=>n.type==='end').length,2);
 const ready=finish(story,1),missed=finish(story,2);
 assert.equal(ready.nodeId,'ready:end');assert.equal(ready.variables.patience,1);assert.ok(ready.tags.includes('noted'));
 assert.equal(missed.nodeId,'missed:end');assert.equal(missed.variables.patience,0);assert.deepEqual(missed.tags,[]);
 assert.equal(ready.visits['intro:s1:c:feedback-a'],1);assert.equal(missed.visits['intro:s1:c:feedback-a'],undefined);
 const lines=story.nodes.find(n=>n.id==='intro:s0').lines;
 assert.deepEqual(lines[1].stage.slots,{left:'traveler',right:'guide'});
 assert.equal(lines[1].speaker,'站务员');assert.equal(lines[1].stage.focus,'guide');assert.equal(lines[2].stage.focus,'traveler');
});

test('source-only compilation emits empty authoritative stages without cast guessing',()=>{
 const story=compileMarkdown('# 故事\n## start 开场\n【某人】「你好」\n【结局】完成',{id:'plain'});
 assert.equal(story.title,'故事');assert.deepEqual(story.nodes.find(n=>n.type==='dialogue').lines[0].stage.present,[]);
 assert.equal(finish(story,1).nodeId,'start:end');
});

test('aliases are opt-in, and state references/deltas/fallbacks are validated',()=>{
 assert.throws(()=>compile(source,{tagAliases:{}}),/Unknown condition tag/);
 assert.throws(()=>compile(source.replace('patience+1','patence+1')),/Unknown variable/);
 assert.throws(()=>compile(source.replace('patience+1','patience++1')),/Invalid variable delta/);
 assert.throws(()=>compile(source.replace('[*] → missed','')),/explicit \[\*\] fallback/);
 assert.throws(()=>compile(source,{characterAliases:{attendant:'other',other:'attendant'}}),/Cyclic character alias/);
 assert.throws(()=>compile(source.replace('起始章节 intro','起始章节 absent')),/Unknown start chapter/);
});

test('explicit outgoing last chapter has no synthetic ending',()=>{
 const story=compileMarkdown('# 测试\n## 全局设定\n起始章节 jump\n## done 完成\n【结局】完成\n## jump 跳转\n【分支】\n[*] → done',{id:'jump'});
 assert.equal(story.nodes.filter(n=>n.type==='end').length,1);assert.equal(finish(story,1).nodeId,'done:end');
});

test('stage replacement frees slots, while duplicate/negative slots reject',()=>{
 const replacement=structuredClone(stage);
 replacement.chapters.intro.nodes['intro:s0']={events:{1:{present:['attendant'],focus:'attendant'}}};
 assert.deepEqual(compile(source,{stage:replacement}).nodes.find(n=>n.id==='intro:s0').lines[1].stage.slots,{right:'guide'});
 const duplicate=structuredClone(stage);duplicate.chapters.intro.default.slots={left:'traveler',right:'traveler'};
 assert.throws(()=>compile(source,{stage:duplicate}),/Duplicate stage slot/);
 const negative=structuredClone(stage);negative.chapters.intro.nodes['intro:s0']={events:{'-1':{}}};
 assert.throws(()=>compile(source,{stage:negative}),/Unknown stage line index/);
});

test('file and CLI compilation use explicit/config-relative paths and reject missing assets before output',async()=>{
 const temp=await mkdtemp(resolve(tmpdir(),'markdown-compiler-'));
 try {
  const out=resolve(temp,'cli.json');
  const result=spawnSync(process.execPath,[resolve(root,'tools/authoring/compile-markdown.mjs'),'--config',resolve(example,'compiler.json'),'--out',out,'--id','overridden','--version','2'],{cwd:temp,encoding:'utf8',timeout:5000});
  assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
  const story=JSON.parse(await readFile(out,'utf8'));assert.equal(story.id,'overridden');assert.equal(story.version,'2');assert.equal(finish(story,1).nodeId,'ready:end');
  const manifest=resolve(temp,'portraits.json');const missing=structuredClone(portraits);missing.characters.guide.portrait='sprites/missing.webp';await writeFile(manifest,JSON.stringify(missing));
  const broken=resolve(temp,'broken.json');await assert.rejects(compileMarkdownFile({...config,...config.metadata,source:resolve(example,'story.md'),portraits:manifest,stage:resolve(example,'stage.json'),out:broken}),/ENOENT/);await assert.rejects(access(broken));
  const unsafe=structuredClone(portraits);unsafe.characters.guide.portrait='../private.png';assert.throws(()=>compile(source,{portraits:unsafe}),/local relative raster asset/);
 } finally {await rm(temp,{recursive:true,force:true});}
});
