import {loadLibrary,resolveColor,groupSurfaceAssignments,surfaceAssignmentName,createRenderer,model,multiply,lookAt,perspective,unit,sub,cross,dot} from 'trinity';
import {BASE_ELEVATION,applyOrbitDrag} from './orbit-controls.js';

const $=id=>document.getElementById(id);
const readOnly=typeof __YMIR_READ_ONLY__!=='undefined'&&__YMIR_READ_ONLY__;

const MIN_ZOOM = 0.55; // Prevent camera from entering inside model geometry
const MAX_ZOOM = 3.5;
const DRAG_THRESHOLD = 8; // Pixel distance to distinguish tap/click from drag/orbit

let renderer,world,transforms,previewTransition=null;
let turn=0,tilt=0,zoom=1,generation=0,dirty=false;
let currentEntry,currentVariant,editState,editTargetState,deleteState;
let surfaceState,selectedSlot=null,selectedPart=null,pickMeshes=[],lastCamera;
let turntableOn=false;
const stagedChanges=new Map(); // slotId -> { materialId, colorId }
let pendingSwitchAction=null;

const library=await loadLibrary(new URL('../',import.meta.url)).catch(e=>{$('error').textContent=e.message;throw e;});
const libraries=new Map();

async function libraryFor(entry){
  const suiteManifest=entry.suiteManifest??'materials/ymir-surfaces-v1/suite.json';
  if(!libraries.has(suiteManifest))libraries.set(suiteManifest,loadLibrary(new URL('../',import.meta.url),{suiteManifest}));
  return libraries.get(suiteManifest);
}

// Preload models surrounding the active entry for instant zero-lag switching
function preloadNearby(selectedEntry){
  if(!selectedEntry||!library?.catalog?.assets)return;
  const allEntries=library.catalog.assets.filter(a=>['prop','model'].includes(a.type));
  const idx=allEntries.findIndex(a=>a.id===selectedEntry.id||(selectedEntry.modelId&&a.id===selectedEntry.modelId));
  if(idx===-1)return;
  const start=Math.max(0,idx-5);
  const end=Math.min(allEntries.length,idx+6);
  const targets=allEntries.slice(start,end).filter(a=>a.id!==selectedEntry.id);

  const schedulePreload=window.requestIdleCallback||(cb=>setTimeout(cb,80));
  schedulePreload(async()=>{
    for(const item of targets){
      try{
        const lib=await libraryFor(item);
        if(item.type==='prop'){
          lib.loadProp(item.manifest).catch(()=>{});
        }else if(item.type==='model'){
          lib.loadModel(item.manifest).catch(()=>{});
        }
      }catch(_){}
    }
  });
}

function swatch(material,color){
  color={...color,parameters:resolveColor(library.catalog,color.id)};
  const vertices=[],indices=[],nu=64,nv=33;
  for(let i=0;i<nu;i++)for(let j=0;j<nv;j++){
    const a=i/nu*Math.PI*2,b=j/(nv-1)*Math.PI,x=Math.sin(b)*Math.cos(a),y=Math.cos(b),z=Math.sin(b)*Math.sin(a);
    vertices.push(x,y,z,x,y,z,i/nu,j/(nv-1));
  }
  for(let i=0;i<nu;i++)for(let j=0;j<nv-1;j++){const a=i*nv+j,b=((i+1)%nu)*nv+j;indices.push(a,b,b+1,a,b+1,a+1);}
  const vv=new Float32Array(vertices),ii=new Uint32Array(indices),bytes=new Uint8Array(vv.byteLength+ii.byteLength);bytes.set(new Uint8Array(vv.buffer));bytes.set(new Uint8Array(ii.buffer),vv.byteLength);
  return {raw:bytes.buffer,asset:{bounds:[[-1,-1,-1],[1,1,1]]},nodes:[{vertex_offset:0,index_offset:vv.byteLength,vertex_count:vertices.length/8,index_count:indices.length,
    ...material.parameters,color:color.parameters.primary,colorData:color.parameters,kind:material.profile,pos:[0,0,0],rot:[0,0,0],scale:[1,1,1],assembly:0,deformability:0,label:'material swatch',surface_center:[0,0,0],surface_normal:[0,0,1]}]};
}

async function select(entry,{variant=entry.defaultVariant,previewMaterial,previewColor}={}){
  const preserveView=currentEntry?.id===entry.id;
  previewTransition=null;
  currentEntry=entry;
  currentVariant=variant;
  stagedChanges.clear();
  updateSaveCheckVisibility();
  if($('part-card'))$('part-card').hidden=true;
  selectedSlot=null;selectedPart=null;

  // Show loading spinner while loading model resources
  const spinner=$('loading-spinner');
  if(spinner)spinner.hidden=false;

  const variants=$('variant');
  if(variants){
    variants.replaceChildren();
    for(const v of entry.variants??[]){
      const option=document.createElement('option');
      option.value=v.id;
      option.textContent=v.name;
      variants.append(option);
    }
    variants.value=variant??'';
  }
  const variantControl=$('variant-control');
  if(variantControl)variantControl.hidden=!entry.variants?.length;
  $('edit').disabled=$('delete').disabled=false;

  const token=++generation;
  $('error').textContent='';
  $('title').textContent=entry.name;

  try{
    const selectedLibrary=await libraryFor(entry);
    const material=library.catalog.assets.find(a=>a.id===(previewMaterial??(entry.type==='material'?entry.id:'grwm/woven-satin@3')))??library.catalog.assets.find(a=>a.type==='material');
    const selectedColorId=previewColor===''?material?.defaultColorId:previewColor??(entry.type==='color'?entry.id:material?.defaultColorId);
    const color=library.catalog.assets.find(a=>a.id===selectedColorId)??library.catalog.assets.find(a=>a.type==='color'&&a.parameters.pattern===-1);
    if(['material','color'].includes(entry.type)&&(!material||!color))throw new Error('Pairing previews need an existing Material and named Color. Define a Color palette resource first if none exists.');
    const prop=entry.type==='prop'?await selectedLibrary.loadProp(entry.manifest,{variant}):entry.type==='model'?await selectedLibrary.loadModel(entry.manifest):swatch(material,color);
    if(token!==generation)return;

    renderer?.dispose();renderer=null;
    if(!preserveView){turn=0;tilt=0;zoom=1;}
    const isMaterialSwatch=['material','color'].includes(entry.type),previewNodes=prop.nodes.map(n=>({...n,assembly:0}));
    world={index:0,start_s:0,end_s:1,background:[.58,.40,.34],accent:[.55,.12,.18],nodes:isMaterialSwatch?[]:previewNodes,rigs:[{pos:[0,0,0]}]};
    if(entry.preview==='backdrop')world.nodes=[];
    const transition={meshData:prop.raw,vertex_offset:0,...prop.nodes[0]};

    // Ensure canvas size is accurate prior to creating WebGL framebuffers and viewport
    resizeCanvas();

    const candidate=await createRenderer({
      canvas:$('preview'),
      width:preview.width,
      height:preview.height,
      book:{worlds:[{...world,meshData:prop.raw}],transition},
      shaders:selectedLibrary.shaders,
      quality:{shadowSize:2048,cacheEnvironment:true,synchronize:false}
    });
    if(token!==generation){candidate.dispose();return;}
    renderer=candidate;
    world.bounds=prop.asset.bounds;

    const transformFor=n=>{
      let matrix=model(n.pos,n.scale,n.rot);
      if(n.joint)matrix=multiply(model(n.joint.pivot,[1,1,1],[n.joint.rest_degrees,0,0]),matrix);
      return {model:matrix,art:[0,0,0,0],perc:[0,0,0,0],voice:[0,0,0,0],extra:[0,0,0,0]};
    };
    transforms=world.nodes.map(transformFor);
    if(isMaterialSwatch)previewTransition={node:previewNodes[0],transform:transformFor(previewNodes[0]),world};

    pickMeshes=['prop','model'].includes(entry.type)?world.nodes.map((n,index)=>{
      const vertices=new Float32Array(prop.raw,n.vertex_offset,n.vertex_count*8),matrix=transforms[index].model;
      const points=[];for(let i=0;i<vertices.length;i+=8){const v=vertices.subarray(i,i+3);points.push([0,1,2].map(k=>matrix[k]*v[0]+matrix[k+4]*v[1]+matrix[k+8]*v[2]+matrix[k+12]));}
      return {node:n,points,indices:new Uint32Array(prop.raw,n.index_offset,n.index_count)};
    }):[];

    // Synchronously initialize base surface state from loaded asset so part picking works immediately
    surfaceState={
      modelData:prop.asset,
      slots:prop.asset?.slots??[],
      groups:[],
      variantSlots:[]
    };
    if(entry.type==='prop'){
      configureSurface(prop.asset);
    }

    // DRAW IMMEDIATELY ON SELECTION - Zero lag, instant visual update
    dirty=true;
    draw();
    if(spinner)spinner.hidden=true;

    requestAnimationFrame(()=>{
      dirty=true;
      draw();
    });

    // Swatch controls
    const swatchControls=$('swatch-controls');
    if(swatchControls){
      swatchControls.hidden=!['material','color'].includes(entry.type);
      if(!swatchControls.hidden){
        fillResources($('swatch-material'),'material',material.id);
        fillColorResources($('swatch-color'),material,previewColor===undefined&&entry.type==='material'||previewColor===''?'':color.id);
        $('save-material-default').hidden=readOnly||entry.type!=='material';
        $('save-material-default').disabled=!$('swatch-color').value;
        $('material-default-status').textContent='';
      }
    }

    // Update list button active styles
    for(const button of $('list').children){
      button.setAttribute('aria-pressed',button.dataset.id===entry.id||$('type').value==='prop'&&button.dataset.id===entry.modelId?'true':'false');
    }

    // Trigger background preloading of surrounding models for instant future switches
    preloadNearby(entry);

    // Fetch full server-side metadata in background without blocking rendering or part selection
    if(!readOnly&&['prop','model'].includes(entry.type)){
      try{
        const state=await api(`/api/asset?id=${encodeURIComponent(entry.id)}`);
        if(token===generation){
          surfaceState=state;
          configureSurface(entry.type==='model'?prop.asset:(state.model||prop.asset));
        }
      }catch(_){}
    }
  }catch(e){
    if(spinner)spinner.hidden=true;
    if(token===generation)$('error').textContent=e.stack??e.message;
  }
}

function fillResources(select,type,id){
  select.replaceChildren(...library.catalog.assets.filter(a=>a.type===type).sort((a,b)=>a.name.localeCompare(b.name)).map(a=>new Option(a.name,a.id)));
  select.value=id??'';
}

function fillColorResources(select,material,id){
  fillResources(select,'color',id);
  if(!material)return;
  const color=library.catalog.assets.find(a=>a.id===material.defaultColorId);
  if(color)select.prepend(new Option(`Material default — ${color.name}`,''));
  select.value=id??'';
}

function configureSurface(model){
  if(!model)return;
  surfaceState.modelData=model;
  const overrides=surfaceState.variantSlots?.find(v=>v.id===currentVariant)?.slots??[];
  surfaceState.groups=currentEntry?.type==='prop'?groupSurfaceAssignments(library.catalog,model,surfaceState.slots??[],overrides):[];
}

function selectedGroup(){
  return surfaceState?.groups?.find(g=>g.slotIds.includes(selectedSlot));
}

function getEffectiveAssignment(slotId){
  if(stagedChanges.has(slotId)){
    const st=stagedChanges.get(slotId);
    return {material:{id:st.materialId},color:{id:st.colorId}};
  }
  const selected=surfaceState?.variantSlots?.find(v=>v.id===currentVariant);
  return [...(surfaceState?.slots??[]),...(selected?.slots??[])].findLast(s=>s.slotId===slotId);
}

function getTargetSlotIds(){
  if(!selectedSlot)return [];
  const groupToggle=$('group-toggle');
  if(groupToggle?.checked){
    const grp=selectedGroup();
    return grp?grp.slotIds:[selectedSlot];
  }
  return [selectedSlot];
}

function highlightSelected(){
  const ids=getTargetSlotIds();
  for(const n of world?.nodes??[]){
    n.highlight=Boolean(selectedSlot&&ids.includes(n.surfaceSlot));
  }
  dirty=true;
  draw();
}

function onPartSelected(slotId,partId){
  if(readOnly||!['prop','model'].includes(currentEntry?.type))return;
  selectedSlot=slotId;
  selectedPart=partId;
  highlightSelected();

  const modelData=surfaceState?.modelData||currentEntry;
  const slot=modelData?.slots?.find(s=>(s.id===slotId||s.slotId===slotId));
  const part=modelData?.parts?.find(p=>(p.id===partId||p.partId===partId));
  const group=selectedGroup();

  const title=slot?slot.name:(part?.name||'Selected Part');
  $('part-card-title').textContent=title;
  $('part-card').hidden=false;

  const assigned=getEffectiveAssignment(slotId);
  const currentMatId=assigned?.material?.id||library.catalog.assets.find(a=>a.type==='material')?.id;
  fillResources($('slot-material'),'material',currentMatId);

  const mat=library.catalog.assets.find(a=>a.id===currentMatId);
  const currentColorId=assigned?.color?.id!==undefined?assigned.color.id:(group?.usesDefaultColor?'':(group?.colorId??''));
  fillColorResources($('slot-color'),mat,currentColorId);

  $('group-toggle').checked=Boolean(group&&group.slotIds?.length>1);
}

function applyStagedAssignment(){
  if(!selectedSlot)return;
  const matId=$('slot-material').value;
  const colId=$('slot-color').value;
  const targetSlots=getTargetSlotIds();

  for(const slotId of targetSlots){
    stagedChanges.set(slotId,{materialId:matId,colorId:colId});
  }

  updateLiveNodes();
  updateSaveCheckVisibility();
  highlightSelected();
}

function updateLiveNodes(){
  if(!world?.nodes)return;
  const assignments=[...(surfaceState?.slots??[]),...(surfaceState?.variantSlots?.find(v=>v.id===currentVariant)?.slots??[])];

  for(const n of world.nodes){
    if(stagedChanges.has(n.surfaceSlot)){
      const {materialId,colorId}=stagedChanges.get(n.surfaceSlot);
      const material=library.catalog.assets.find(a=>a.id===materialId);
      if(!material)continue;
      const color=library.catalog.assets.find(a=>a.id===(colorId||material.defaultColorId));
      const colorData=color?resolveColor(library.catalog,color.id):{primary:[1,1,1]};
      const saved=assignments.findLast(s=>s.slotId===n.surfaceSlot);
      const parameters={...material.parameters,...(saved?.material?.id===material.id?saved.material.parameters:{})};
      Object.assign(n,parameters,{
        kind:material.profile,
        color:colorData.primary,
        colorData,
        gold_finish:parameters.gold_finish??false
      });
    }
  }
  world={...world};
  dirty=true;
  draw();
}

function updateSaveCheckVisibility(){
  const btn=$('save-check-btn');
  if(btn)btn.hidden=(stagedChanges.size===0);
}

// Turntable toggle button
$('turntable-btn').onclick=()=>{
  turntableOn=!turntableOn;
  $('turntable-btn').setAttribute('aria-pressed',turntableOn?'true':'false');
  $('turntable-btn').classList.toggle('active',turntableOn);
  dirty=true;
};

// Part Popover card listeners
$('close-part-card').onclick=()=>{
  $('part-card').hidden=true;
  selectedSlot=null;
  selectedPart=null;
  highlightSelected();
};
$('group-toggle').onchange=highlightSelected;
$('slot-material').onchange=()=>{
  const colId=$('slot-color').value;
  fillColorResources($('slot-color'),library.catalog.assets.find(a=>a.id===$('slot-material').value),colId);
  applyStagedAssignment();
};
$('slot-color').onchange=applyStagedAssignment;

// Save Variant Floating Checkmark Button
$('save-check-btn').onclick=()=>{
  if(stagedChanges.size===0)return;
  $('new-variant-name').value='';
  $('save-variant-error').textContent='';
  $('save-variant-dialog').showModal();
};

$('close-save-variant').onclick=()=>{
  $('save-variant-dialog').close();
};

$('save-variant-form').onsubmit=async e=>{
  e.preventDefault();
  const name=$('new-variant-name').value.trim();
  if(!name)return;
  const submitBtn=$('submit-save-variant');
  submitBtn.disabled=true;
  $('save-variant-error').textContent='';
  try{
    const {token}=await api('/api/session');
    const assignments=Array.from(stagedChanges.entries()).map(([slotId,{materialId,colorId}])=>({
      slotId,
      materialId,
      colorId
    }));
    const result=await api(`/api/asset?id=${encodeURIComponent(currentEntry.id)}`,{
      method:'PUT',
      headers:{'content-type':'application/json','x-ymir-token':token},
      body:JSON.stringify({
        revision:surfaceState.revision,
        variantId:currentVariant,
        appearance:{
          target:'new-variant',
          newVariantName:name,
          assignments
        }
      })
    });
    stagedChanges.clear();
    updateSaveCheckVisibility();
    $('part-card').hidden=true;
    selectedSlot=null;
    highlightSelected();
    $('save-variant-dialog').close();
    currentVariant=result.variantId;
    await refresh(currentEntry.id);
  }catch(err){
    $('save-variant-error').textContent=err.message;
  }finally{
    submitBtn.disabled=false;
  }
};

// Confirmation when switching variant or asset with unsaved changes
function requestSwitch(action){
  if(stagedChanges.size>0){
    pendingSwitchAction=action;
    $('confirm-switch-dialog').showModal();
  }else{
    action();
  }
}

$('cancel-switch-btn').onclick=()=>{
  $('confirm-switch-dialog').close();
  pendingSwitchAction=null;
  if($('variant'))$('variant').value=currentVariant;
};

$('confirm-discard-btn').onclick=()=>{
  stagedChanges.clear();
  updateSaveCheckVisibility();
  $('part-card').hidden=true;
  selectedSlot=null;
  $('confirm-switch-dialog').close();
  const act=pendingSwitchAction;
  pendingSwitchAction=null;
  if(act)act();
};

$('variant').onchange=()=>{
  const targetVariant=$('variant').value;
  if(targetVariant===currentVariant)return;
  requestSwitch(()=>{
    select(currentEntry,{variant:targetVariant});
  });
  if(stagedChanges.size>0){
    $('variant').value=currentVariant;
  }
};

// Swatch controls for Material/Color previews
for(const id of ['swatch-material','swatch-color'])$(id).onchange=()=>select(currentEntry,{previewMaterial:$('swatch-material').value,previewColor:$('swatch-color').value});
$('save-material-default').onclick=async()=>{
  try{
    $('save-material-default').disabled=true;
    const id=$('swatch-material').value,colorId=$('swatch-color').value;
    const state=await api(`/api/asset?id=${encodeURIComponent(id)}`),{token}=await api('/api/session');
    await api(`/api/asset?id=${encodeURIComponent(id)}`,{method:'PUT',headers:{'content-type':'application/json','x-ymir-token':token},body:JSON.stringify({revision:state.revision,defaultColorId:colorId})});
    library.catalog=await api('/ymir/catalog.json');libraries.clear();list();
    await select(library.catalog.assets.find(a=>a.id===currentEntry.id),{previewMaterial:id,previewColor:''});
    $('material-default-status').textContent='Material default Color saved.';
  }catch(e){
    $('material-default-status').textContent=e.message;
  }finally{
    $('save-material-default').disabled=false;
  }
};

// New Color dialog
$('new-color').onclick=()=>{
  const palette=library.catalog.assets.filter(a=>a.type==='color'&&a.parameters.pattern===-1).sort((a,b)=>a.name.localeCompare(b.name));
  for(const id of ['color-primary','color-secondary'])$(id).replaceChildren(...palette.map(c=>new Option(c.name,c.id)));
  $('color-name').value='';$('color-error').textContent='';$('color-dialog').showModal();
};
$('color-generator').onchange=()=>{
  const solid=$('color-generator').value==='solid';
  $('solid-color-field').hidden=!solid;
  $('pattern-color-fields').hidden=solid;
};
$('cancel-color').onclick=()=>$('color-dialog').close();
$('color-form').onsubmit=async e=>{
  e.preventDefault();
  $('save-color').disabled=true;
  try{
    const {token}=await api('/api/session');
    const generator=$('color-generator').value;
    const result=await api('/api/colors',{
      method:'POST',
      headers:{'content-type':'application/json','x-ymir-token':token},
      body:JSON.stringify({
        metadata:{name:$('color-name').value,description:'',tags:[]},
        generator,
        ...(generator==='solid'?{hex:$('color-hex').value}:{primaryColorId:$('color-primary').value,secondaryColorId:$('color-secondary').value,scale:Number($('color-repeat').value)})
      })
    });
    $('type').value='color';
    await refresh(result.id);
    $('color-dialog').close();
  }catch(error){
    $('color-error').textContent=error.message;
  }finally{
    $('save-color').disabled=false;
  }
};

// Rendering & Camera View
const preview=$('preview');
function resizeCanvas(){
  const section=$('viewport-section');
  if(!section)return;
  const rect=section.getBoundingClientRect();
  const dpr=window.devicePixelRatio||1;
  const w=Math.round(rect.width*dpr);
  const h=Math.round(rect.height*dpr);
  if(w>0&&h>0&&(preview.width!==w||preview.height!==h)){
    preview.width=w;
    preview.height=h;
    dirty=true;
    if(renderer)draw();
  }
}
const resizeObserver=new ResizeObserver(resizeCanvas);
resizeObserver.observe($('viewport-section'));

function draw(){
  if(!renderer)return;
  const [lo,hi]=world.bounds,center=lo.map((v,i)=>(v+hi[i])/2),size=Math.max(...lo.map((v,i)=>hi[i]-v),.1);
  const az=turn*Math.PI/180,elevation=(BASE_ELEVATION+tilt)*Math.PI/180,d=size*1.8*zoom;
  const ring=Math.cos(elevation);
  const cam={eye:[center[0]+Math.sin(az)*ring*d,center[1]+Math.sin(elevation)*d,center[2]+Math.cos(az)*ring*d],target:center};
  cam.view=lookAt(cam.eye,center);
  lastCamera=cam;
  const aspect=(preview.clientWidth||1)/(preview.clientHeight||1);
  renderer.render({
    t:0,
    world,
    transforms,
    cam,
    projection:perspective(50*Math.PI/180,aspect,.01,Math.max(100,d*4)),
    selectedRig:{id:0},
    ...(previewTransition?{transition:previewTransition}:{})
  });
}

function pickPart(clientX,clientY){
  if(!lastCamera||!['prop','model'].includes(currentEntry?.type))return;
  const rect=preview.getBoundingClientRect();
  if(rect.width<=0||rect.height<=0)return;
  const aspect=rect.width/rect.height;
  const x=((clientX-rect.left)/rect.width)*2-1;
  const y=1-((clientY-rect.top)/rect.height)*2;
  const f=Math.tan(25*Math.PI/180);
  const forward=unit(sub(lastCamera.target,lastCamera.eye));
  const right=unit(cross(forward,[0,1,0]));
  const up=cross(right,forward);
  const ray=unit(forward.map((v,i)=>v+right[i]*x*f*aspect+up[i]*y*f));
  let nearest=Infinity,hit;
  for(const mesh of pickMeshes){
    const {points,indices,node}=mesh;
    for(let i=0;i<indices.length;i+=3){
      const a=points[indices[i]],edge1=sub(points[indices[i+1]],a),edge2=sub(points[indices[i+2]],a),p=cross(ray,edge2),det=dot(edge1,p);
      if(Math.abs(det)<1e-10)continue;
      const origin=sub(lastCamera.eye,a),u=dot(origin,p)/det;
      if(u<0||u>1)continue;
      const q=cross(origin,edge1),v=dot(ray,q)/det;
      if(v<0||u+v>1)continue;
      const distance=dot(edge2,q)/det;
      if(distance>0&&distance<nearest){nearest=distance;hit=node;}
    }
  }
  if(hit?.partId&&hit?.surfaceSlot){
    onPartSelected(hit.surfaceSlot,hit.partId);
  }
}

// Mobile sidebar drawer collapse & toggle
const sidebarDrawer=$('sidebar-drawer');
const toggleSidebarBtn=$('toggle-sidebar');
const drawerBackdrop=$('drawer-backdrop');

function collapseSidebar(){
  if(sidebarDrawer&&!sidebarDrawer.classList.contains('drawer-closed')){
    sidebarDrawer.classList.add('drawer-closed');
  }
  if(drawerBackdrop){
    drawerBackdrop.hidden=true;
  }
}

function openSidebar(){
  if(sidebarDrawer){
    sidebarDrawer.classList.remove('drawer-closed');
  }
  if(drawerBackdrop&&window.innerWidth<=768){
    drawerBackdrop.hidden=false;
  }
}

if(toggleSidebarBtn){
  toggleSidebarBtn.onclick=()=>{
    if(sidebarDrawer?.classList.contains('drawer-closed')){
      openSidebar();
    }else{
      collapseSidebar();
    }
  };
}
if(drawerBackdrop){
  drawerBackdrop.onclick=collapseSidebar;
}

// Window-level dismiss: tap or drag outside drawer collapses mobile sidebar immediately
window.addEventListener('pointerdown',e=>{
  if(window.innerWidth<=768&&sidebarDrawer&&!sidebarDrawer.classList.contains('drawer-closed')){
    if(!e.target.closest('#sidebar-drawer')&&!e.target.closest('#toggle-sidebar')){
      collapseSidebar();
    }
  }
},{passive:true});

// On mobile, automatically collapse on initial load
if(window.innerWidth<=768){
  collapseSidebar();
}

function list(){
  const q=$('search').value.toLowerCase(),type=$('type').value;
  const matches=a=>`${a.name} ${a.id} ${a.description??''} ${(a.tags??[]).join(' ')} ${(a.variants??[]).map(v=>`${v.name} ${v.description??''} ${(v.tags??[]).join(' ')}`).join(' ')}`.toLowerCase().includes(q);
  const members=model=>library.catalog.assets.filter(a=>a.type==='prop'&&a.modelId===model.id);
  const entries=library.catalog.assets.filter(a=>type==='prop'?a.type==='model'&&members(a).length&&(matches(a)||members(a).some(matches)):(type==='all'||a.type===type)&&matches(a)).sort((a,b)=>a.name.localeCompare(b.name));
  $('list').replaceChildren();$('count').textContent=`${entries.length} ${type==='prop'?'model families':'resources'}`;
  for(const entry of entries){
    const b=document.createElement('button');
    b.className='asset';
    b.dataset.id=entry.id;
    b.setAttribute('aria-pressed','false');
    b.textContent=entry.name;
    const small=document.createElement('small');
    small.textContent=type==='prop'?`${members(entry).length} prop(s) · shared model`:`${entry.textureType??entry.type}${entry.variants?` · ${entry.variants.length} variants`:''} · ${entry.id}`;
    b.append(small);
    b.onclick=()=>{
      const targetEntry=type==='prop'?(members(entry).find(matches)??members(entry)[0]):entry;
      collapseSidebar();
      if(targetEntry.id===currentEntry?.id)return;
      requestSwitch(()=>{
        select(targetEntry);
      });
    };
    $('list').append(b);
  }
}

async function api(url,options={}){
  const r=await fetch(url,{cache:'no-store',...options});
  const data=await r.json();
  if(!r.ok)throw new Error(data.error??`Request failed (${r.status})`);
  return data;
}

function editFields(){
  const v=editState.variants.find(v=>v.id===$('edit-target').value)??editTargetState.metadata;
  $('edit-name').value=v.name;
  $('edit-description').value=v.description;
  $('edit-tags').value=v.tags.join(', ');
}
function metadataLoading(on){
  for(const id of ['edit-name','edit-description','edit-tags','save-edit'])$(id).disabled=on;
}
$('edit').onclick=async()=>{
  try{
    editState=await api(`/api/asset?id=${encodeURIComponent(currentEntry.id)}`);
    editTargetState=editState;
    const target=$('edit-target');
    target.replaceChildren(new Option(`${currentEntry.type} metadata`,''));
    if(currentEntry.modelId)target.append(new Option('Shared model metadata','model'));
    for(const v of editState.variants)target.append(new Option(`Variant: ${v.name}`,v.id));
    target.value='';
    editFields();
    metadataLoading(false);
    $('edit-error').textContent='';
    $('editor').showModal();
  }catch(e){
    $('error').textContent=e.message;
  }
};
$('edit-target').onchange=async()=>{
  const selected=$('edit-target').value;
  metadataLoading(true);
  try{
    const state=selected==='model'?await api(`/api/asset?id=${encodeURIComponent(currentEntry.modelId)}`):editState;
    if($('edit-target').value!==selected)return;
    editTargetState=state;
    editFields();
  }catch(e){
    $('edit-error').textContent=e.message;
  }finally{
    if($('edit-target').value===selected)metadataLoading(false);
  }
};
$('cancel-edit').onclick=()=>$('editor').close();

async function refresh(id){
  library.catalog=await api('/ymir/catalog.json');
  libraries.clear();
  list();
  const entry=library.catalog.assets.find(a=>a.id===id)??library.catalog.assets.find(a=>a.type==='prop')??library.catalog.assets[0];
  if(entry)await select(entry,{variant:entry.variants?.some(v=>v.id===currentVariant)?currentVariant:entry.defaultVariant});
  else{
    ++generation;
    renderer?.dispose();
    renderer=null;
    currentEntry=null;
    $('title').textContent='No assets';
    $('edit').disabled=$('delete').disabled=true;
    if($('variant-control'))$('variant-control').hidden=true;
  }
}

async function saveEdit(){
  $('edit-error').textContent='';
  const target=$('edit-target').value,variantId=target==='model'?'':target;
  if(target==='model'&&editTargetState.entry.id!==currentEntry.modelId){
    $('edit-error').textContent='Model metadata is still loading. Try again.';
    return;
  }
  $('save-edit').disabled=true;
  try{
    const {token}=await api('/api/session');
    await api(`/api/asset?id=${encodeURIComponent(editTargetState.entry.id)}`,{
      method:'PUT',
      headers:{'content-type':'application/json','x-ymir-token':token},
      body:JSON.stringify({
        revision:editTargetState.revision,
        variantId:variantId||undefined,
        metadata:{
          name:$('edit-name').value,
          description:$('edit-description').value,
          tags:$('edit-tags').value.split(',').map(t=>t.trim()).filter(Boolean)
        }
      })
    });
    const id=currentEntry.id;
    await refresh(id);
    $('editor').close();
  }catch(e){
    $('edit-error').textContent=e.message;
  }finally{
    $('save-edit').disabled=false;
  }
}
$('edit-form').onsubmit=e=>{e.preventDefault();saveEdit();};

$('delete').onclick=async()=>{
  try{
    deleteState=await api(`/api/asset?id=${encodeURIComponent(currentEntry.id)}`);
    const model=currentEntry.modelId?await api(`/api/asset?id=${encodeURIComponent(currentEntry.modelId)}`):currentEntry.type==='model'?deleteState:null;
    deleteState.model=model;
    $('delete-context').textContent=`Selected: ${currentEntry.name}${currentVariant?' · '+(currentEntry.variants.find(v=>v.id===currentVariant)?.name??currentVariant):''}`;
    $('delete-choices').replaceChildren();
    const choices=currentEntry.type==='prop'?[
      {scope:'variant',name:'Delete selected variant',tip:'Removes only this appearance. The prop, shared model and other variants stay. The last variant cannot be deleted separately.',disabled:deleteState.variants.length<2},
      {scope:'prop',name:'Delete this prop',tip:'Removes this prop and all its appearance variants. The shared model and other props stay.'},
      {scope:'model',name:'Delete shared model',tip:`Removes the geometry resource, not any props. Blocked while ${model.dependents.length} prop(s) use it; delete those props first.`,disabled:model.dependents.length>0}
    ]:[{scope:currentEntry.type,name:`Delete this ${currentEntry.type}`,tip:currentEntry.type==='model'?`Removes the geometry resource. Blocked while ${model.dependents.length} prop(s) use it; no cascading deletion.`:'Removes this resource from the shared library. In-use Materials and Colors are protected.',disabled:currentEntry.type==='model'&&model.dependents.length>0}];
    for(const choice of choices){
      const label=document.createElement('label');
      label.className='delete-choice';
      label.title=choice.tip;
      const radio=document.createElement('input');
      radio.type='radio';
      radio.name='scope';
      radio.value=choice.scope;
      radio.required=true;
      radio.disabled=!!choice.disabled;
      label.append(radio,document.createTextNode(choice.name));
      const hint=document.createElement('small');
      hint.textContent=choice.tip;
      label.append(hint);
      $('delete-choices').append(label);
    }
    $('confirm-delete').disabled=choices.every(c=>c.disabled);
    $('delete-error').textContent='';
    $('delete-dialog').showModal();
  }catch(e){
    $('error').textContent=e.message;
  }
};
$('cancel-delete').onclick=()=>$('delete-dialog').close();
$('delete-form').onsubmit=async e=>{
  e.preventDefault();
  const scope=new FormData(e.target).get('scope');
  if(!scope)return;
  $('confirm-delete').disabled=true;
  try{
    const target=scope==='model'?deleteState.model:deleteState;
    const {token}=await api('/api/session');
    await api(`/api/asset?id=${encodeURIComponent(target.entry.id)}`,{
      method:'DELETE',
      headers:{'content-type':'application/json','x-ymir-token':token},
      body:JSON.stringify({
        revision:target.revision,
        scope,
        variantId:scope==='variant'?currentVariant:undefined
      })
    });
    await refresh(currentEntry.id);
    $('delete-dialog').close();
  }catch(error){
    $('delete-error').textContent=error.message;
  }finally{
    $('confirm-delete').disabled=false;
  }
};

$('search').oninput=list;
$('type').onchange=list;

if(readOnly&&!library.catalog.assets.some(a=>a.type==='prop'))$('type').value='model';
if(readOnly)for(const id of ['new-color','delete','edit'])$(id).hidden=true;

list();

// Touch & Pointer Gesture Controls (Desktop Mouse & Mobile Touch)
preview.style.touchAction='none';
preview.style.cursor='grab';

const activePointers=new Map();
let pinchStartDist=0;
let pinchStartZoom=1;

preview.onpointerdown=e=>{
  // On mobile or anytime canvas is touched, auto-collapse sidebar drawer immediately
  collapseSidebar();

  if(e.pointerType==='mouse'&&e.button!==0&&e.button!==1)return;
  e.preventDefault();
  preview.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId,{
    startX:e.clientX,
    startY:e.clientY,
    x:e.clientX,
    y:e.clientY,
    pointerType:e.pointerType,
    button:e.button,
    downTime:Date.now(),
    isDragging:false
  });
  if(activePointers.size===1){
    preview.style.cursor='grabbing';
  }else if(activePointers.size===2){
    const [p1,p2]=Array.from(activePointers.values());
    pinchStartDist=Math.hypot(p1.x-p2.x,p1.y-p2.y);
    pinchStartZoom=zoom;
  }
};

preview.onpointermove=e=>{
  if(!activePointers.has(e.pointerId))return;
  const p=activePointers.get(e.pointerId);
  const dx=e.clientX-p.x;
  const dy=e.clientY-p.y;
  p.x=e.clientX;
  p.y=e.clientY;

  // Once finger/mouse moves beyond DRAG_THRESHOLD, switch to drag/orbit mode
  if(!p.isDragging&&Math.hypot(e.clientX-p.startX,e.clientY-p.startY)>DRAG_THRESHOLD){
    p.isDragging=true;
    collapseSidebar(); // Also collapse on tap+drag motion
  }

  if(activePointers.size===1&&p.isDragging){
    // Both desktop left-click/middle-click drag AND mobile touch drag perform two-axis orbit:
    // down=CCW on X, up=CW on X; right=CCW on Y, left=CW on Y
    ({turn,tilt}=applyOrbitDrag(turn,tilt,1,dx,dy));
    dirty=true;
  }else if(activePointers.size===2){
    // Two-finger gesture: pinch to zoom out, spread to zoom in
    const [p1,p2]=Array.from(activePointers.values());
    const currentDist=Math.hypot(p1.x-p2.x,p1.y-p2.y);
    if(pinchStartDist>0&&currentDist>0){
      // Spreading fingers apart: currentDist > pinchStartDist -> ratio < 1 -> zoom distance decreases -> ZOOMS IN!
      // Pinching fingers together: currentDist < pinchStartDist -> ratio > 1 -> zoom distance increases -> ZOOMS OUT!
      const ratio=pinchStartDist/currentDist;
      zoom=Math.max(MIN_ZOOM,Math.min(MAX_ZOOM,pinchStartZoom*ratio));
      dirty=true;
    }
  }
};

function endPointer(e){
  if(!activePointers.has(e.pointerId))return;
  const p=activePointers.get(e.pointerId);
  const wasSingle=activePointers.size===1;
  const elapsed=Date.now()-p.downTime;
  const dist=Math.hypot(e.clientX-p.startX,e.clientY-p.startY);
  const isClick=wasSingle&&!p.isDragging&&dist<=DRAG_THRESHOLD&&elapsed<500;

  activePointers.delete(e.pointerId);
  if(preview.hasPointerCapture(e.pointerId)){
    preview.releasePointerCapture(e.pointerId);
  }

  if(activePointers.size===0){
    preview.style.cursor='grab';
    pinchStartDist=0;
  }else if(activePointers.size===1){
    const remaining=activePointers.values().next().value;
    remaining.x=remaining.startX=e.clientX;
    remaining.y=remaining.startY=e.clientY;
    remaining.isDragging=true;
  }

  if(isClick&&(p.pointerType==='touch'||p.pointerType==='pen'||p.button===0)){
    pickPart(p.startX,p.startY);
  }
}

preview.onpointerup=endPointer;
preview.onpointercancel=endPointer;
preview.onlostpointercapture=()=>{
  activePointers.clear();
  preview.style.cursor='grab';
  pinchStartDist=0;
};

preview.addEventListener('auxclick',e=>{if(e.button===1)e.preventDefault();});
preview.addEventListener('wheel',e=>{
  collapseSidebar();
  if(!renderer)return;
  e.preventDefault();
  const pixels=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?preview.clientHeight:1);
  const factor=Math.exp(Math.max(-1000,Math.min(1000,pixels))*.0015);
  zoom=Math.max(MIN_ZOOM,Math.min(MAX_ZOOM,zoom*factor));
  dirty=true;
},{passive:false});

let previous=0,lastDraw=0;
function animate(t){
  const spinning=turntableOn&&activePointers.size===0&&!document.hidden;
  if(spinning&&renderer){
    turn+=(previous?Math.min(t-previous,100):0)*.025;
    dirty=true;
  }
  previous=t;
  if(dirty&&renderer&&!document.hidden&&t-lastDraw>=1000/24){
    try{
      draw();
      dirty=false;
      lastDraw=t;
    }catch(e){
      turntableOn=false;
      $('turntable-btn')?.setAttribute('aria-pressed','false');
      $('turntable-btn')?.classList.remove('active');
      dirty=false;
      $('error').textContent=e.message;
    }
  }
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

await select(library.catalog.assets.find(a=>a.id==='grwm/hatc-gold-clip-dc7c5a60a1@3')??(readOnly?library.catalog.assets.find(a=>a.type==='prop')??library.catalog.assets[0]:library.catalog.assets.find(a=>a.sourceVersion==='v4'&&/mirror/i.test(a.name))??library.catalog.assets[0]));

window.__ymir={get catalog(){return library.catalog;},select,draw,get rotation(){return turn;},get tilt(){return tilt;},get zoom(){return zoom;}};
