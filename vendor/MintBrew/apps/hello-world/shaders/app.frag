#version 450
#extension GL_GOOGLE_include_directive : require
layout(location=0) out vec4 outColor;
#define STATE_ACCESS readonly
#include "abi.glsl"
#include "text.glsl"
#include "draw.glsl"
void main(){
 vec2 p=gl_FragCoord.xy;
 vec3 color=mix(vec3(.035,.10,.19),vec3(.04,.22,.32),p.y/1080.0);
 float panel=fill(box(p,vec2(960,540),vec2(650,260),32));
 color=mix(color,vec3(.07,.16,.25),panel);
 color=mix(color,vec3(.25,.85,.90),text(p,vec2(960-TEXT_HELLO.z/2,440),TEXT_HELLO));
 color=mix(color,vec3(.84,.91,.96),text(p,vec2(960-TEXT_MESSAGE.z/2,560),TEXT_MESSAGE));
 color=mix(color,vec3(.60,.72,.80),text(p,vec2(960-TEXT_RETURN.z/2,660),TEXT_RETURN));
 outColor=vec4(color*(1.0-c.transition.x),1);
}
