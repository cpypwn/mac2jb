#version 450
#extension GL_GOOGLE_include_directive : require
layout(location=0) out vec4 outColor;
#define STATE_ACCESS readonly
#include "abi.glsl"
#include "layout.glsl"
#include "text.glsl"
#include "draw.glsl"
layout(set=0,binding=1,std430) readonly buffer ChipStorage {uint words[];} chip;

void main(){
 vec2 p=gl_FragCoord.xy;
 const vec3 mint=vec3(.58,.96,.77);
 const vec3 ink=vec3(.90,.98,.94);
 const vec3 muted=vec3(.62,.75,.69);
 vec3 color=mix(vec3(.022,.075,.063),vec3(.010,.044,.039),p.y/1080.0);
 float shell=box(p,vec2(960,546),vec2(690,385),24.0);
 color=mix(color,vec3(.043,.135,.112),fill(shell));
 color=mix(color,vec3(.14,.28,.23),line(shell,1.0));
 float screen=box(p,vec2(960,544),vec2(644,324),8.0);
 color=mix(color,vec3(.006,.030,.026),fill(screen));
 if(p.x>=320.0&&p.x<1600.0&&p.y>=224.0&&p.y<864.0){
  uint px=uint((p.x-320.0)/20.0),py=31u-uint((p.y-224.0)/20.0);
  uint word=chip.words[C8_DISPLAY+py*2u+px/32u];
  float on=float((word>>(31u-px%32u))&1u);
  color=mix(color,mint,on);
 }
 color=mix(color,ink,text(p,vec2(320,70),TEXT_TITLE));
 color=mix(color,muted,text(p,vec2(324,142),TEXT_SUBTITLE));
 color=mix(color,muted,text(p,vec2(320,948),TEXT_HELP));
 bool clockReady=chip.words[2]==31250000u&&chip.words[C8_STATE+C8_CLOCK_READY]!=0u;
 ivec4 status=clockReady?TEXT_CLOCK:TEXT_FALLBACK;
 color=mix(color,clockReady?mint:muted,text(p,vec2(1600-status.z,143),status));
 if(chip.words[C8_STATE+C8_HALTED]!=0u){
  float error=box(p,vec2(960,544),vec2(330,68),16.0);
  color=mix(color,vec3(.30,.08,.08),fill(error));
  color=mix(color,ink,text(p,vec2(960-TEXT_HALTED.z/2,530),TEXT_HALTED));
 }
 outColor=vec4(color*(1.0-c.transition.x),1.0);
}
