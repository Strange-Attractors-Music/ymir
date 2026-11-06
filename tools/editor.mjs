// Metadata-only editing. No caller-supplied paths, meshes, shaders or material parameters.
import {readFile,writeFile,rename,unlink,realpath,mkdir} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import path from 'node:path';
const json=file=>readFile(file,'utf8').then(JSON.parse);
const revision=asset=>createHash('sha256').update(JSON.stringify(asset)).digest('hex');
function metadata(input){
  if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['name','description','tags'].includes(k)))throw Object.assign(new Error('Only name, description and tags can be edited'),{status:400});
  if(typeof input.name!=='string'||!input.name.trim()||input.name.length>120)throw Object.assign(new Error('Name must contain 1–120 characters'),{status:400});
  if(typeof input.description!=='string'||input.description.length>4000)throw Object.assign(new Error('Description must be at most 4000 characters'),{status:400});
  if(!Array.isArray(input.tags)||input.tags.length>20||input.tags.some(t=>typeof t!=='string'||!t.trim()||t.length>60))throw Object.assign(new Error('Use at most 20 tags of 1–60 characters'),{status:400});
  return {name:input.name.trim(),description:input.description,tags:[...new Set(input.tags.map(t=>t.trim()))]};
}
async function atomic(file,value){const temp=file+'.edit-'+randomBytes(6).toString('hex');await writeFile(temp,JSON.stringify(value,null,2)+'\n');await rename(temp,file);}
export function createEditor(root){
  const token=randomBytes(32).toString('hex');let queue=Promise.resolve();
  async function safe(file){const base=await realpath(root),target=await realpath(path.resolve(root,file));if(!target.startsWith(base+path.sep)||path.relative(base,target).split(path.sep).some(p=>p.startsWith('.')))throw new Error('Asset outside library');return target;}
  async function assetFor(id){
    const catalog=await json(path.join(root,'catalog.json')),entry=catalog.assets.find(a=>a.id===id);
    if(!entry)throw Object.assign(new Error('Asset not found'),{status:404});
    const file=await safe(entry.manifest),asset=await json(file);return {catalog,entry,file,asset};
  }
  function response(res,status,value){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}
  return async function handle(req,res,url){
    if(!url.pathname.startsWith('/api/'))return false;
    try{
      // Guard local editing against cross-origin requests / DNS rebinding.
      const host=req.headers.host??'',origin=req.headers.origin;
      if(!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)||origin&&origin!==`http://${host}`)throw Object.assign(new Error('Local same-origin access required'),{status:403});
      if(url.pathname==='/api/session'&&req.method==='GET'){response(res,200,{token});return true;}
      const creatingColor=url.pathname==='/api/colors'&&req.method==='POST';
      if(url.pathname!=='/api/asset'&&!creatingColor)throw Object.assign(new Error('Not found'),{status:404});
      if(req.method==='GET'){
        const {catalog,entry,asset}=await assetFor(url.searchParams.get('id'));
        response(res,200,{entry,metadata:{name:asset.name,description:asset.description??'',tags:asset.tags??[]},
          dependents:catalog.assets.filter(a=>a.modelId===entry.id).map(a=>({id:a.id,name:a.name})),
          variants:(asset.variants??[]).map(v=>({id:v.id,name:v.name,description:v.description??'',tags:v.tags??[]})),
          slots:asset.slots??[],variantSlots:(asset.variants??[]).map(v=>({id:v.id,slots:v.slots??[]})),
          model:asset.model?await json(await safe(asset.model)):null,revision:revision(asset)});return true;
      }
      if(!['PUT','DELETE'].includes(req.method)&&!creatingColor)throw Object.assign(new Error('Method not allowed'),{status:405});
      if(req.headers['x-ymir-token']!==token)throw Object.assign(new Error('Missing editor session token'),{status:403});
      if(!req.headers['content-type']?.startsWith('application/json'))throw Object.assign(new Error('JSON required'),{status:415});
      let body='';for await(const chunk of req){body+=chunk;if(body.length>32768)throw Object.assign(new Error('Request too large'),{status:413});}
      const input=JSON.parse(body);
      if(creatingColor){
        const work=async()=>{
          if(Object.keys(input).some(k=>!['metadata','generator','hex','primaryColorId','secondaryColorId','scale'].includes(k)))throw Object.assign(new Error('Unexpected Color fields'),{status:400});
          const fields=metadata(input.metadata),catalog=await json(path.join(root,'catalog.json'));
          const patterns={solid:-1,checkerboard:23,houndstooth:24,stripes:25,marbling:5};
          if(!Object.hasOwn(patterns,input.generator))throw Object.assign(new Error('Unknown Color generator'),{status:400});
          let primary,secondary, palette;
          if(input.generator==='solid'){
            if(typeof input.hex!=='string'||!/^#[0-9a-f]{6}$/i.test(input.hex))throw Object.assign(new Error('Supply a six-digit Color value for this named palette resource'),{status:400});
            primary=[1,3,5].map(i=>parseInt(input.hex.slice(i,i+2),16)/255);secondary=primary;
          }else{
            const a=catalog.assets.find(a=>a.type==='color'&&a.id===input.primaryColorId&&a.parameters.pattern===-1),b=catalog.assets.find(a=>a.type==='color'&&a.id===input.secondaryColorId&&a.parameters.pattern===-1);
            if(!a||!b)throw Object.assign(new Error('Patterns must reference two existing solid palette Colors'),{status:400});
            primary=a.parameters.primary;secondary=b.parameters.primary;palette={primary:a.id,secondary:b.id};
          }
          const scale=input.scale??1;if(typeof scale!=='number'||!Number.isFinite(scale)||scale<.1||scale>200)throw Object.assign(new Error('Pattern scale must be between 0.1 and 200'),{status:400});
          const slug='custom-'+randomBytes(8).toString('hex'),entry={schemaVersion:1,type:'color',id:`ymir/${slug}@1`,...fields,generator:input.generator,parameters:{primary,secondary,pattern:patterns[input.generator],scale:[scale,scale],offset:[0,0]},...(palette?{palette}:{}),suiteManifest:'materials/ymir-surfaces-v1/suite.json',manifest:`colors/${slug}/color.json`};
          await mkdir(path.join(root,'colors'),{recursive:true});const colorRoot=await safe('colors');await mkdir(path.join(colorRoot,slug));await atomic(path.join(colorRoot,slug,'color.json'),entry);catalog.assets.push(entry);await atomic(path.join(root,'catalog.json'),catalog);response(res,201,{ok:true,id:entry.id});
        };
        const current=queue.then(work);queue=current.catch(()=>{});await current;return true;
      }
      if(Object.keys(input).some(k=>!['revision','variantId','metadata','scope','appearance','defaultColorId'].includes(k)))throw Object.assign(new Error('Unexpected edit fields'),{status:400});
      const work=async()=>{
        const {catalog,entry,file,asset}=await assetFor(url.searchParams.get('id'));
        if(input.revision!==revision(asset))throw Object.assign(new Error('Asset changed since the editor opened. Reopen it.'),{status:409});
        const variant=input.variantId?asset.variants?.find(v=>v.id===input.variantId):null;
        if(input.variantId&&!variant)throw Object.assign(new Error('Variant not found'),{status:404});
        if(req.method==='PUT'){
          if(input.defaultColorId!==undefined){
            if(asset.type!=='material'||typeof input.defaultColorId!=='string'||!catalog.assets.some(a=>a.type==='color'&&a.id===input.defaultColorId))throw Object.assign(new Error('Material defaults must reference an existing named Color'),{status:400});
            asset.defaultColorId=entry.defaultColorId=input.defaultColorId;
            await atomic(file,asset);await atomic(path.join(root,'catalog.json'),catalog);response(res,200,{ok:true});return;
          }
          if(input.appearance){
            const change=input.appearance;
            if(asset.type!=='prop'||asset.schemaVersion!==3||Object.keys(change).some(k=>!['slotId','slotIds','materialId','colorId','target','newVariantName','assignments'].includes(k)))throw Object.assign(new Error('Invalid surface assignment'),{status:400});
            const model=await json(await safe(asset.model));
            const modelSlots=new Set(model.slots.map(s=>s.id));
            const resolveSurface=(materialId,colorId)=>{
              if(typeof materialId!=='string'||typeof colorId!=='string')throw Object.assign(new Error('Each surface assignment needs a Material and a named Color resource, or its default Color'),{status:400});
              const material=catalog.assets.find(a=>a.type==='material'&&a.id===materialId),color=catalog.assets.find(a=>a.type==='color'&&a.id===colorId);
              if(!material||colorId!==''&&!color||material.suiteManifest!==asset.suiteManifest||colorId===''&&!catalog.assets.some(a=>a.type==='color'&&a.id===material.defaultColorId))throw Object.assign(new Error('Choose an existing compatible Material and named Color resource, or its default Color'),{status:400});
              return {material,color};
            };
            let groups;
            if(Object.hasOwn(change,'assignments')){
              // Atomic multi-surface request: every entry is validated before the asset is touched.
              if(['slotId','slotIds','materialId','colorId'].some(k=>Object.hasOwn(change,k)))throw Object.assign(new Error('Send assignments instead of slotId, slotIds, materialId and colorId'),{status:400});
              if(!Array.isArray(change.assignments)||!change.assignments.length)throw Object.assign(new Error('Provide at least one surface assignment'),{status:400});
              const seen=new Set();
              groups=change.assignments.map(assignment=>{
                if(!assignment||typeof assignment!=='object'||Array.isArray(assignment)||Object.keys(assignment).some(k=>!['slotId','slotIds','materialId','colorId'].includes(k)))throw Object.assign(new Error('Invalid surface assignment entry'),{status:400});
                const bulk=Object.hasOwn(assignment,'slotIds'),slotIds=bulk?assignment.slotIds:[assignment.slotId];
                if(bulk&&Object.hasOwn(assignment,'slotId')||!Array.isArray(slotIds)||!slotIds.length||new Set(slotIds).size!==slotIds.length||slotIds.some(id=>typeof id!=='string'||!modelSlots.has(id)))throw Object.assign(new Error('Choose valid unique model surface slots'),{status:400});
                for(const slotId of slotIds){if(seen.has(slotId))throw Object.assign(new Error('Each model surface slot can be assigned once per request'),{status:400});seen.add(slotId);}
                return {slotIds:[...slotIds],...resolveSurface(assignment.materialId,assignment.colorId)};
              });
            }else{
              const bulk=Object.hasOwn(change,'slotIds'),slotIds=bulk?change.slotIds:[change.slotId];
              if(bulk&&Object.hasOwn(change,'slotId')||!Array.isArray(slotIds)||!slotIds.length||new Set(slotIds).size!==slotIds.length||slotIds.some(id=>!modelSlots.has(id)))throw Object.assign(new Error('Choose valid unique model surface slots'),{status:400});
              groups=[{slotIds:[...slotIds],...resolveSurface(change.materialId,change.colorId)}];
            }
            if(!['prop','variant','new-variant'].includes(change.target))throw Object.assign(new Error('Choose prop defaults, this variant, or a new variant'),{status:400});
            let destination=asset;
            if(change.target==='variant'){if(!variant)throw Object.assign(new Error('Variant required'),{status:400});destination=variant;}
            if(change.target==='new-variant'){
              if(!variant||typeof change.newVariantName!=='string'||!change.newVariantName.trim()||change.newVariantName.length>120)throw Object.assign(new Error('Name the new variant (1–120 characters)'),{status:400});
              destination=structuredClone(variant);destination.id='variant-'+randomBytes(6).toString('hex');destination.name=change.newVariantName.trim();delete destination.sourceAssetId;asset.variants.push(destination);
            }
            const assignments=groups.flatMap(({slotIds,material,color})=>slotIds.map(slotId=>{
              const old=[...asset.slots,...(change.target==='prop'?[]:variant?.slots??[])].findLast(s=>s.slotId===slotId);
              // Keep each slot's own roughness/metal overrides when retaining its Material.
              return {slotId,material:old?.material.id===material.id?old.material:{id:material.id},...(color?{color:{id:color.id}}:{})};
            }));
            const slotIds=assignments.map(a=>a.slotId);
            destination.slots=[...(destination.slots??[]).filter(s=>!slotIds.includes(s.slotId)),...assignments];
            entry.variants=asset.variants.map(({overrides,bindings,slots,partMetadata,...v})=>v);
            await atomic(file,asset);await atomic(path.join(root,'catalog.json'),catalog);
            response(res,200,{ok:true,variantId:change.target==='new-variant'?destination.id:input.variantId});return;
          }
          const fields=metadata(input.metadata);Object.assign(variant??asset,fields);
          if(!variant)Object.assign(entry,fields);
          else entry.variants=asset.variants.map(({overrides,bindings,slots,partMetadata,...v})=>v);
          await atomic(file,asset);await atomic(path.join(root,'catalog.json'),catalog);
          response(res,200,{ok:true});return;
        }
        const scope=input.scope??(variant?'variant':entry.type);
        if(scope!==(variant?'variant':entry.type))throw Object.assign(new Error('Deletion scope does not match target'),{status:400});
        if(entry.type==='model'){
          const users=catalog.assets.filter(a=>a.modelId===entry.id);
          if(users.length)throw Object.assign(new Error(`Model is used by ${users.length} prop(s): ${users.map(a=>a.name).join(', ')}. Delete those props first; model deletion never cascades.`),{status:409});
        }
        if(variant&&asset.variants.length===1)throw Object.assign(new Error('Cannot delete the last variant; delete the asset instead'),{status:409});
        if(!variant&&['material','color'].includes(entry.type)){
          for(const other of catalog.assets){
            if(entry.type==='color'&&other.type==='material'&&other.defaultColorId===entry.id)throw Object.assign(new Error(`Color is the default for Material ${other.name}`),{status:409});
            if(entry.type==='color'&&Object.values(other.palette??{}).includes(entry.id))throw Object.assign(new Error(`Color used by pattern ${other.name}`),{status:409});
            if(other.materialId===entry.id)throw Object.assign(new Error(`Material used by ${other.name}`),{status:409});
            if(other.type!=='prop')continue;
            const a=await json(await safe(other.manifest));
            const refs=[...(a.nodes??[]),...(a.slots??[]),...(a.variants??[]).flatMap(v=>v.slots??v.bindings??v.overrides??[])];
            if(refs.some(n=>n[entry.type]?.id===entry.id))throw Object.assign(new Error(`${entry.type} used by ${other.name}`),{status:409});
          }
        }
        const remove=[];
        for(const [manifest,alias] of Object.entries(catalog.aliases??{}))if(alias.assetId===entry.id&&(!variant||alias.variant===variant.id)){
          remove.push(await safe(manifest));delete catalog.aliases[manifest];
        }
        if(variant){asset.variants=asset.variants.filter(v=>v.id!==variant.id);if(asset.defaultVariant===variant.id)asset.defaultVariant=asset.variants[0].id;
          // Keep base material metadata synchronized with the surviving default.
          if((asset.schemaVersion??1)<2){const defaults=asset.variants.find(v=>v.id===asset.defaultVariant);asset.nodes=asset.nodes.map((n,i)=>({...n,...defaults.overrides[i]}));}
          entry.defaultVariant=asset.defaultVariant;entry.variants=asset.variants.map(({overrides,bindings,slots,partMetadata,...v})=>v);await atomic(file,asset);
        }else{
          catalog.assets=catalog.assets.filter(a=>a.id!==entry.id);catalog.textures=catalog.textures.filter(id=>id!==entry.id);
          remove.push(file);if(entry.type==='model'||entry.type==='prop'&&(asset.schemaVersion??1)<2)remove.push(await safe(path.relative(root,path.join(path.dirname(file),asset.mesh))));
        }
        await atomic(path.join(root,'catalog.json'),catalog);
        for(const target of remove)await unlink(target);
        response(res,200,{ok:true});
      };
      const current=queue.then(work);queue=current.catch(()=>{});await current;
    }catch(error){response(res,error.status??(error instanceof SyntaxError?400:500),{error:error.message});}
    return true;
  };
}
