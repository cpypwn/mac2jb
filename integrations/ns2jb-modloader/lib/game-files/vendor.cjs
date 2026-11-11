'use strict';
const fs=require('node:fs');
const path=require('node:path');
const local=path.resolve(__dirname,'../../vendor/OunceCake/engine');
const checkout=path.resolve(__dirname,'../../../../vendor/OunceCake/engine');
module.exports=name=>require(path.join(fs.existsSync(local)?local:checkout,name));
