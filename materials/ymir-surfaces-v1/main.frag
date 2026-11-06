#version 300 es
precision highp float;
precision highp int;
in vec3 world_pos, original_pos, world_normal;
in vec2 uv;
in vec4 shadow_pos;
uniform vec3 color, accent, background, camera_position, light_position;
uniform float roughness, metalness, material_kind, opacity, exposure;
uniform float gold_finish;
uniform float color_pattern;
uniform float selection_highlight;
uniform vec3 color_secondary;
uniform vec2 color_scale,color_offset;
uniform float matte_support;
uniform sampler2D shadow_map;
uniform sampler2D shadow_map_a,shadow_map_b;
uniform mat4 light_matrix_a,light_matrix_b;
uniform samplerCube environment_map;
uniform float environment_pass,environment_ready;
uniform float studio_environment;
uniform float linear_capture;
uniform vec3 environment_position;
uniform int contact_count;
uniform vec4 contacts[24];
uniform vec4 contact_sizes[24];
uniform float contact_receiver;
uniform sampler2D reflection_map;
uniform mat4 reflection_matrix;
uniform float reflection_enabled;
uniform float reflection_pass;
uniform vec3 lighting_tint;
uniform float key_gain, musical_fill, fog_density;
uniform vec4 rig_lighting;
uniform vec3 show_color_a,show_color_b,show_origin,show_target_a,show_target_b;
uniform vec4 show_cones;
uniform float show_energy;
uniform vec4 reflection_clip;
out vec4 frag;
float hash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
vec3 room(vec3 r){
    vec3 c=mix(background*.16,vec3(.065,.054,.040),smoothstep(-.15,.8,r.y));
    // Diffused studio softboxes with natural Gaussian penumbra, avoiding harsh rectangular box boundaries
    float vertical=exp(-((r.x+.20)*(r.x+.20)+(r.y-.12)*(r.y-.12)*.08)*18.0);
    float edge=exp(-((r.x-.63)*(r.x-.63)*4.5+(r.y-.15)*(r.y-.15)*.12)*16.0);
    float top=pow(max(0.0,dot(r,normalize(vec3(-.3,.86,.30)))),24.0);
    c+=vec3(2.4,2.2,1.8)*vertical;
    c+=vec3(1.6,1.75,1.95)*edge;
    c+=vec3(1.5,1.25,.95)*top;
    return c;
}
// A rough surface reflects broad studio light, not razor-sharp painted loops.
// Five direction samples are deterministic analytical lighting, never imagery.
vec3 roughRoom(vec3 r,float rough){
    vec3 tangent=normalize(cross(r,abs(r.y)<.9?vec3(0,1,0):vec3(1,0,0)));
    vec3 bitangent=cross(r,tangent);float spread=.014+rough*rough*.42;
    return room(r)*.36+(room(normalize(r+tangent*spread))+room(normalize(r-tangent*spread))+
        room(normalize(r+bitangent*spread))+room(normalize(r-bitangent*spread)))*.16;
}
float shadowVisibility(sampler2D map,vec4 clip,float bias){
    vec3 p=clip.xyz/clip.w*.5+.5;
    if(clip.w<=0.0||p.x<0.0||p.x>1.0||p.y<0.0||p.y>1.0||p.z<0.0||p.z>1.0)return 1.0;
    float visibility=0.0;
    vec2 step=1.0/vec2(textureSize(map,0));
    const vec2 taps[9]=vec2[9](
        vec2(-.613,.617),vec2(.170,-.040),vec2(-.299,-.792),
        vec2(.646,.493),vec2(-.652,-.274),vec2(.421,-.714),
        vec2(-.817,.271),vec2(.875,-.312),vec2(.028,.994));
    for(int i=0;i<9;i++){
        float d=texture(map,p.xy+taps[i]*step*2.0).r;
        visibility += p.z-bias<d?1.0:0.0;
    }
    return visibility/9.0;
}
float contactOcclusion(){
    if(contact_receiver<.5)return 1.0;
    float result=1.0;
    for(int i=0;i<24;i++){
        if(i>=contact_count)break;
        vec3 p=world_pos-contacts[i].xyz;vec2 radii=max(vec2(contacts[i].w,contact_sizes[i].x),vec2(.025));
        float edge=max(length(p.xz/radii)-1.0,0.0)*min(radii.x,radii.y);
        float occlusion=exp(-edge*edge/.0042)*exp(-p.y*p.y/.0064);
        result=min(result,1.0-.72*occlusion);
    }
    return result;
}
vec3 surfaceBump(vec3 n,float height){
    vec3 dx=dFdx(world_pos),dy=dFdy(world_pos),r1=cross(dy,n),r2=cross(n,dx);
    float determinant=dot(dx,r1);
    vec3 gradient=sign(determinant)*(dFdx(height)*r1+dFdy(height)*r2);
    return normalize(max(abs(determinant),1e-10)*n-gradient);
}
vec3 directBRDF(vec3 n,vec3 v,vec3 l,vec3 base,float rough,float metal,vec3 tangent){
    float nl=max(0.0,dot(n,l)),nv=max(.001,dot(n,v));if(nl<=0.0)return vec3(0);
    vec3 h=normalize(v+l);float nh=max(.001,dot(n,h)),vh=max(0.0,dot(v,h));
    float distribution,geometry;
    if(material_kind>9.5 && material_kind<10.5){
        vec3 t=normalize(tangent-n*dot(n,tangent)),b=normalize(cross(n,t));
        float alphaT=max(.035,rough*rough*2.0),alphaB=max(.025,rough*rough*.42);
        float ht=dot(h,t),hb=dot(h,b),denom=(ht/alphaT)*(ht/alphaT)+(hb/alphaB)*(hb/alphaB)+nh*nh;
        distribution=1.0/(3.14159265*alphaT*alphaB*denom*denom);
        float vtT=dot(v,t)*alphaT,vtB=dot(v,b)*alphaB,ltT=dot(l,t)*alphaT,ltB=dot(l,b)*alphaB;
        float vt=sqrt(vtT*vtT+vtB*vtB)/nv,lt=sqrt(ltT*ltT+ltB*ltB)/nl;
        float lambdaV=.5*(sqrt(1.0+vt*vt)-1.0),lambdaL=.5*(sqrt(1.0+lt*lt)-1.0);
        geometry=1.0/(1.0+lambdaV+lambdaL);
    }else{
        float a=max(.025,rough*rough),a2=a*a,denom=nh*nh*(a2-1.0)+1.0;
        distribution=a2/(3.14159265*denom*denom);
        float k=(rough+1.0)*(rough+1.0)/8.0;
        geometry=(nv/(nv*(1.0-k)+k))*(nl/(nl*(1.0-k)+k));
    }
    // Gold-plated conductor reflectance keeps a warm grazing response instead
    // of the dielectric-like white edge that made the gold read as pale brass.
    vec3 f0=mix(vec3(.04),base,metal);
    vec3 grazing=gold_finish>.5?mix(vec3(1),clamp(base,0.,1.),.60):vec3(1);
    vec3 f=f0+(grazing-f0)*pow(1.0-vh,5.0);
    vec3 spec=f*distribution*geometry/max(.004,4.0*nv*nl);
    vec3 diffuse=(vec3(1)-f)*base*(1.0-metal)/3.14159265;
    // Human-requested matte tabletop: retain diffuse light/contact shadows,
    // without glossy highlights or scene/star reflections on its surface.
    return (diffuse+(matte_support>.5?vec3(0):min(spec,vec3(24.0))))*nl;
}
vec3 sceneEnvironment(vec3 direction,float rough){
    if(environment_ready<.5||environment_pass>.5)return roughRoom(direction,rough)*.06;
    // Asset inspection uses an unbounded studio dome. Sampling the probe by
    // direction avoids parallax-box corners and remains continuous on curved
    // surfaces; the room-box projection below is reserved for GRWM scenes.
    if(studio_environment>.5){
        vec3 encoded=textureLod(environment_map,normalize(direction),clamp(rough,0.0,1.0)*9.0).rgb;
        return min(encoded*.85/max(vec3(.025),vec3(1)-encoded),vec3(12.0));
    }
    // The probe captures the actual lit table, props, curtains and star wall.
    // Its linear tone encoding preserves range in a portable RGBA8 cube map.
    vec3 safeRay=mix(vec3(.00001),direction,step(vec3(.00001),abs(direction)));
    vec3 wall=mix(show_origin+vec3(-12,-1.2,-5),show_origin+vec3(12,8,14),step(vec3(0),direction));
    vec3 distances=(wall-world_pos)/safeRay;float distance=max(.0,min(distances.x,min(distances.y,distances.z)));
    vec3 projected=normalize(world_pos+direction*distance-environment_position);
    vec3 encoded=textureLod(environment_map,projected,clamp(rough,0.0,1.0)*10.0).rgb;
    vec3 probeColor=min(encoded*.85/max(vec3(.025),vec3(1)-encoded),vec3(12.0));
    // Prevent self-reflection artifacts on downward-facing surfaces where the probe (positioned
    // above the stage at Y=0.55 looking down) captured the top of the object. Downward reflections
    // smoothly transition to the analytic studio floor lighting instead of mirroring the top.
    float floorFactor=1.0-smoothstep(-0.25,0.05,direction.y);
    vec3 floorColor=roughRoom(direction,rough)*0.35;
    return mix(probeColor,floorColor,floorFactor);
}
float coneLight(vec3 p,vec3 start,vec3 target,float width){
    vec3 axis=target-start;float t=clamp(dot(p-start,axis)/dot(axis,axis),0.0,1.0);
    float radius=max(.06,width*t);float d=length(p-start-axis*t);
    return exp(-d*d/(radius*radius*1.4));
}
float surfaceNoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(vec3(i,0)),hash(vec3(i+vec2(1,0),0)),f.x),mix(hash(vec3(i+vec2(0,1),0)),hash(vec3(i+vec2(1,1),0)),f.x),f.y);}
/* YMIR_COLOR_GENERATORS */
void main(){
    if(reflection_pass>0.5 && dot(vec4(world_pos,1.0),reflection_clip)<0.005)discard;
    vec3 n=normalize(world_normal);
    if(!gl_FrontFacing)n=-n;
    vec3 tangentRaw=dFdx(world_pos)*dFdy(uv.y)-dFdy(world_pos)*dFdx(uv.y);
    if(length(tangentRaw)<.000001)tangentRaw=cross(n,abs(n.y)<.9?vec3(0,1,0):vec3(1,0,0));
    vec3 surfaceTangent=normalize(tangentRaw-n*dot(n,tangentRaw));
    vec3 brushTangentRaw=vec3(0,1,0)-n*n.y;
    if(length(brushTangentRaw)<.0001)brushTangentRaw=vec3(1,0,0)-n*n.x;
    vec3 brushTangent=normalize(brushTangentRaw);
    vec3 v=normalize(camera_position-world_pos);
    vec3 l=normalize(light_position-world_pos);
    vec3 h=normalize(v+l);
    vec3 albedo=ymirColor(color,color_secondary,color_pattern,uv*color_scale+color_offset,original_pos*color_scale.x+vec3(color_offset,0));
    float rough=roughness;
    float surface_height=0.0;
    float micro=hash(floor(original_pos*240.0));
    float grain=(micro-.5)*.045;
    grain*=1.0-smoothstep(.3,1.2,length(fwidth(original_pos)*240.0));
    if(material_kind<.5){ // smooth dielectric; keep the finish clean and even
        // Smoothness comes from the authored roughness, not synthetic grain.
    }
    else if(material_kind<1.5 && material_kind>.5){ // silk satin: long floats over a fine crossed weave
        float warpPhase=uv.x*240.0+sin(uv.y*24.0)*.28;
        float weftPhase=uv.y*180.0+sin(uv.x*22.0)*.22;
        float aa=exp(-max(abs(fwidth(warpPhase)),abs(fwidth(weftPhase))));
        float warp=sin(warpPhase),weft=sin(weftPhase);
        float weave=(warp*.62+weft*.24+warp*weft*.14)*aa;
        albedo*=1.0+.055*weave;
        rough=clamp(rough+.07*weave,.12,.98);
        surface_height=.00030*weave;
    }
    else if(material_kind<2.5 && material_kind>1.5){ // pressed pigment
        albedo*=1.0+grain*1.4;
        float emboss=sin(uv.x*80.0+sin(uv.y*25.0))*sin(uv.y*48.0);
        albedo*=.97+.03*emboss;
        rough=clamp(rough+.06*emboss,.72,.98);
        surface_height=.00035*emboss;
    }
    else if(material_kind<3.5 && material_kind>2.5){ // glass / reflective vanity
        if(metalness<.5)albedo=mix(albedo,roughRoom(reflect(-v,n),rough),.82);
        rough*=.8;
    }
    else if(material_kind<4.5 && material_kind>3.5){ // powder-puff fibres
        vec2 pilePos=original_pos.xz;
        float clump=surfaceNoise(pilePos*28.0)-.5;
        float nap=(hash(floor(original_pos*48.0))-.5)*(1.0-smoothstep(.35,1.2,length(fwidth(original_pos)*48.0)));
        float fiberPhase=original_pos.x*110.0+sin(original_pos.z*18.0)*.4;
        float fiber=sin(fiberPhase)*exp(-abs(fwidth(fiberPhase)));
        albedo*=1.0+.10*clump+.045*fiber+.06*nap;
        rough=clamp(max(rough,.92)+.025*clump+.02*nap,.88,.99);
        surface_height=.00040*clump+.00020*fiber+.00015*nap;
    }
    else if(material_kind<5.5 && material_kind>4.5){ // code marbled lacquer
        float m=sin(original_pos.x*3.0+sin(original_pos.z*4.0+original_pos.y*2.0)*2.0);
        m=pow(.5+.5*m,4.0);
        rough=clamp(rough+.045*(.5-m),.12,.42);
        surface_height=.000035*(m-.5);
    }
    else if(material_kind<6.5 && material_kind>5.5){ // quilted vanity case
        vec2 cell=fract(uv*vec2(10.0,7.0))-.5;
        float tuft=exp(-dot(cell,cell)*55.0);
        float seam=pow(max(0.0,1.0-abs(sin((uv.x+uv.y)*45.0))),12.0);
        albedo*=1.0-tuft*.22-seam*.065;
        rough=clamp(rough+.06*tuft+.12*seam,.65,.98);
        surface_height=.00065*tuft-.00038*seam;
    }
    else if(material_kind>6.5 && material_kind<7.5){ // clear dielectric glass
        rough=clamp(rough,.04,.25);
    }
    else if(material_kind>7.5 && material_kind<9.5){ // scene-local sewn leather
        vec2 leather=original_pos.xy;
        float pore=sin(leather.x*133.0+sin(leather.y*97.0)*1.7)*sin(leather.y*121.0+sin(leather.x*81.0));
        float poreAA=1.0-smoothstep(.35,1.25,length(fwidth(leather)*133.0));
        float mottling=sin(leather.x*19.0+sin(leather.y*13.0))*sin(leather.y*24.0-leather.x*7.0);
        albedo*=1.0+.065*mottling+.055*pore*poreAA;
        rough+=.065*pore*poreAA+.025*mottling;
        surface_height=.00040*pore*poreAA+.00025*mottling;
        if(material_kind<8.5){
            vec2 diamond=vec2(leather.x+leather.y,leather.x-leather.y)/.35;
            vec2 edge=abs(fract(diamond+.5)-.5);
            vec2 aa=max(fwidth(diamond),vec2(.0008));
            vec2 sewn=1.0-smoothstep(vec2(.018),vec2(.018)+aa,edge);
            float seam=max(sewn.x,sewn.y);
            albedo*=1.0-.22*seam;rough+=.10*seam;
            surface_height-=.0012*seam;
            float dash=.5+.5*sin(leather.y*380.0);
            float dashAA=1.0-smoothstep(.35,1.2,abs(fwidth(leather.y))*380.0);
            albedo+=vec3(.065,.072,.08)*seam*dash*dashAA;
        }
        rough=clamp(rough,.30,.85);
    }
    else if(material_kind>9.5 && material_kind<10.5){ // object-aligned brushing avoids UV-pole banding
        float brushCoord=original_pos.x+.003*sin(original_pos.z*12.0)+.001*sin(original_pos.y*9.0);
        float brushPhase=brushCoord*110.0;
        float aa=exp(-abs(fwidth(brushPhase)));
        float stroke=sin(brushPhase)*aa;
        float broadWear=sin(brushCoord*14.0+sin(original_pos.z*4.0))*.5;
        albedo*=1.0+.12*stroke+.025*broadWear;
        rough=clamp(rough+.08*stroke,.12,.98);
        surface_height=.00022*stroke;
    }
    else if(material_kind>10.5 && material_kind<12.5){ // granular pressed powder
        vec2 p=original_pos.xy;
        float broad=sin(p.x*37.0+sin(p.y*23.0))*sin(p.y*41.0-p.x*11.0);
        float pores=hash(vec3(floor(p*vec2(130.0,127.0)),0.0));
        float aa=1.0-smoothstep(.35,1.4,length(fwidth(p)*130.0));
        float fleck=(pores-.5)*aa;
        albedo*=1.0+.040*broad+.22*fleck;
        rough=clamp(rough+.12*fleck+.035*broad,.52,.98);
        surface_height=.00018*broad+.00011*fleck;
        if(material_kind>11.5){
            float mica=smoothstep(.82,.99,pores)*aa;
            albedo+=vec3(.11,.09,.075)*mica;
            rough=clamp(rough-.16*mica,.48,.88);
        }
    }
    else if(material_kind>12.5 && material_kind<13.5){ // speckled molded bakelite
        float cloud=sin(original_pos.x*13.0+sin(original_pos.y*17.0))*sin(original_pos.z*19.0+original_pos.y*8.0);
        float aa=1.0-smoothstep(.35,1.4,length(fwidth(original_pos)*120.0));
        float speck=hash(floor(original_pos*120.0));
        albedo*=1.0+.055*cloud+.12*(speck-.5)*aa;
        rough=clamp(rough+.025*cloud+.06*(speck-.5)*aa,.18,.6);
        surface_height=.00018*cloud+.00010*(speck-.5)*aa;
    }
    else if(material_kind>13.5 && material_kind<14.5){ // longitudinal brush fibres
        float angle=atan(original_pos.z,original_pos.x);
        float aa=1.0-smoothstep(.3,1.5,abs(fwidth(angle))*72.0);
        float fibre=sin(angle*72.0+original_pos.y*1.4)*aa;
        albedo*=1.0+.105*fibre+grain;
        albedo+=vec3(.055,.038,.025)*pow(1.0-abs(dot(n,v)),2.0);
        rough=clamp(rough+.045*fibre,.78,1.0);
        surface_height=.00016*fibre;
    }
    else if(material_kind>14.5 && material_kind<15.5){ // readable woven silk swatch
        vec2 p=original_pos.xz;
        float aa=exp(-max(fwidth(p.x)*140.0,fwidth(p.y)*120.0));
        float weave=sin(p.x*140.0+sin(p.y*18.0)*.3)*sin(p.y*120.0)*aa;
        albedo*=1.0+.10*weave;
        rough=clamp(rough+.12*weave,.22,.8);
        surface_height=.00026*weave;
    }
    else if(material_kind>15.5 && material_kind<16.5){ // shared approved lacquered timber
        vec2 p=original_pos.xz;
        float drift=.55*sin(p.y*.75)+.16*sin(p.y*2.1);
        float slow=sin(p.x*9.0+drift*1.3);
        float aa=exp(-abs(fwidth(p.x))*74.0);
        float grainLine=sin(p.x*74.0+drift*2.4+sin(p.x*13.0)*.55)*aa;
        float fineAA=exp(-abs(fwidth(p.x))*137.0);
        float fine=sin(p.x*137.0+drift*3.0+p.y*.35)*fineAA;
        // Elongated restrained wood fibres remain visible in the shot, while
        // high frequencies fade continuously rather than crawling/moire.


        rough=clamp(rough+.035*slow+.045*grainLine,.24,.46);
        surface_height=.00045*grainLine+.00015*fine;
    }
    else if(material_kind>16.5 && material_kind<17.5){ // tilted brush-local fibres
        // Lathe UV follows the actual leaned brush axis; world/local XYZ angle
        // would bend broad bands across the rotated bundle like a rubber bulb.
        float density=96.0;
        float aa=1.0-smoothstep(.12,.55,abs(fwidth(uv.x))*density);
        float fibre=sin(uv.x*6.2831853*density+uv.y*.7)*aa;
        albedo*=1.0+.085*fibre+grain;
        albedo+=vec3(.055,.038,.025)*pow(1.0-abs(dot(n,v)),2.0);
        rough=clamp(rough+.035*fibre,.78,1.0);
        surface_height=.00015*fibre;
    }
    else if(material_kind>17.5 && material_kind<18.5){ // horizontal finale rouge
        vec2 p=original_pos.xz;
        float pores=hash(vec3(floor(p*vec2(127.0,139.0)),0.0));
        float aa=1.0-smoothstep(.35,1.4,length(fwidth(p)*139.0));
        float press=sin(p.x*39.0+sin(p.y*21.0))*sin(p.y*43.0-p.x*8.0);
        float fleck=(pores-.5)*aa;
        albedo*=1.0+.045*press+.25*fleck;
        rough=clamp(rough+.13*fleck,.68,.98);
        albedo+=vec3(.075,.042,.022)*smoothstep(.90,.995,pores)*aa;
        surface_height=.00016*press+.00010*fleck;
    }
    else if(material_kind>18.5 && material_kind<19.5){ // engine-turned gold shell
        float r=length(original_pos.xz);
        vec2 u=r>1e-6?original_pos.xz/r:vec2(1.0,0.0);
        // Compute sin(24a) and sin(32a) analytically via polynomial angle-doubling,
        // eliminating the atan(z,x) branch cut jump and the resulting dFdx/dFdy normal crease.
        vec2 u2=vec2(u.x*u.x-u.y*u.y,2.0*u.x*u.y);
        vec2 u4=vec2(u2.x*u2.x-u2.y*u2.y,2.0*u2.x*u2.y);
        vec2 u8=vec2(u4.x*u4.x-u4.y*u4.y,2.0*u4.x*u4.y);
        float sin24=3.0*u8.y-4.0*u8.y*u8.y*u8.y;
        vec2 u16=vec2(u8.x*u8.x-u8.y*u8.y,2.0*u8.x*u8.y);
        float sin32=2.0*u16.x*u16.y;
        float poleFade=smoothstep(0.0,0.05,r);
        float cut=sin(r*92.0+sin24*1.7*poleFade);
        float aa=exp(-length(fwidth(original_pos.xz))*92.0);
        float facets=sin32*aa*poleFade;
        albedo*=1.0+.075*cut*aa+.035*facets;
        rough=clamp(rough+.065*cut*aa,.24,.45);
        surface_height=.00012*cut*aa*poleFade;
    }
    else if(material_kind>19.5 && material_kind<20.5){ // readable short velvet nap
        float aa=exp(-length(fwidth(original_pos.xz))*125.0);
        float nap=(hash(floor(original_pos*125.0))-.5)*aa;
        float cloud=sin(original_pos.x*25.0+sin(original_pos.z*18.0))*sin(original_pos.z*31.0);
        albedo*=1.0+.11*nap+.035*cloud;
        albedo+=albedo*.16*pow(1.0-abs(dot(n,v)),2.0);
        rough=.96;
        surface_height=.00012*cloud+.00010*nap;
    }
    else if(material_kind>20.5 && material_kind<21.5){ // flowing silk / sewn band
        float warp=uv.x*420.0,weft=uv.y*125.0;
        float aa=exp(-max(fwidth(warp),fwidth(weft)));
        float weave=sin(warp+sin(weft*.12)*.35)*sin(weft)*aa;
        albedo*=1.0+.10*weave;
        rough=clamp(rough+.08*weave,.24,.68);
        surface_height=.00022*weave;
    }
    else if(material_kind>21.5 && material_kind<22.5){ // softly moulded wax
        float aa=exp(-length(fwidth(original_pos))*155.0);
        float wax=(hash(floor(original_pos*155.0))-.5)*aa;
        albedo*=1.0+.07*wax;
        rough=clamp(rough+.055*wax,.24,.55);
        surface_height=.00009*wax;
    }
    else if(material_kind>22.5 && material_kind<23.5){ // cotton: matte, regular crossed plain weave
        float warpPhase=uv.x*270.0+sin(uv.y*32.0)*.15,weftPhase=uv.y*250.0+sin(uv.x*27.0)*.12;
        float aa=exp(-max(abs(fwidth(warpPhase)),abs(fwidth(weftPhase))));
        float warp=sin(warpPhase),weft=sin(weftPhase),weave=(warp*.55+weft*.35+warp*weft*.10)*aa;
        albedo*=1.0+.045*weave;
        rough=clamp(rough+.06*weave,.76,.99);
        surface_height=.00038*weave;
    }
    else if(material_kind>23.5 && material_kind<24.5){ // hemp: coarse irregular crossed fibres
        float warpPhase=uv.x*150.0+sin(uv.y*30.0)*.7,weftPhase=uv.y*130.0+sin(uv.x*34.0)*.7;
        float aa=exp(-max(abs(fwidth(warpPhase)),abs(fwidth(weftPhase))));
        float weave=sin(warpPhase)*sin(weftPhase)*aa;
        float broad=sin(uv.x*28.0+uv.y*11.0+sin(uv.y*7.0));
        albedo*=1.0+.06*weave+.035*broad;
        rough=clamp(rough+.10*weave+.04*broad,.78,1.0);
        surface_height=.00085*weave+.00035*broad;
    }
    else if(material_kind>24.5 && material_kind<25.5){
        float trowel=surfaceNoise(original_pos.xy*1.6)-.5;
        float stipple=surfaceNoise(original_pos.xy*9.)-.5;
        float mineral=(surfaceNoise(original_pos.xy*43.)-.5)*(1.-smoothstep(.3,1.4,length(fwidth(original_pos.xy)*43.)));
        albedo*=1.+.075*trowel+.12*stipple+.12*mineral;
        rough=clamp(rough+.03*stipple,.82,.98);surface_height=.0012*trowel+.0005*stipple;
    }
    else {albedo*=1.0+grain*(1.0-metalness);}
    n=surfaceBump(n,surface_height);rough=clamp(rough,.12,.98);
    float diffuse=max(0.0,dot(n,l)),nv=max(.001,dot(n,v));
    vec3 f0=mix(vec3(.04),albedo,metalness);
    float fres=pow(1.0-max(0.0,dot(n,v)),5.0);
    float ao=contactOcclusion();
    float keyShadow=shadowVisibility(shadow_map,shadow_pos,.00045+(1.0-diffuse)*.00025);
    float keyDistance=length(light_position-world_pos);
    vec3 keyRadiance=vec3(1.0,.93,.81)*key_gain*160.0/(1.0+keyDistance*keyDistance);
    vec3 c=directBRDF(n,v,l,albedo,rough,metalness,brushTangent)*keyRadiance*keyShadow;
    vec3 startA=show_origin+vec3(-2.9,4.9,-2.5),startB=show_origin+vec3(2.9,4.9,-2.8);
    vec3 la=normalize(startA-world_pos),lb=normalize(startB-world_pos);
    float coneA=coneLight(world_pos-show_origin,vec3(-2.9,4.9,-2.5),show_target_a,show_cones.x);
    float coneB=coneLight(world_pos-show_origin,vec3(2.9,4.9,-2.8),show_target_b,show_cones.y);
    float shadowA=shadowVisibility(shadow_map_a,light_matrix_a*vec4(world_pos,1),.000055+.000085*(1.0-max(0.0,dot(n,la))));
    float shadowB=shadowVisibility(shadow_map_b,light_matrix_b*vec4(world_pos,1),.000055+.000085*(1.0-max(0.0,dot(n,lb))));
    vec3 radianceA=show_color_a*coneA*show_cones.z*230.0/(1.0+dot(startA-world_pos,startA-world_pos));
    vec3 radianceB=show_color_b*coneB*show_cones.w*230.0/(1.0+dot(startB-world_pos,startB-world_pos));
    c+=directBRDF(n,v,la,albedo,rough,metalness,brushTangent)*radianceA*shadowA;
    c+=directBRDF(n,v,lb,albedo,rough,metalness,brushTangent)*radianceB*shadowB;
    // Low environment fill, not uniformly bright paint in the shadows.
    c+=albedo*(1.0-metalness)*vec3(.022,.020,.019)*(.55+.45*max(0.0,n.y))*ao;
    if((material_kind>3.5 && material_kind<4.5)||(material_kind>19.5 && material_kind<20.5)){
        bool longPile=material_kind<4.5;
        float sheenRough=longPile?.72:.86,alphaG=sheenRough*sheenRough,invR=1.0/alphaG;
        float sheenNdotH=max(0.0,dot(n,h));
        float sheenD=(2.0+invR)*pow(max(0.0,1.0-sheenNdotH*sheenNdotH),invR*.5)/6.2831853;
        float sheenV=1.0/max(4.0*(diffuse+nv-diffuse*nv),.001);
        c+=albedo*(longPile?.28:.16)*sheenD*sheenV*diffuse*keyRadiance*keyShadow;
    }
    if(matte_support<.5){
        vec3 reflectedEnvironment=sceneEnvironment(reflect(-v,n),rough);
        vec3 grazingEnvironment=gold_finish>.5?mix(vec3(1),clamp(albedo,0.,1.),.60):vec3(1);
        vec3 environmentF=f0+(max(grazingEnvironment*(1.0-rough),f0)-f0)*fres;
        c+=reflectedEnvironment*environmentF*(.80-.25*rough)*ao;
    }
    c+=sceneEnvironment(n,1.0)*albedo*(1.0-metalness)*.10*ao;
    if(material_kind>0.5 && material_kind<1.5){
        vec3 across=normalize(cross(n,surfaceTangent));
        float satin=pow(max(0.0,1.0-pow(dot(h,across),2.0)),18.0);
        c+=albedo*.12*satin*diffuse*keyShadow;
    }else if(material_kind>20.5 && material_kind<21.5){
        vec3 across=normalize(cross(n,surfaceTangent));
        float satin=pow(max(0.0,1.0-pow(dot(h,across),2.0)),12.0);
        c+=albedo*.055*satin*diffuse*keyShadow;
    }
    c*=ao*(1.0+rig_lighting.x*.25);
    float final_alpha=opacity;
    if(material_kind>6.5 && material_kind<7.5){
        float glass_fres=.04+.96*fres;
        c=sceneEnvironment(reflect(-v,n),max(.08,rough))*glass_fres+albedo*diffuse*.025;
        c+=directBRDF(n,v,l,vec3(.96),.14,0.0,surfaceTangent)*keyRadiance*keyShadow*.65;
        final_alpha=.12+glass_fres*.75;
    }
    if(linear_capture>.5){frag=vec4(c/(c+vec3(.85)),1.0);return;}
    if(reflection_enabled>0.5){
        vec4 q=reflection_matrix*vec4(world_pos,1.0);vec2 st=q.xy/q.w*.5+.5;
        // True rendered reflection with slight optical softness, not a perfect
        // pasted scene. The target is display encoded: no second tone curve.
        vec2 texel=1.2/vec2(textureSize(reflection_map,0));
        vec3 reflected=texture(reflection_map,st).rgb*.44;
        reflected+=(texture(reflection_map,st+vec2(texel.x,0)).rgb+texture(reflection_map,st-vec2(texel.x,0)).rgb+
            texture(reflection_map,st+vec2(0,texel.y)).rgb+texture(reflection_map,st-vec2(0,texel.y)).rgb)*.14;
        vec2 p=vec2(cos(uv.x*6.2831853),sin(uv.x*6.2831853))*uv.y;
        float grazing=pow(1.0-abs(dot(n,v)),3.0);
        float sheen=exp(-pow(p.x*.75+p.y*.43-.22-rig_lighting.z*.18,2.0)*26.0);
        float aa=1.0-smoothstep(.3,1.2,length(fwidth(p)*110.0));
        float glimmer=smoothstep(.993,.9999,hash(vec3(floor(p*110.0),0.0)))*aa;
        vec3 glass=reflected*vec3(.94,.95,.97);
        glass+=vec3(.96,.91,.80)*(.008+.027*grazing+.025*sheen);
        glass+=min(room(reflect(-v,n)),vec3(1.0))*.018;
        glass+=vec3(1.0,.93,.81)*glimmer*(.012+.012*show_energy);
        frag=vec4(mix(clamp(glass,0.0,1.0),vec3(.15,1.,.75),selection_highlight*.35),1.0);return;
    }
    float fog=1.0-exp(-max(0.0,length(world_pos-camera_position)-8.0)*fog_density);
    c=mix(c,background*.20+(show_color_a+show_color_b)*.018,min(fog,.16));
    c*=exposure;
    c=c/(c+vec3(.85));
    c=pow(c,vec3(1.0/2.2));
    c=mix(vec3(dot(c,vec3(.2126,.7152,.0722))),c,1.18);
    frag=vec4(mix(c,vec3(.15,1.,.75),selection_highlight*.35),final_alpha);
}
