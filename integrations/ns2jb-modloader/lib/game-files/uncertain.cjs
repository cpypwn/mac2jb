'use strict';
// A timed-out SDK call can still own its IPC buffers. Never close handles,
// restore scratch or free the allocation while that call may be in flight.
function isUncertain(error){
 return !!error?.nativeRequestUncertain||/pending|timed out|timeout|disconnected|ECONNRESET|EPIPE|socket (?:closed|ended)/i.test(String(error?.message||error));
}
function guardSession(session){
 for(const name of ['initialize','call','read','readOwned','write','ready']){
  if(typeof session[name]!=='function')continue;
  const operation=session[name].bind(session);
  session[name]=async(...args)=>{
   if(session.uncertainError)throw session.uncertainError;
   try{return await operation(...args);}catch(error){
    if(isUncertain(error)){error.nativeRequestUncertain=true;session.uncertainError=error;}
    throw error;
   }
  };
 }
 const cleanup=session.cleanup.bind(session);
 session.cleanup=async()=>{if(!session.uncertainError)return cleanup();};
 return session;
}
module.exports={isUncertain,guardSession};
