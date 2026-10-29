// Shared removal confirmation, using the shell font and palette.
const uint REMOVE_TEXT_0[20]=uint[20](82u,101u,109u,111u,118u,101u,32u,102u,114u,111u,109u,32u,99u,111u,110u,115u,111u,108u,101u,63u);
const uint REMOVE_TEXT_1[37]=uint[37](65u,118u,97u,105u,108u,97u,98u,108u,101u,32u,116u,111u,32u,108u,111u,97u,100u,32u,97u,103u,97u,105u,110u,32u,102u,114u,111u,109u,32u,116u,104u,105u,115u,32u,80u,67u,46u);
const uint REMOVE_TEXT_2[9]=uint[9](65u,32u,32u,82u,101u,109u,111u,118u,101u);
const uint REMOVE_TEXT_3[9]=uint[9](66u,32u,32u,67u,97u,110u,99u,101u,108u);
const uint REMOVE_TEXT_4[8]=uint[8](45u,32u,82u,101u,109u,111u,118u,101u);
float removalText(vec2 p,vec2 origin,uint which,float scale){vec2 q=(p-origin)/scale;int i=int(floor(q.x/24.0));if(q.y<0.0||q.y>=32.0||i<0)return 0.0;uint ch=32u;if(which==0u&&i<20)ch=REMOVE_TEXT_0[i];else if(which==1u&&i<37)ch=REMOVE_TEXT_1[i];else if(which==2u&&i<9)ch=REMOVE_TEXT_2[i];else if(which==3u&&i<9)ch=REMOVE_TEXT_3[i];else if(which==4u&&i<8)ch=REMOVE_TEXT_4[i];else return 0.0;return focusAscii(q,vec2(float(i)*24.0,0),ch);}
vec3 menuRemovalDraw(vec2 p,vec3 col,float footerY){
bool real=c.transition.y==0.0&&focusOrdinal(c.state.x,false)<focusCount(false)&&c.piece.x==0&&c.rows[1]==0u&&c.bagMeta.y==0u&&c.state.x<min(c.library.x,15u);if(real)col=mix(col,MUTED,removalText(p,vec2(738,footerY-9.0),4u,.6));
if(c.rows[15]==0u&&c.rows[16]==0u)return col;col*=.24;float panel=box(p,vec2(960,540),vec2(390,180),18);col=mix(col,vec3(.025,.08,.20),fill(panel));col=mix(col,MUTED,line(panel,.7)*.35);
uint selected=(c.rows[15]!=0u?c.rows[15]:c.rows[16])-1u;uint base=slotBase(min(selected,14u));col=mix(col,INK,removalText(p,vec2(660,400),0u,1));vec4 icon=focusIcon(p,vec2(688,492),base,64);col=mix(col,icon.rgb,icon.a);float width=float(c.atlas[base+25600u]);col=mix(col,INK,focusLabel(p,vec2(748,480),base,min(1.0,510.0/max(1.0,width))));col=mix(col,MUTED,removalText(p,vec2(660,550),1u,.64));
for(uint i=0u;i<2u;i++){vec2 center=vec2(i==0u?790:1130,646);float button=box(p,center,vec2(140,28),10);col=mix(col,i==0u?BLUE:vec3(.16,.23,.34),fill(button));col=mix(col,i==0u?BG:INK,removalText(p,center-vec2(75,10),i+2u,.7));}return col;}
