#version 450
#extension GL_GOOGLE_include_directive : require
layout(location=0) out vec4 outColor;
#define STATE_ACCESS readonly
#include "launcher-state.glsl"
#define HB_READONLY
#include "hb.glsl"
#include "launcher-text.glsl"
#include "draw.glsl"

float catalogText(vec2 p,vec2 origin,uint index,bool description,float offset,float visibleWidth){
 ivec2 q=ivec2(floor(p-origin));uint base=524288u+index*32768u,meta=base+31744u;
 uint width=c.atlas[meta+(description?2u:0u)],height=c.atlas[meta+(description?3u:1u)];
 if(any(lessThan(p-origin,vec2(0)))||q.x>=int(visibleWidth)||q.y>=int(height))return 0.0;
 uint sourceX=uint(q.x+int(offset));if(sourceX>=width)return 0.0;
 uint pixel=uint(q.y)*(description?2048u:512u)+sourceX;
 uint word=c.atlas[base+(description?6144u:0u)+(pixel>>2u)];
 return float((word>>((pixel&3u)*8u))&255u)/255.0;
}
vec4 catalogIcon(vec2 p,vec2 center,uint index){
 ivec2 q=ivec2(floor((p-center+vec2(36))*96.0/72.0));
 if(any(lessThan(q,ivec2(0)))||any(greaterThanEqual(q,ivec2(96))))return vec4(0);
 return unpackUnorm4x8(c.atlas[524288u+index*32768u+22528u+uint(q.y*96+q.x)]);
}
void main(){
 vec2 p=gl_FragCoord.xy;
 float t=c.motion.x;
 float contrast=clamp(c.transition.z,0.0,1.0);
 const vec3 mint=vec3(.58,.96,.77);
 const vec3 ink=vec3(.90,.98,.94);
 const vec3 muted=vec3(.62,.75,.69);
 vec3 background=mix(vec3(.025,.10,.085),vec3(.012,.058,.052),contrast);
 vec3 panel=mix(vec3(.052,.16,.136),vec3(.035,.115,.101),contrast);
 vec3 border=mix(vec3(.14,.29,.245),vec3(.12,.25,.21),contrast);
 vec3 col=background;
 float glow=exp(-length((p-vec2(1640,130))/vec2(1150,600))*2.2);
 col+=mint*glow*.045;
 col=mix(col,mint,fill(box(p,vec2(40,170),vec2(4,77),4.0))*.95);
 col=mix(col,ink,text(p,vec2(158,112),TEXT_TITLE));
 col=mix(col,muted,text(p,vec2(164,187),TEXT_SUBTITLE));
 vec2 refresh=p-vec2(1660,179);
 col=mix(col,panel,fill(length(refresh)-62.0));
 col=mix(col,border,line(length(refresh)-62.0,1.2));
 float turn=c.refresh.y;
 vec2 arrow=mat2(cos(turn),-sin(turn),sin(turn),cos(turn))*refresh;
 float arc=line(length(arrow)-31.0,2.7)*smoothstep(-2.5,-2.42,atan(arrow.y,arrow.x));
 vec2 tip=arrow-vec2(-31.0,0.0);
 float head=fill(max(max(tip.y-5.0,-tip.y*.5+tip.x*.866-5.0),-tip.y*.5-tip.x*.866-5.0));
 col=mix(col,mint,max(arc,head));
 uint count=min(c.library.x,32u);
 uint first=uint(floor(clamp(c.transition.w,0.0,28.0)));
 for(int i=0;i<5;i++){
  uint index=first+uint(i);if(index>=count||p.y<350.0||p.y>950.0)continue;
  bool installed=index<c.reserved.w;
  float y=424.0+(float(index)-c.transition.w)*151.0;
  float selected=c.state.x==index?1.0:0.0;
  float d=box(p,vec2(960,y),vec2(660,62),18.0);
  float pulse=.5+.5*sin(t*2.8);
  float aura=exp(-max(d,0.0)/18.0)*selected*(.075+.065*pulse);
  col+=mint*aura;
  col=mix(col,mix(panel,vec3(.073,.216,.177),selected),fill(d));
  col=mix(col,mix(border,mint,selected*(.68+.32*pulse)),line(d,1.3+selected*(.7+.45*pulse)));
  float tile=box(p,vec2(370,y),vec2(43,43),12.0);
  col=mix(col,mix(vec3(.09,.23,.19),vec3(.12,.31,.24),selected),fill(tile));
  if(installed){
   vec4 icon=catalogIcon(p,vec2(370,y),index);
   col=mix(col,icon.rgb,icon.a);
   col=mix(col,ink,catalogText(p,vec2(450,y-30),index,false,0.0,512.0));
   uint descWidth=c.atlas[524288u+index*32768u+31746u];
   float overflow=max(0.0,float(descWidth)-1080.0);
   float offset=0.0;
   if(overflow>0.0&&selected>0.0){
    float travel=overflow/55.0;
    float phase=mod(max(0.0,float(c.state.z-c.stats.y)/60.0),2.0*travel+2.0);
    if(phase>=1.0&&phase<1.0+travel)offset=(phase-1.0)*55.0;
    else if(phase>=1.0+travel&&phase<2.0+travel)offset=overflow;
    else if(phase>=2.0+travel)offset=overflow-(phase-2.0-travel)*55.0;
   }
   col=mix(col,muted,catalogText(p,vec2(452,y+18),index,true,offset,1080.0));
   if(overflow>1.0){
    float rightDots=min(length(p-vec2(1541,y+33)),min(length(p-vec2(1549,y+33)),length(p-vec2(1557,y+33))));
    col=mix(col,muted,fill(rightDots-1.8)*float(offset<overflow-1.0));
    float leftDots=min(length(p-vec2(427,y+33)),min(length(p-vec2(435,y+33)),length(p-vec2(443,y+33))));
    col=mix(col,muted,fill(leftDots-1.8)*float(offset>1.0));
   }
  }else{
   float plus=min(box(p,vec2(370,y),vec2(11,1),1.0),box(p,vec2(370,y),vec2(1,11),1.0));
   col=mix(col,mint,fill(plus)*.7);
   col=mix(col,muted,fill(box(p,vec2(574,y-12),vec2(124,5),5))*.35);
   col=mix(col,muted,fill(box(p,vec2(530,y+13),vec2(80,3),3))*.25);
  }
  col=mix(col,mint,fill(box(p,vec2(306,y),vec2(3,32),3.0))*selected);
 }
 if(count==0u){
  float empty=box(p,vec2(960,650),vec2(660,180),22.0);
  col=mix(col,panel,fill(empty));
  col=mix(col,border,line(empty,1.0));
  float circle=length(p-vec2(960,602))-58.0;
  col=mix(col,mint,line(circle,2.0));
  col=mix(col,mint,fill(box(p,vec2(960,602),vec2(23,3),2.0)));
  col=mix(col,mint,fill(box(p,vec2(960,602),vec2(3,23),2.0)));
  col=mix(col,ink,text(p,vec2(960.0-float(TEXT_NOTITLES.z)*.5,718),TEXT_NOTITLES));
  col=mix(col,muted,text(p,vec2(960.0-float(TEXT_EMPTYHINT.z)*.5,768),TEXT_EMPTYHINT));
 }
 col=mix(col,border,line(p.y-967.0,1.0));
 if(count>0u){
  col=mix(col,mint,line(length(p-vec2(1610,1017))-14.0,1.2));
  col=mix(col,mint,text(p,vec2(1604,1011),TEXT_BUTTON_A));
  col=mix(col,ink,text(p,vec2(1635,1009),TEXT_SELECT));
 }
 col=mix(col,mint,line(length(p-vec2(1780,1017))-14.0,1.2));
 col=mix(col,mint,text(p,vec2(1775,1011),TEXT_BUTTON_B));
 col=mix(col,ink,text(p,vec2(1805,1009),TEXT_BACK));
 float sw=box(p,vec2(960,1017),vec2(86,20),20.0);
 col=mix(col,panel,fill(sw));
 col=mix(col,border,line(sw,1.1));
 col=mix(col,mint,fill(length(p-vec2(mix(920.0,1000.0,contrast),1017))-15.0));
 float modal=c.motion.z;
 if(modal>.001){
  col=mix(col,background,modal*.68);
  float d=box(p,vec2(960,540),vec2(390,154),24.0);
  col=mix(col,panel,fill(d)*modal);
  col=mix(col,mint,line(d,1.3)*modal);
  col=mix(col,ink,text(p,vec2(795,461),TEXT_EMPTY)*modal);
  col=mix(col,muted,text(p,vec2(769,527),TEXT_DETAIL)*modal);
  col=mix(col,mint,text(p,vec2(878,611),TEXT_CLOSE)*modal);
 }
 if(c.game.x!=0u&&c.stats.w!=0u){
  vec2 q=p-c.flow.xy;
  float cursor=min(stroke(q,vec2(0),vec2(0,28)),min(stroke(q,vec2(0),vec2(22,20)),stroke(q,vec2(0,28),vec2(22,20))));
  col=mix(col,background,fill(cursor-3.8));
  col=mix(col,mint,fill(cursor-1.7));
 }
 col=mix(col,muted,text(p,vec2(36,1024),TEXT_VERSION)*.7);
 outColor=vec4(col*(1.0-c.transition.x),1.0);
}
