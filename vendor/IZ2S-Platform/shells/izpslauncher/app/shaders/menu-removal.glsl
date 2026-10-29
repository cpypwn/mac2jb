const float REMOVAL_FOOTER_Y=1056.0;
// Menu-owned ABI-1 scratch: dialog=940, request=944, sequence=948.
// The host queues the same operation used by the PC panel, at a menu boundary.
bool menuRemovalInput(uint pressed){
 if(c.rows[16]!=0u){hbEndFrame();return true;}
 bool touching=hbTouchCount()>0u&&(c.touch[6]&2u)==0u;
 vec2 point=touching?hbTouch(0u)*1.5:vec2(0);
 bool tap=touching&&c.library.w==0u;
 if(c.rows[15]!=0u){
  bool cancel=(pressed&(HB_B|HB_MINUS))!=0u||(tap&&all(lessThanEqual(abs(point-vec2(1130,646)),vec2(140,28))));
  bool confirm=(pressed&HB_A)!=0u||(tap&&all(lessThanEqual(abs(point-vec2(790,646)),vec2(140,28))));
  if(cancel)c.rows[15]=0u;
  else if(confirm){c.rows[16]=c.rows[15];c.rows[17]=c.rows[17]>=0xfffffffeu?1u:c.rows[17]+1u;c.rows[15]=0u;}
  c.library.w=touching?1u:0u;hbEndFrame();return true;
 }
 bool real=c.transition.y==0.0&&focusOrdinal(c.state.x,false)<focusCount(false)&&c.piece.x==0&&c.rows[1]==0u&&c.bagMeta.y==0u&&c.state.x<min(c.library.x,15u);
 if(real&&((pressed&HB_MINUS)!=0u||(tap&&all(lessThanEqual(abs(point-vec2(810,REMOVAL_FOOTER_Y)),vec2(90,22)))))){
  c.rows[15]=c.state.x+1u;c.library.w=touching?1u:0u;hbEndFrame();return true;
 }
 return false;
}
