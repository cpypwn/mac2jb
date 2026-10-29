#version 450
#extension GL_GOOGLE_include_directive : require
layout(location=0) out vec4 outColor;
#define STATE_ACCESS readonly
#define HB_READONLY
#include "abi.glsl"
#include "hb.glsl"
#include "draw.glsl"
#include "text.glsl"
float digit(vec2 p,vec2 origin,uint n){return text(p,origin,ivec4(int(n)*40,DIGIT_Y,40,64));}
uint digits(uint n){uint count=1u;for(int i=0;i<9;i++){if(n<10u)break;n/=10u;count++;}return count;}
float number(vec2 p,inout vec2 origin,uint n){uint div=1u;for(int i=0;i<9;i++){if(n/div<10u)break;div*=10u;}float a=0.0;for(int i=0;i<10;i++){a=max(a,digit(p,origin,n/div));origin.x+=33.0;n%=div;if(div==1u)break;div/=10u;}return a;}
float arrow(vec2 p,vec2 a,vec2 b,float thickness){
 vec2 dir=normalize(b-a),normal=vec2(-dir.y,dir.x);
 return fill(min(stroke(p,a,b),min(stroke(p,b,b-dir*22.0+normal*22.0),stroke(p,b,b-dir*22.0-normal*22.0)))-thickness);
}
void main(){
 vec2 p=gl_FragCoord.xy;vec3 paper=vec3(.025,.09,.075),blue=vec3(.58,.96,.77),gray=vec3(.60,.75,.67),ink=vec3(.88,.98,.93);
 vec2 cell=mod(p,48.0);float grid=1.0-step(1.0,min(cell.x,cell.y));
 vec3 col=mix(paper,vec3(.06,.16,.13),grid*.35);
 col=mix(col,blue,text(p,vec2(110,100),TEXT_TITLE));col=mix(col,gray,text(p,vec2(113,180),TEXT_SUB));
 uint status=hbFtpState();bool online=status==1u||status==2u;
 ivec4 label=!hbFtpAvailable()?TEXT_WAIT:status==3u?TEXT_ERROR:status==2u?TEXT_TRANSFER:online?(hbFtpClients()>0u?TEXT_CONNECTED:TEXT_ON):TEXT_OFF;
 float badgeWidth=float(label.z)+86.0;vec2 badge=vec2(1810.0-badgeWidth*.5,149);
 col=mix(col,vec3(.09,.20,.16),fill(box(p,badge,vec2(badgeWidth*.5,32),32)));
 col=mix(col,vec3(.18,.36,.29),line(box(p,badge,vec2(badgeWidth*.5,32),32),.6));
 float pulse=status==2u?.65+.35*sin(c.motion.x*5.0):1.0;
 col=mix(col,online?blue:gray,fill(length(p-vec2(1810.0-badgeWidth+27.0,149))-5.0)*pulse);
 col=mix(col,ink,text(p,vec2(1810.0-badgeWidth+48.0,137),label));
 float shadow=box(p,vec2(960,567),vec2(850,260),24);
 col=mix(col,vec3(.28,.62,.44),exp(-max(shadow,0.0)/18.0)*.10);
 float card=box(p,vec2(960,550),vec2(850,260),24);
 col=mix(col,vec3(.075,.17,.14),fill(card));col=mix(col,vec3(.18,.36,.29),line(card,.6));
 float tile=fill(box(p,vec2(404,550),vec2(246,236),16));
 vec3 tileColor=mix(vec3(.09,.30,.22),vec3(.04,.19,.15),clamp((p.y-314.0)/472.0,0.0,1.0)*.65);
 float tileGrid=1.0-step(1.0,min(mod(p.x-158.0,32.0),mod(p.y-314.0,32.0)));
 tileColor=mix(tileColor,blue,tileGrid*.10);
 col=mix(col,tileColor,tile);
 col=mix(col,blue,text(p,vec2(404.0-float(TEXT_FTP.z)*.5,390),TEXT_FTP));
 float travel=status==2u?sin(c.motion.x*2.5)*8.0:0.0;
 col=mix(col,blue,arrow(p,vec2(290+travel,570),vec2(518+travel,570),4.0));
 col=mix(col,vec3(.38,.73,.56),arrow(p,vec2(518-travel,647),vec2(290-travel,647),4.0));
 col=mix(col,gray,text(p,vec2(760,378),TEXT_CONNECTION));
 if(hbFtpAvailable()&&online){
  uint ip=hbFtpAddress();vec2 at=vec2(755,444);float a=0.0;
  for(uint i=0u;i<4u;i++){a=max(a,number(p,at,(ip>>(i*8u))&255u));if(i<3u){a=max(a,digit(p,at,10u));at.x+=24.0;}}
  a=max(a,digit(p,at,11u));at.x+=24.0;a=max(a,number(p,at,hbFtpPort()));col=mix(col,blue,a);
 }else col=mix(col,ink,text(p,vec2(760,465),label));
 col=mix(col,gray,text(p,vec2(760,540),TEXT_LOGIN));
 col=mix(col,blue,fill(box(p,vec2(870,714),vec2(180,36),10)));
 ivec4 action=online?TEXT_STOP:TEXT_START;
 col=mix(col,vec3(.025,.09,.075),text(p,vec2(870.0-float(action.z)*.5,703),action));
 col=mix(col,vec3(.12,.29,.21),fill(box(p,vec2(1240,714),vec2(160,36),10)));
 col=mix(col,blue,text(p,vec2(1240.0-float(TEXT_GAMES.z)*.5,703),TEXT_GAMES));
 col=mix(col,vec3(.18,.36,.29),line(box(p,vec2(1530,714),vec2(130,36),10),.8));
 col=mix(col,ink,text(p,vec2(1530.0-float(TEXT_EXIT.z)*.5,703),TEXT_EXIT));
 col=mix(col,gray,text(p,vec2(110,1000),TEXT_SCOPE));
 col=mix(col,gray,text(p,vec2(110,1030),TEXT_GAME_NOTE));
 outColor=vec4(mix(paper,col,1.0-clamp(c.transition.x,0.0,1.0)),1);
}
