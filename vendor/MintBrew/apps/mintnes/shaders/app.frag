#version 450
#extension GL_GOOGLE_include_directive : require
layout(location=0) out vec4 outColor;
#define STATE_ACCESS readonly
#include "abi.glsl"
#include "layout.glsl"
#include "text.glsl"
#include "draw.glsl"
layout(set=0,binding=1,std430) readonly buffer NesStorage {uint words[];} nes;

vec3 nesColor(uint i){
 const vec3 colors[64]=vec3[64](
  vec3(.49,.49,.49),vec3(.00,.00,.99),vec3(.00,.00,.74),vec3(.27,.16,.74),
  vec3(.58,.00,.52),vec3(.66,.00,.13),vec3(.66,.06,.00),vec3(.53,.08,.00),
  vec3(.31,.19,.00),vec3(.00,.47,.00),vec3(.00,.41,.00),vec3(.00,.35,.00),
  vec3(.00,.25,.35),vec3(.00,.00,.00),vec3(.00,.00,.00),vec3(.00,.00,.00),
  vec3(.74,.74,.74),vec3(.00,.47,.97),vec3(.00,.35,.97),vec3(.40,.27,.97),
  vec3(.73,.19,.85),vec3(.89,.17,.43),vec3(.86,.25,.12),vec3(.73,.33,.00),
  vec3(.47,.47,.00),vec3(.00,.70,.00),vec3(.00,.66,.00),vec3(.00,.66,.27),
  vec3(.00,.53,.53),vec3(.00,.00,.00),vec3(.00,.00,.00),vec3(.00,.00,.00),
  vec3(.97,.97,.97),vec3(.24,.70,.97),vec3(.27,.60,.97),vec3(.60,.53,.97),
  vec3(.87,.48,.97),vec3(.97,.45,.67),vec3(.97,.53,.41),vec3(.97,.70,.25),
  vec3(.97,.73,.16),vec3(.62,.89,.20),vec3(.35,.87,.40),vec3(.30,.89,.66),
  vec3(.00,.81,.87),vec3(.49,.49,.49),vec3(.00,.00,.00),vec3(.00,.00,.00),
  vec3(.97,.97,.97),vec3(.65,.85,.97),vec3(.68,.80,.97),vec3(.81,.76,.97),
  vec3(.93,.75,.97),vec3(.97,.72,.84),vec3(.97,.78,.68),vec3(.97,.86,.56),
  vec3(.97,.89,.55),vec3(.82,.95,.57),vec3(.69,.94,.67),vec3(.67,.95,.81),
  vec3(.61,.91,.93),vec3(.74,.74,.74),vec3(.00,.00,.00),vec3(.00,.00,.00));
 return colors[min(i,63u)];
}
float romName(vec2 p,uint row){
 vec2 origin=vec2(638.0,240.0+float(row)*38.0);
 ivec2 q=ivec2(floor(p-origin));
 if(q.x<0||q.x>=640||q.y<0||q.y>=20)return 0.0;
 uint column=uint(q.x/16),code=nes.words[NES_MENU_TEXT+row*48u+column]&255u;
 if(code<32u||code>126u)return 0.0;
 uint glyph=code-32u,px=uint(q.x%16),py=uint(q.y);
 uint index=(256u+(glyph/48u)*24u+py)*1024u+(glyph%48u)*16u+px;
 return float((c.atlas[index>>2u]>>((index&3u)*8u))&255u)/255.0;
}
void main(){
 vec2 p=gl_FragCoord.xy;
 vec3 color=mix(vec3(.019,.068,.056),vec3(.010,.040,.035),p.y/1080.0);
 float shell=box(p,vec2(960,540),vec2(426,390),22.0);
 color=mix(color,vec3(.047,.134,.110),fill(shell));
 color=mix(color,vec3(.16,.33,.26),line(shell,1.0));
 if(nes.words[19u]!=0u){
  color=mix(color,vec3(.91,.98,.94),text(p,vec2(638,172),TEXT_MENU));
  uint count=min(nes.words[21u],16u);
  if(count==0u)color=mix(color,vec3(.66,.78,.72),text(p,vec2(638,250),TEXT_EMPTY));
  for(uint row=0u;row<16u;row++){
   if(row>=count)break;
   bool selected=row==nes.words[20u];
   float item=box(p,vec2(960.0,251.0+float(row)*38.0),vec2(340.0,17.0),8.0);
   if(selected){color=mix(color,vec3(.12,.29,.23),fill(item));color=mix(color,vec3(.58,.96,.77),line(item,1.0));}
   color=mix(color,selected?vec3(.75,1.0,.86):vec3(.70,.83,.76),romName(p,row));
  }
  color=mix(color,vec3(.66,.78,.72),text(p,vec2(576,949),TEXT_MENU_HELP));
 }else{
  if(p.x>=576.0&&p.x<1344.0&&p.y>=180.0&&p.y<900.0){
   uint x=uint((p.x-576.0)/3.0),y=239u-uint((p.y-180.0)/3.0);
   color=nesColor(nes.words[NES_FRAMEBUFFER+y*256u+x]&63u);
  }
  color=mix(color,vec3(.66,.78,.72),text(p,vec2(576,949),TEXT_HELP));
 }
 color=mix(color,vec3(.91,.98,.94),text(p,vec2(576,72),TEXT_TITLE));
 color=mix(color,vec3(.66,.78,.72),text(p,vec2(578,137),TEXT_SUBTITLE));
 if(nes.words[19u]==0u&&nes.words[6u]!=0u){
  float error=box(p,vec2(960,540),vec2(284,53),10.0);
  color=mix(color,vec3(.27,.08,.08),fill(error));
  color=mix(color,vec3(.98,.93,.91),text(p,vec2(960-TEXT_HALTED.z/2,528),TEXT_HALTED));
 }
 outColor=vec4(color*(1.0-c.transition.x),1.0);
}
