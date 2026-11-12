'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CATALOG = path.join(ROOT, 'integrations/civhomebrew-catalog');
const PRIOR_CATALOG_LAUNCHER_CHECKSUM = '60d573be';

function replaceOnce(source, before, after, name) {
  const index = source.indexOf(before);
  if (index < 0 || source.indexOf(before, index + before.length) >= 0) {
    throw Error('Pinned CivHomebrew source changed at ' + name);
  }
  return source.slice(0, index) + after + source.slice(index + before.length);
}

function replaceCount(source, before, after, count, name) {
  const matches = source.split(before);
  if (matches.length !== count + 1) throw Error('Pinned CivHomebrew source changed at ' + name);
  return matches.join(after);
}

function fnvHash(source) {
  let value = 2166136261;
  for (let index = 0; index < source.length; index++) {
    value = Math.imul(value ^ source.charCodeAt(index), 16777619);
  }
  return (value >>> 0).toString(16).padStart(8, '0');
}

async function launcherBundle(source, menu) {
  const scripts = menu.match(/^LAUNCHER_SCRIPTS = \[([^\n]+)\]$/m);
  if (!scripts) throw Error('Pinned CivHomebrew launcher script list changed');
  const files = [...scripts[1].matchAll(/ROOT\/'([^']+)'/g)].map(match => match[1]);
  if (!files.length || files.length !== (scripts[1].match(/ROOT\//g) || []).length) {
    throw Error('Pinned CivHomebrew launcher script list changed');
  }
  const parts = await Promise.all(files.map(file => fs.readFile(path.join(source, file))));
  return Buffer.concat(parts.flatMap((part, index) =>
    index ? [Buffer.from('\n;\n'), part] : [part])).toString('utf8');
}

async function upstreamLauncherChecksum(source, menu) {
  return fnvHash(await launcherBundle(source, menu));
}

async function launcherPackage(source, menu) {
  const launcher = await launcherBundle(source, menu);
  if (!launcher.trim() || Buffer.byteLength(launcher) > 8 * 1024 * 1024) {
    throw Error('Invalid CivHomebrew launcher source');
  }
  return {format: 'civswitch-system', version: 1, api: 1,
    component: 'launcher', release: '0.4.3', source: launcher, checksum: fnvHash(launcher)};
}

function patchLauncher(source, checksum) {
  source = replaceOnce(source, "ROOT/'app/src/ftp.js', ROOT/'app/app.js'",
    "ROOT/'app/src/ftp.js', ROOT/'app/src/catalog.js', ROOT/'app/src/catalog-ui.js', ROOT/'app/app.js'", 'launcher bundle');
  source = replaceOnce(source, "'seeds':{name:system_package(name,component_bundle(name)",
    "'upstreamLauncherChecksum':'" + checksum + "','seeds':{name:system_package(name,component_bundle(name)", 'launcher upgrade identity');
  return source;
}

function patchBoot(source) {
  return replaceOnce(source,
    'var context={native:native,system:system,config:config,recovery:recovery,warnings:warnings,evaluate:',
    'try{\n' +
    '  if(config.upstreamLauncherChecksum&&seeds.launcher.checksum!==config.upstreamLauncherChecksum){\n' +
    '   var launcherState=await system.status("launcher");\n' +
    '   if(launcherState.pending===null&&launcherState.active!==null&&' +
    '(launcherState.hashes[launcherState.active]===config.upstreamLauncherChecksum||launcherState.hashes[launcherState.active]==="' + PRIOR_CATALOG_LAUNCHER_CHECKSUM + '")){\n' +
    '    await system.stage(seeds.launcher);\n' +
    '   }\n' +
    '  }\n' +
    ' }catch(e){warnings.push("Catalog launcher upgrade: "+e.message);recovery=true;}\n' +
    ' var context={native:native,system:system,config:config,recovery:recovery,warnings:warnings,evaluate:',
    'guarded catalog launcher upgrade');
}

function patchApp(source) {
  source = replaceOnce(source, 'options=null,appMenu=null,updater=null',
    'options=null,appMenu=null,catalogUI=null,updater=null', 'catalog state');
  source = replaceCount(source, 'if(options&&options.editing())return;',
    'if((options&&options.editing())||(catalogUI&&catalogUI.editing()))return;', 4, 'catalog keyboard');
  source = replaceOnce(source,
    'if(systemUI&&systemUI.active()){systemUI.action(name,phase);last={name:name,time:now};return;}',
    'if(catalogUI&&catalogUI.active()){catalogUI.action(name,phase);last={name:name,time:now};return;}\n        if(systemUI&&systemUI.active()){systemUI.action(name,phase);last={name:name,time:now};return;}', 'catalog actions');
  source = replaceOnce(source, 'if(systemUI)systemUI.close();if(options)options.close();if(appMenu)appMenu.close();',
    'if(systemUI)systemUI.close();if(options)options.close();if(appMenu)appMenu.close();if(catalogUI)await catalogUI.close();', 'catalog close');
  source = replaceOnce(source,
    'options=g.CivOptions.create({stage:stage,layout:layout,settings:',
    'catalogUI=g.CivCatalogUI.create({stage:stage,layout:layout,api:api,catalog:g.CivCatalog.create({api:api,native:boot.native}),native:function(){return !!(g.PayloadNative&&g.PayloadNative.available);},focus:function(){if(!closed)root.focus();},suppress:function(){ignoreUntil=Date.now()+250;held="";last={name:"",time:0};}});\n        options=g.CivOptions.create({stage:stage,layout:layout,browse:function(){catalogUI.open();},settings:', 'catalog startup');
  return source;
}

function patchOptions(source) {
  source = replaceOnce(source,
    'function mainItems(){return [["ftp","FTP",',
    'function mainItems(){return [["catalog","Browse apps","Find and install apps from HTTPS catalogs."],["ftp","FTP",', 'catalog option');
  source = replaceOnce(source,
    'if(closed||saving||keyboard.active())return;if(page!=="ftp"){if(selected===1){o.checkUpdates();return;}page="ftp";selected=0;draft=Object.assign({},o.settings());draw();return;}',
    'if(closed||saving||keyboard.active())return;if(page!=="ftp"){if(selected===0){page="";overlay.style.display="none";o.browse();return;}if(selected===2){o.checkUpdates();return;}page="ftp";selected=0;draft=Object.assign({},o.settings());draw();return;}', 'catalog option action');
  return source;
}

async function createOverlay(source) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-civ-catalog-'));
  const target = path.join(temporary, 'source');
  try {
    await fs.cp(source, target, {recursive: true, errorOnExist: true, force: false});
    const menu = path.join(target, 'tools/payload_menu.py');
    const boot = path.join(target, 'app/boot.js');
    const app = path.join(target, 'app/app.js');
    const options = path.join(target, 'app/src/options.js');
    const menuSource = await fs.readFile(menu, 'utf8');
    const checksum = await upstreamLauncherChecksum(target, menuSource);
    await fs.writeFile(menu, patchLauncher(menuSource, checksum));
    await fs.writeFile(boot, patchBoot(await fs.readFile(boot, 'utf8')));
    await fs.writeFile(app, patchApp(await fs.readFile(app, 'utf8')));
    await fs.writeFile(options, patchOptions(await fs.readFile(options, 'utf8')));
    await fs.copyFile(path.join(CATALOG, 'catalog.js'), path.join(target, 'app/src/catalog.js'));
    await fs.copyFile(path.join(CATALOG, 'catalog-ui.js'), path.join(target, 'app/src/catalog-ui.js'));
    return {path: target, cleanup: () => fs.rm(temporary, {recursive: true, force: true})};
  } catch (error) {
    await fs.rm(temporary, {recursive: true, force: true});
    throw error;
  }
}

async function buildLauncherPackage(source) {
  const overlay = await createOverlay(source);
  try {
    const menu = await fs.readFile(path.join(overlay.path, 'tools/payload_menu.py'), 'utf8');
    return {package: await launcherPackage(overlay.path, menu), cleanup: overlay.cleanup};
  } catch (error) {
    await overlay.cleanup();
    throw error;
  }
}

module.exports = {createOverlay, buildLauncherPackage, patchLauncher, patchBoot, patchApp,
  patchOptions, fnvHash, launcherBundle, launcherPackage, upstreamLauncherChecksum};
