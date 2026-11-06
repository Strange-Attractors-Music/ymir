// GRWM mirrors use the world-anchored star wall and side returns. Asset
// inspection opts into the seamless studio dome instead, for both probes and
// planar mirror views. The GRWM environment remains the default.
export function createMirrorEnvironment(gl){
  const compile=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;};
  const vertex=compile(gl.VERTEX_SHADER,`#version 300 es
  precision highp float;out vec2 uv;void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);uv=p;gl_Position=vec4(p*2.-1.,0,1);}`);
  const fragment=compile(gl.FRAGMENT_SHADER,`#version 300 es
  precision highp float;in vec2 uv;out vec4 frag;
  uniform vec3 eye,target,camera_up;uniform float stage_z,energy;
  uniform float probe_pass,linear_background,studio_pass;uniform vec3 key_position,light_a,light_b,color_a,color_b;uniform vec3 light_energy;
  float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
  float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1)),f.x),f.y);}
  vec3 stars(vec2 p,float density){
    p*=density;vec2 cell=floor(p);vec3 color=vec3(0);
    for(int x=-1;x<=1;x++)for(int y=-1;y<=1;y++){
      vec2 id=cell+vec2(x,y),center=id+vec2(.13+.74*hash(id),.13+.74*hash(id+vec2(7,13)));
      float choice=hash(id+vec2(31,5));if(choice<.63)continue;
      vec2 d=p-center;float aa=max(length(fwidth(p)),.002);
      float radius=max(.013+.019*hash(id+vec2(3,41)),aa*.50),r=length(d);
      float core=exp(-dot(d,d)/(radius*radius));
      float halo=exp(-r/max(radius*2.8,aa))*.07;
      vec3 tint=choice>.94?vec3(1.,.55,.69):choice>.82?vec3(1.,.81,.43):vec3(.95,.96,1.);
      color+=tint*(core+halo)*(.50+.42*hash(id+vec2(19,3)));
    }
    return color;
  }
  vec3 studio(vec3 ray){
    // A seamless directional studio dome: broad softboxes and a restrained
    // floor/ceiling gradient, with no finite walls or geometric room edges.
    vec3 c=mix(vec3(.025,.030,.040),vec3(.19,.17,.15),smoothstep(-.48,.28,ray.y));
    float vertical=exp(-((ray.x+.20)*(ray.x+.20)+(ray.y-.12)*(ray.y-.12)*.08)*18.0);
    float edge=exp(-((ray.x-.63)*(ray.x-.63)*4.5+(ray.y-.15)*(ray.y-.15)*.12)*16.0);
    float top=pow(max(0.0,dot(ray,normalize(vec3(-.3,.86,.30)))),24.0);
    c+=vec3(1.05,.97,.85)*vertical;
    c+=vec3(.72,.80,.92)*edge;
    c+=vec3(.56,.48,.38)*top;
    float key=exp(-(1.0-dot(ray,normalize(key_position-eye)))/.045);
    float a=exp(-(1.0-dot(ray,normalize(light_a-eye)))/.035);
    float b=exp(-(1.0-dot(ray,normalize(light_b-eye)))/.035);
    c+=vec3(1.0,.93,.81)*key*light_energy.x*1.8;
    c+=color_a*a*light_energy.y*1.4+color_b*b*light_energy.z*1.4;
    return c*(.88+.12*energy);
  }
  void main(){
    vec3 f=normalize(target-eye),right=normalize(cross(f,camera_up)),up=cross(right,f);
    if(studio_pass>.5){
      float aspect=probe_pass>.5?1.:.5625,tanFov=probe_pass>.5?1.:.46630766;
      vec3 ray=normalize(f+right*(uv.x*2.-1.)*aspect*tanFov+up*(uv.y*2.-1.)*tanFov);
      vec3 c=studio(ray);
      frag=vec4(probe_pass>.5||linear_background>.5?c/(c+vec3(.85)):clamp(c,0.0,1.0),1.0);
      return;
    }
    float aspect=probe_pass>.5?1.:.5625,tanFov=probe_pass>.5?1.:.46630766;
    vec3 ray=normalize(f+right*(uv.x*2.-1.)*aspect*tanFov+up*(uv.y*2.-1.)*tanFov);
    float distance=1e5;int wall=0;
    if(ray.z>.00001){float d=(stage_z+14.-eye.z)/ray.z;if(d>0.)distance=d;}
    if(abs(ray.x)>.00001){float d=(sign(ray.x)*12.-eye.x)/ray.x;if(d>0.&&d<distance){distance=d;wall=1;}}
    vec3 hit=eye+ray*min(distance,100.);vec2 p=wall==0?hit.xy:vec2(hit.z-stage_z,hit.y);
    // The wall/side returns stay fixed as the camera moves. No temporal noise.
    float cloud=noise(p*.19)*noise(p*.43+vec2(9,3));
    vec3 c=vec3(.0035,.004,.008)+vec3(.012,.008,.016)*cloud;
    c+=stars(p,1.05)+stars(p+vec2(17,29),2.10)*.32;
    c*=.86+.14*energy;
    if(probe_pass>.5||linear_background>.5){
      // Visible emitter lobes coincide with the very same lights casting the
      // key/spot shadows, rather than unrelated painted studio highlights.
      float key=exp(-(1.-dot(ray,normalize(key_position-eye)))/.005);
      float a=exp(-(1.-dot(ray,normalize(light_a-eye)))/.0025);
      float b=exp(-(1.-dot(ray,normalize(light_b-eye)))/.0025);
      c+=vec3(1.,.93,.81)*key*light_energy.x*3.0+color_a*a*light_energy.y*2.0+color_b*b*light_energy.z*2.0;
      frag=vec4(c/(c+vec3(.85)),1.);
    }else frag=vec4(clamp(c,0.,1.),1.);
  }`);
  const program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
  gl.deleteShader(vertex);gl.deleteShader(fragment);
  const loc=name=>gl.getUniformLocation(program,name);
  return {draw(camera,up,stageZ,energy,options={}){
    gl.disable(gl.DEPTH_TEST);gl.depthMask(false);gl.useProgram(program);gl.bindVertexArray(null);
    for(const [name,value] of [['eye',camera.eye],['target',camera.target],['camera_up',up]])gl.uniform3fv(loc(name),value);
    gl.uniform1f(loc('stage_z'),stageZ);gl.uniform1f(loc('energy'),energy);
    gl.uniform1f(loc('probe_pass'),options.probe?1:0);
    gl.uniform1f(loc('linear_background'),options.linear?1:0);
    gl.uniform1f(loc('studio_pass'),options.studio?1:0);
    const show=options.show??{};
    for(const [name,value] of [['key_position',options.light??[-4,8,stageZ+6]],['light_a',[-2.9,4.9,stageZ-2.5]],['light_b',[2.9,4.9,stageZ-2.8]],['color_a',show.colorA??[1,1,1]],['color_b',show.colorB??[1,1,1]],['light_energy',[show.keyGain??1,show.beams?.[0]?.energy??0,show.beams?.[1]?.energy??0]]])gl.uniform3fv(loc(name),value);
    gl.drawArrays(gl.TRIANGLES,0,3);
    gl.depthMask(true);gl.enable(gl.DEPTH_TEST);
  },dispose(){gl.deleteProgram(program);}};
}
