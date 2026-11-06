import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {createAssetServer} from '../tools/serve.mjs';
test('surface assignments reference named Colors; palette/pattern creation and non-destructive variants',async()=>{
  const root=await mkdtemp(new URL('./surface-fixture-',import.meta.url));await mkdir(root+'/models');
  const suite='materials/ymir-surfaces-v1/suite.json';
  const entries=[{id:'model',type:'model',name:'Two-part Model',manifest:'models/model.json'},
    {id:'prop',type:'prop',name:'Prop',schemaVersion:3,modelId:'model',manifest:'prop.json'},
    ...['silk','cotton'].map(id=>({id,type:'material',name:id,suiteManifest:suite,defaultColorId:'blue',parameters:{rough:.8,metal:0},manifest:id+'.json'})),
    ...['blue','white'].map((id,i)=>({id,type:'color',name:id,parameters:{pattern:-1,primary:i?[1,1,1]:[0,0,1]},manifest:id+'.json'}))];
  const model={type:'model',schemaVersion:2,id:'model',name:'Model',mesh:'mesh.bin',parts:[{id:'p1',slotId:'case'},{id:'p2',slotId:'trim'}],slots:[{id:'case',name:'Case',partIds:['p1']},{id:'trim',name:'Trim',partIds:['p2']}]};
  const prop={schemaVersion:3,type:'prop',id:'prop',name:'Prop',modelId:'model',model:'models/model.json',suiteManifest:suite,parts:[{partId:'p1'},{partId:'p2'}],slots:['case','trim'].map(slotId=>({slotId,material:{id:'silk'},color:{id:'blue'}})),defaultVariant:'original',variants:[{id:'original',name:'Original',slots:[],partMetadata:[]}]};
  await writeFile(root+'/models/model.json',JSON.stringify(model));await writeFile(root+'/models/mesh.bin','unchanged');await writeFile(root+'/prop.json',JSON.stringify(prop));
  for(const e of entries.filter(e=>!['model','prop'].includes(e.type)))await writeFile(root+'/'+e.manifest,JSON.stringify(e));
  await writeFile(root+'/catalog.json',JSON.stringify({assets:entries,textures:[],aliases:{}}));
  const server=createAssetServer({libraryRoot:root});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  const get=id=>fetch(base+'/api/asset?id='+id).then(r=>r.json());const {token}=await fetch(base+'/api/session').then(r=>r.json());
  const send=(url,method,body)=>fetch(base+url,{method,headers:{'content-type':'application/json','x-ymir-token':token},body:JSON.stringify(body)});
  try{
    let state=await get('prop');
    const change={revision:state.revision,variantId:'original',appearance:{target:'new-variant',slotId:'case',materialId:'cotton',colorId:'white',newVariantName:'Ivory Cotton'}};
    assert.equal((await send('/api/asset?id=prop','PUT',{...change,appearance:{...change.appearance,hex:'#ffffff'}})).status,400);
    assert.equal((await send('/api/asset?id=prop','PUT',{...change,appearance:{...change.appearance,colorId:'missing'}})).status,400);
    const result=await send('/api/asset?id=prop','PUT',change);assert.equal(result.status,200);const {variantId}=await result.json();
    let saved=JSON.parse(await readFile(root+'/prop.json','utf8'));assert.deepEqual(saved.parts,prop.parts);assert.deepEqual(saved.slots,prop.slots);assert.equal(saved.variants.length,2);
    assert.deepEqual(saved.variants.find(v=>v.id===variantId).slots,[{slotId:'case',material:{id:'cotton'},color:{id:'white'}}]);
    assert.equal(await readFile(root+'/models/mesh.bin','utf8'),'unchanged');
    state=await get('prop');assert.equal((await send('/api/asset?id=prop','PUT',{revision:state.revision,variantId:'original',appearance:{target:'prop',slotId:'trim',materialId:'cotton',colorId:'white'}})).status,200);
    saved=JSON.parse(await readFile(root+'/prop.json','utf8'));assert.equal(saved.slots.find(s=>s.slotId==='trim').color.id,'white');assert.deepEqual(saved.variants[0].slots,[]);
    const palette=await send('/api/colors','POST',{metadata:{name:'Forest Green',description:'Palette entry',tags:['nature']},generator:'solid',hex:'#228844'});assert.equal(palette.status,201);const green=(await palette.json()).id;
    const pattern=await send('/api/colors','POST',{metadata:{name:'Forest Houndstooth',description:'',tags:[]},generator:'houndstooth',primaryColorId:green,secondaryColorId:'white',scale:12});assert.equal(pattern.status,201);const patternId=(await pattern.json()).id;
    const c=JSON.parse(await readFile(root+'/catalog.json','utf8')).assets.find(a=>a.id===patternId);assert.deepEqual(c.palette,{primary:green,secondary:'white'});assert.equal(c.parameters.pattern,24);
    const greenState=await get(green);assert.equal((await send('/api/asset?id='+green,'DELETE',{revision:greenState.revision,scope:'color'})).status,409);
    const white=await get('white');assert.equal((await send('/api/asset?id=white','DELETE',{revision:white.revision,scope:'color'})).status,409);
    let material=await get('silk');assert.equal((await send('/api/asset?id=silk','PUT',{revision:material.revision,defaultColorId:'white'})).status,200);
    material=await get('silk');assert.equal(material.entry.defaultColorId,'white');
    state=await get('prop');assert.equal((await send('/api/asset?id=prop','PUT',{revision:state.revision,variantId:'original',appearance:{target:'variant',slotId:'case',materialId:'silk',colorId:''}})).status,200);
    saved=JSON.parse(await readFile(root+'/prop.json','utf8'));assert.deepEqual(saved.variants[0].slots.find(s=>s.slotId==='case'),{slotId:'case',material:{id:'silk'}});
    // Bulk operations validate every model slot before writing anything.
    state=await get('prop');const beforeBulk=await readFile(root+'/prop.json','utf8');
    const bulk={revision:state.revision,variantId:'original',appearance:{target:'new-variant',newVariantName:'Both Surfaces',slotIds:['case','trim'],materialId:'cotton',colorId:'white'}};
    assert.equal((await send('/api/asset?id=prop','PUT',{...bulk,appearance:{...bulk.appearance,slotIds:['case','missing']}})).status,400);
    assert.equal(await readFile(root+'/prop.json','utf8'),beforeBulk);
    assert.equal((await send('/api/asset?id=prop','PUT',bulk)).status,200);
    saved=JSON.parse(await readFile(root+'/prop.json','utf8'));const both=saved.variants.find(v=>v.name==='Both Surfaces');
    assert.equal(both.slots.length,2);assert.ok(both.slots.every(s=>s.material.id==='cotton'&&s.color.id==='white'));assert.deepEqual(saved.parts,prop.parts);
    // One atomic request can give different slots different Materials and Colors.
    state=await get('prop');const beforeMulti=await readFile(root+'/prop.json','utf8'),beforeMultiSlots=state.slots;
    const multi={revision:state.revision,variantId:'original',appearance:{target:'new-variant',newVariantName:'Split Surfaces',assignments:[
      {slotId:'case',materialId:'cotton',colorId:'white'},
      {slotId:'trim',materialId:'silk',colorId:''}
    ]}};
    const withAssignments=assignments=>({...multi,appearance:{...multi.appearance,assignments}});
    assert.equal((await send('/api/asset?id=prop','PUT',withAssignments([{slotId:'case',materialId:'cotton',colorId:'white'},{slotId:'trim',materialId:'silk',colorId:'missing'}]))).status,400);
    assert.equal((await send('/api/asset?id=prop','PUT',withAssignments([{slotId:'case',materialId:'missing',colorId:'white'},{slotId:'trim',materialId:'silk',colorId:''}]))).status,400);
    assert.equal((await send('/api/asset?id=prop','PUT',withAssignments([{slotId:'case',materialId:'cotton',colorId:'white'},{slotId:'case',materialId:'silk',colorId:''}]))).status,400);
    assert.equal(await readFile(root+'/prop.json','utf8'),beforeMulti);
    const multiResult=await send('/api/asset?id=prop','PUT',multi);assert.equal(multiResult.status,200);const multiId=(await multiResult.json()).variantId;
    saved=JSON.parse(await readFile(root+'/prop.json','utf8'));const split=saved.variants.find(v=>v.id===multiId);
    assert.equal(split.name,'Split Surfaces');
    assert.deepEqual(split.slots,[{slotId:'case',material:{id:'cotton'},color:{id:'white'}},{slotId:'trim',material:{id:'silk'}}]);
    assert.deepEqual(saved.slots,beforeMultiSlots);assert.deepEqual(saved.parts,prop.parts);
  }finally{await new Promise(r=>server.close(r));await rm(root,{recursive:true});}
});
