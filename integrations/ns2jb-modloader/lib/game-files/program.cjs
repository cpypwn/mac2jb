'use strict';
const program=require('./vendor.cjs')('program.cjs');

async function prepareInstalledLicense(options){
 if(options.source.storage===2)return false;
 return program.prepareInstalledLicense(options);
}

module.exports={...program,prepareInstalledLicense};
