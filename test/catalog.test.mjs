import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {createAssetServer} from '../tools/serve.mjs';
test('catalog IDs are unique and all manifests exist',async()=>{
  const base=new URL('../',import.meta.url),catalog=JSON.parse(await readFile(new URL('catalog.json',base)));
  assert.equal(catalog.schemaVersion,1);const ids=new Set();
  for(const entry of catalog.assets){
    assert.ok(!ids.has(entry.id));ids.add(entry.id);const manifest=new URL(entry.manifest,base);await access(manifest);
    if(entry.type==='model'){
      const model=JSON.parse(await readFile(manifest,'utf8'));assert.equal(model.type,'model');assert.equal(model.schemaVersion,2);
      await access(new URL(model.mesh,manifest));
    }
  }
  const pruningURL=new URL('prune-superseded.json',base);
  try{await access(pruningURL);}catch{return;}
  assert.equal(catalog.textures.length,0);
  assert.ok(catalog.assets.some(a=>a.type==='color'&&a.name==='Solid Blue'));
  assert.ok(catalog.assets.filter(a=>a.type==='material').every(a=>!('color' in a.parameters)));
  const colorIds=new Set(catalog.assets.filter(a=>a.type==='color').map(a=>a.id));
  for(const m of catalog.assets.filter(a=>a.type==='material'))assert.ok(colorIds.has(m.defaultColorId),`Missing default Color for ${m.name}`);
  const colorNames=catalog.assets.filter(a=>a.type==='color').map(a=>a.name);
  assert.equal(new Set(colorNames).size,colorNames.length,'Initial Color dropdown labels should not repeat');
  assert.ok(catalog.assets.filter(a=>a.type==='color').every(a=>!/(fine grain|fine weave|fibres|nap mottle)/i.test(a.name)));
  const pruning=JSON.parse(await readFile(pruningURL));
  for(const id of pruning.removedIds)assert.ok(!ids.has(id),`Superseded asset still listed ${id}`);
  const consolidation=JSON.parse(await readFile(new URL('consolidation.json',base)));
  const consolidated=new Set(consolidation.groups.flatMap(g=>g.oldIds));
  for(const id of pruning.retainedV3OnlyIds)assert.ok(ids.has(id)||consolidated.has(id),`Lost unique v3 prop ${id}`);
  assert.equal(catalog.assets.filter(a=>a.supersededBy).length,0);
  for(const entry of catalog.assets.filter(a=>a.type==='prop')){
    const asset=JSON.parse(await readFile(new URL(entry.manifest,base)));
    if(asset.schemaVersion>=2){
      assert.ok(ids.has(asset.modelId));assert.equal(asset.nodes,undefined);assert.equal(asset.mesh,undefined);
      const model=JSON.parse(await readFile(new URL(asset.model,base)));
      assert.equal(model.type,'model');assert.equal(model.id,asset.modelId);
      for(const part of model.parts)assert.equal(part.material,undefined);
      if(asset.schemaVersion===3){
        for(const part of model.parts)assert.ok(model.slots.some(s=>s.id===part.slotId&&s.partIds.includes(part.id)));
        for(const slot of [...asset.slots,...asset.variants.flatMap(v=>v.slots)]){assert.ok(ids.has(slot.material.id));assert.ok(ids.has(slot.color.id));assert.equal(slot.material.parameters?.color,undefined);}
      }else for(const variant of asset.variants){assert.equal(variant.bindings.length,asset.parts.length);for(const b of variant.bindings){assert.ok(ids.has(b.material.id));assert.ok(model.parts.some(p=>p.id===b.partId));}}
    }else for(const n of asset.nodes)assert.ok(ids.has(n.material.id),`Broken material ${n.material.id}`);
  }
});
test('browser server serves only public Ymir/Trinity files',async()=>{
  const server=createAssetServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{const base=`http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base+'/ymir/browser/')).status,200);
    assert.equal((await fetch(base+'/trinity/dist/trinity-1.2.3.mjs')).status,200);
    for(const path of ['/ymir/.git/config','/ymir/%2e%2e%2fAGENTS.md','/unknown/'])assert.equal((await fetch(base+path)).status,404);
  }finally{await new Promise(r=>server.close(r));}
});
