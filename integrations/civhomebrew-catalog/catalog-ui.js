(function(g){
 "use strict";
 function create(o){
  var closed=false,visible=false,working=false,repo=0,selected=0,apps=[],error="",epoch=0;
  function node(tag,parent,style,text){return o.layout.node(tag,parent,style,text);}
  var root=node("div",o.stage,{position:"absolute",left:"0",right:"0",top:"0",bottom:"0",display:"none",backgroundColor:"rgba(0,0,0,0.94)",zIndex:"5",color:"#f4f7f6"});root.id="catalog-overlay";
  var title=node("div",root,{position:"absolute",left:"72px",top:"38px",fontSize:"31px"},"Browse apps");
  var source=node("div",root,{position:"absolute",left:"72px",right:"72px",top:"102px",fontSize:"21px",color:"#00efcf",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"});
  var hint=node("div",root,{position:"absolute",left:"72px",right:"72px",top:"140px",fontSize:"19px",color:"#a9bcb8"},"Left/Right: source  ·  Y: add source  ·  X: remove source");
  var list=node("div",root,{position:"absolute",left:"72px",width:"510px",top:"190px",bottom:"100px",overflowY:"auto"});
  var detail=node("div",root,{position:"absolute",left:"620px",right:"72px",top:"190px",bottom:"100px",padding:"20px",boxSizing:"border-box",backgroundColor:"#122822",border:"1px solid #315a4d",borderRadius:"9px",fontSize:"21px",lineHeight:"30px",whiteSpace:"pre-wrap",overflowY:"auto"});
  var foot=node("div",root,{position:"absolute",left:"72px",right:"72px",bottom:"30px",fontSize:"20px",color:"#b8ceca"});
  var keyboard=g.CivKeyboard.create({root:root,layout:o.layout,native:o.native,focus:o.focus,suppress:o.suppress,error:function(s){error=s;draw();}});
  function label(url){return url.replace(/^https:\/\//,"").replace(/\/catalog\.json(?:\?.*)?$/,"");}
  function draw(){
   if(closed||!visible)return;
   source.textContent="Source "+(repo+1)+" / "+o.catalog.list().length+"  ·  "+label(o.catalog.list()[repo]);
   while(list.firstChild)list.removeChild(list.firstChild);
   if(!apps.length)node("div",list,{padding:"18px",color:"#a9bcb8",fontSize:"21px",lineHeight:"29px"},working?"Loading apps…":error||"No apps are published here yet");
   apps.forEach(function(app,index){var row=node("div",list,{padding:"16px 19px",marginBottom:"7px",borderRadius:"7px",border:"2px solid "+(index===selected?"#00efcf":"#264239"),backgroundColor:index===selected?"#18392f":"#10251f",fontSize:"23px",display:"flex",alignItems:"center",gap:"12px"});node("span",row,{minWidth:"0",flex:"1",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"},app.name);if(app.availability&&app.availability.kind==="update")node("span",row,{flexShrink:"0",fontSize:"17px",color:"#00efcf"},"Update");row.addEventListener("click",function(){selected=index;draw();});});
   var app=apps[selected];
   var available=app&&app.availability,kind=available&&available.kind;
   var status=kind==="update"?"Update available · installed "+available.release+" → "+app.release:kind==="installed"?"Installed · current release":kind==="newer-installed"?"Installed release "+available.release+" is newer":kind==="unverified"?"Installed release could not be compared":kind==="new"?"Not installed":"";
   detail.textContent=app?app.name+"  "+app.release+(status?"\n\n"+status:"")+"\n\n"+app.description+(app.repository?"\n\nSource: "+app.repository:""):"Add another public HTTPS catalog with Y.";
   var command=kind==="update"?"update":kind==="installed"||kind==="unverified"?"reinstall":kind==="newer-installed"?"install older release":"install";
   foot.textContent=working?"Please wait…":error&&apps.length?error:app?"A: "+command+"  ·  B: close  ·  Y: add source  ·  X: remove source":"B: close  ·  Y: add source  ·  X: remove source";
   if(app&&list.children[selected]){var row=list.children[selected];if(row.offsetTop<list.scrollTop)list.scrollTop=row.offsetTop;else if(row.offsetTop+row.offsetHeight>list.scrollTop+list.clientHeight)list.scrollTop=row.offsetTop+row.offsetHeight-list.clientHeight;}
  }
  async function fetch(){var ticket=++epoch;apps=[];selected=0;error="";working=true;draw();try{var rows=await o.catalog.check(repo);if(ticket===epoch&&!closed){apps=rows;error="";}}catch(e){if(ticket===epoch&&!closed)error=e.message;}finally{if(ticket===epoch&&!closed){working=false;draw();}}}
  async function add(){if(working||keyboard.active())return;var value=await keyboard.edit("",400,false,"catalog URL or GitHub repository");if(value===null||closed||!visible)return;working=true;error="";draw();try{await o.catalog.add(value);repo=o.catalog.list().length-1;await fetch();}catch(e){error=e.message;working=false;draw();}}
  async function remove(){if(working||repo===0)return;working=true;draw();try{await o.catalog.remove(repo);repo=Math.max(0,repo-1);await fetch();}catch(e){error=e.message;working=false;draw();}}
  async function install(){if(working||!apps[selected])return;working=true;error="";draw();try{await o.catalog.install(apps[selected]);if(!closed){hide();o.focus();o.suppress();}}catch(e){error=e.message;working=false;draw();}}
  function hide(){visible=false;epoch++;root.style.display="none";}
  async function open(){if(closed)return;visible=true;root.style.display="block";repo=0;error="";apps=[];working=true;draw();try{await o.catalog.load();if(!closed&&visible)await fetch();}catch(e){error=e.message;working=false;draw();}o.focus();o.suppress();}
  function action(name,phase){if(!visible)return false;if(keyboard.active())return true;if(phase!==0&&phase!==3)return true;if(working)return true;
   if(name==="cancel"){hide();o.focus();o.suppress();return true;}
   if(name==="options"){if(phase===0)add();return true;}if(name==="menu"){if(phase===0)remove();return true;}
   if(name==="nav-left"||name==="nav-right"){var next=repo+(name==="nav-right"?1:-1);if(next>=0&&next<o.catalog.list().length){repo=next;fetch();}return true;}
   if(name==="nav-up"||name==="nav-down"){selected=Math.max(0,Math.min(apps.length-1,selected+(name==="nav-down"?1:-1)));draw();return true;}
   if(name==="accept"&&phase===0){install();return true;}return true;
  }
  return {open:open,active:function(){return visible;},editing:keyboard.active,action:action,close:async function(){if(closed)return;closed=true;hide();keyboard.cancel();await o.catalog.close();if(root.parentNode)root.parentNode.removeChild(root);}};
 }
 g.CivCatalogUI={create:create};
})(typeof window!=="undefined"?window:globalThis);
