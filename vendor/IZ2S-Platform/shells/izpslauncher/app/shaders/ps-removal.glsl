// Removal uses the same typography and catalog-title atlas as the blue menu.
vec3 psRemovalDraw(vec2 p,vec3 col){
 bool real=c.transition.y==0.0&&focusOrdinal(c.state.x,false)<focusCount(false)&&c.piece.x==0&&c.rows[1]==0u&&c.bagMeta.y==0u&&c.state.x<min(c.library.x,15u);
 if(real)psLabel(p,col,vec2(738,1049),PS_REMOVE_HINT,PS_MUTED);
 if(c.rows[15]==0u&&c.rows[16]==0u)return col;
 col*=.24;float panel=box(p,vec2(960,540),vec2(390,180),18);col=mix(col,vec3(.025,.08,.20),fill(panel));col=mix(col,PS_MUTED,line(panel,.7)*.35);
 psLabel(p,col,vec2(650,400),PS_REMOVE_TITLE,PS_WHITE);
 uint selected=(c.rows[15]!=0u?c.rows[15]:c.rows[16])-1u,base=slotBase(min(selected,14u));
 vec4 icon=focusIcon(p,vec2(688,492),base,64);col=mix(col,icon.rgb,icon.a);
 float width=float(c.atlas[base+25625u]);col=mix(col,PS_WHITE,psAppTitle(p,vec2(748,480),base,min(1.0,510.0/max(1.0,width))));
 psLabel(p,col,vec2(650,550),PS_REMOVE_BODY,PS_MUTED);
 if(c.rows[16]!=0u){psLabel(p,col,vec2(650,635),PS_REMOVING,PS_CYAN);return col;}
 for(uint i=0u;i<2u;i++){
  vec2 center=vec2(i==0u?790:1130,646);float button=box(p,center,vec2(140,28),10);
  col=mix(col,i==0u?PS_WHITE:vec3(.16,.23,.34),fill(button));
  ivec4 label=i==0u?PS_REMOVE_CONFIRM:PS_REMOVE_CANCEL;
  psLabel(p,col,center-vec2(label.zw)*.5,label,i==0u?vec3(.04,.20,.51):PS_WHITE);
 }
 return col;
}
