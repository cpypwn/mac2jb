const checks=require('./sdk-checks.json');
function bytes(offset,size){const hex=checks[offset+':'+size];if(!hex)throw Error('Missing SDK verification range: '+offset+':'+size);return Buffer.from(hex,'hex');}
module.exports={bytes};
