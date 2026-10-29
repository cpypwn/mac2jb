const {spawn}=require('node:child_process');

function openPanel(url,{launch=spawn}={}){
  const match=typeof url==='string'&&/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/#([a-f0-9]{48})$/.exec(url);
  if(!match||Number(match[1])>65535)throw Error('Invalid local VacooTube panel URL');
  const child=launch('/usr/bin/open',[url],{detached:true,stdio:'ignore'});
  child.once('error',error=>console.error('Could not open VacooTube panel: '+error.message));
  child.unref();
  return true;
}

module.exports={openPanel};
