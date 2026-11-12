(function(g){
 "use strict";
 var C=g.PayloadCore,DEFAULT="https://raw.githubusercontent.com/cpypwn/civapp-db/main/catalog.json",OLD_DEFAULT="https://raw.githubusercontent.com/cpypwn/civapp-db-test/HEAD/catalog.json",FILE=C.root+"/catalog-repos.json";
 function sourceUrl(value){
  if(typeof value!=="string")throw Error("Enter an HTTPS catalog URL or GitHub repository.");
  value=value.trim().replace(/\/$/,"");
  var repo=/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  if(repo)value="https://raw.githubusercontent.com/"+repo[1]+"/"+repo[2]+"/HEAD/catalog.json";
  if(value==="https://raw.githubusercontent.com/cpypwn/civapp-db/HEAD/catalog.json")value=DEFAULT;
  if(!/\/catalog\.json(?:\?[^#]*)?$/.test(value))throw Error("Catalog URL must end in catalog.json.");
  return g.CivHttp.url(value).href;
 }
 function catalog(body){
  var data;try{data=JSON.parse(C.decode(body));}catch(_){throw Error("Catalog is not valid JSON.");}
  if(!data||data.format!=="civhomebrew-catalog"||data.version!==1||!Array.isArray(data.apps)||data.apps.length>64)throw Error("Unsupported app catalog format.");
  var seen=Object.create(null);
  return data.apps.map(function(a){
   if(!a||typeof a!=="object")throw Error("Invalid catalog app.");
   C.id(a.id);
   if(seen[a.id])throw Error("Catalog has a duplicate app ID.");seen[a.id]=true;
   if(typeof a.name!=="string"||!a.name.trim()||a.name.length>80||typeof a.description!=="string"||a.description.length>240||typeof a.release!=="string"||!a.release||a.release.length>32)throw Error("Invalid catalog app details.");
   if(!Number.isSafeInteger(a.bytes)||a.bytes<1||a.bytes>C.maxFrame||typeof a.sha256!=="string"||!(/^[0-9a-f]{64}$/.test(a.sha256)))throw Error("Catalog package needs an exact size and SHA-256.");
   a.package=g.CivHttp.url(a.package).href;
   if(!/\.civapp(?:\?[^#]*)?$/.test(a.package))throw Error("Catalog package URL must point to a .civapp file.");
   if(a.repository!==undefined)a.repository=g.CivHttp.url(a.repository).href;
   return {id:a.id,name:a.name,description:a.description,release:a.release,package:a.package,bytes:a.bytes,sha256:a.sha256,repository:a.repository||""};
  });
 }
 function create(o){
  var http=o.http||g.CivHttp.create(),repos=[DEFAULT],busy=false;
  function list(){return repos.slice();}
  async function load(){
   var text=await o.native.files.read(FILE,8192,true);if(text===null)return list();
   var saved;try{saved=C.open(C.decode(text));}catch(_){throw Error("Saved catalog sources are unreadable; no changes were made.");}
   if(!saved||saved.version!==1||!Array.isArray(saved.repos)||saved.repos.length>7)throw Error("Saved catalog sources are invalid.");
   var unique=Object.create(null),next=[DEFAULT];
   saved.repos.forEach(function(value){var url=sourceUrl(value);if(url===DEFAULT||url===OLD_DEFAULT)return;if(unique[url])throw Error("Saved catalog sources are invalid.");unique[url]=true;next.push(url);});
   repos=next;return list();
  }
  async function save(next){
   if(busy)throw Error("Catalog source change already in progress.");busy=true;
   try{var text=C.encode(C.seal({version:1,repos:next.slice(1)}));await o.native.io.ensureDirectory(C.root);await o.native.files.write(FILE,text);await o.native.files.commit();if(await o.native.files.read(FILE,8192,true)!==text)throw Error("Catalog sources could not be verified after saving.");repos=next;return list();}finally{busy=false;}
  }
  async function add(value){var url=sourceUrl(value);if(repos.indexOf(url)>=0)throw Error("This catalog is already added.");if(repos.length>=8)throw Error("Up to eight catalogs are supported.");return save(repos.concat(url));}
  async function remove(index){if(!Number.isInteger(index)||index<1||index>=repos.length)throw Error("The default catalog cannot be removed.");return save(repos.filter(function(_,i){return i!==index;}));}
  async function fetch(index){var url=repos[index];if(!url)throw Error("Choose a catalog source.");var result=await http.get(url,{maxBytes:65536,timeoutMs:30000,accept:"application/json"});if(result.status===404&&index===0)throw Error("The default catalog is unavailable. Try again later or add another source with Y.");if(result.status!==200)throw Error("Catalog request returned HTTP "+result.status+".");return catalog(result.body);}
  async function check(index){
   var apps=await fetch(index),entries=o.api.list(),library=o.library||g.CivAppLibrary.create(o.api),checked=[];
   for(var i=0;i<apps.length;i++){
    var app=apps[i],entry=entries.find(function(e){return e.id===app.id;}),availability;
    if(!entry)availability={kind:"new",checksum:null};
    else{
     try{
      var details=await library.describe(entry.id,entry.checksum),release=details.metadata.release;
      var comparison=g.CivVersions.compare(app.release,release);
      availability={kind:comparison===1?"update":comparison===0?"installed":comparison===-1?"newer-installed":"unverified",release:release,checksum:entry.checksum};
     }catch(e){availability={kind:"unverified",checksum:entry.checksum,reason:e.message};}
    }
    checked.push(Object.assign({},app,{availability:availability}));
   }
   return checked;
  }
  function unchanged(app){
   if(!app.availability)return;
   var entry=o.api.list().find(function(e){return e.id===app.id;});
   if((entry?entry.checksum:null)!==app.availability.checksum)throw Error("Installed app changed; refresh the catalog before installing.");
  }
  async function install(app,progress){
   unchanged(app);
   var result=await http.get(app.package,{maxBytes:app.bytes,timeoutMs:120000,progress:progress});
   if(result.status!==200)throw Error("Package request returned HTTP "+result.status+".");
   if(result.body.length!==app.bytes)throw Error("Package size differs from the catalog.");
   if(await g.CivSha256.hash(result.body)!==app.sha256)throw Error("Package SHA-256 differs from the catalog.");
   var p=C.package(JSON.parse(C.decode(result.body)));
   if(p.id!==app.id||p.metadata.release!==app.release)throw Error("Package identity differs from the catalog.");
   unchanged(app);
   return o.api.submit(p.id+".civapp",C.encode(JSON.stringify(p)));
  }
  return {defaultUrl:DEFAULT,list:list,load:load,add:add,remove:remove,fetch:fetch,check:check,install:install,close:http.close};
 }
 g.CivCatalog={create:create,sourceUrl:sourceUrl,parse:catalog};
})(typeof window!=="undefined"?window:globalThis);
