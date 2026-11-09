'use strict';
const {attachGame}=require('./session.cjs');
const {createGameFiles,readRomfs}=require('./mounts.cjs');
module.exports={attachGame,createGameFiles,readRomfs};
