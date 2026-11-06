// Shadow targets for the actual moving spotlights, and a lit-scene cube probe.
// All images are rendered from procedural geometry; no imported image assets.
export function createLightingResources(gl){
  const depthTarget=size=>{
    const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.DEPTH_COMPONENT24,size,size,0,gl.DEPTH_COMPONENT,gl.UNSIGNED_INT,null);
    for(const [key,value] of [[gl.TEXTURE_MIN_FILTER,gl.NEAREST],[gl.TEXTURE_MAG_FILTER,gl.NEAREST],[gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]])gl.texParameteri(gl.TEXTURE_2D,key,value);
    const framebuffer=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.TEXTURE_2D,texture,0);gl.drawBuffers([gl.NONE]);gl.readBuffer(gl.NONE);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Spotlight shadow target incomplete');
    return {texture,framebuffer,size};
  };
  const cube=size=>{
    const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_CUBE_MAP,texture);
    const empty=new Uint8Array(size*size*4);
    for(let i=0;i<6;i++)gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X+i,0,gl.RGBA8,size,size,0,gl.RGBA,gl.UNSIGNED_BYTE,empty);
    for(const key of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T,gl.TEXTURE_WRAP_R])gl.texParameteri(gl.TEXTURE_CUBE_MAP,key,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP,gl.TEXTURE_MIN_FILTER,size===1?gl.LINEAR:gl.LINEAR_MIPMAP_LINEAR);gl.texParameteri(gl.TEXTURE_CUBE_MAP,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    if(size>1)gl.generateMipmap(gl.TEXTURE_CUBE_MAP);return texture;
  };
  const spotA=depthTarget(1536),spotB=depthTarget(1536),environment=cube(512),fallback=cube(1);
  const framebuffer=gl.createFramebuffer(),depth=gl.createRenderbuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.bindRenderbuffer(gl.RENDERBUFFER,depth);gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT24,512,512);gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,depth);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_CUBE_MAP_POSITIVE_X,environment,0);
  if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Environment probe target incomplete');
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  return {spotA,spotB,environment,fallback,framebuffer,size:512,ready:false,dispose(){for(const t of [spotA,spotB]){gl.deleteTexture(t.texture);gl.deleteFramebuffer(t.framebuffer);}gl.deleteTexture(environment);gl.deleteTexture(fallback);gl.deleteFramebuffer(framebuffer);gl.deleteRenderbuffer(depth);}};
}
