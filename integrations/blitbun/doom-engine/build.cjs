const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');

const root=__dirname,source=path.join(root,'source'),output=path.join(root,'doom-headless');
const names='dummy am_map doomdef doomstat dstrings d_event d_items d_iwad d_loop d_main d_mode d_net f_finale f_wipe g_game hu_lib hu_stuff info i_cdmus i_endoom i_joystick i_scale i_sound i_system i_timer memio m_argv m_bbox m_cheat m_config m_controls m_fixed m_menu m_misc m_random p_ceilng p_doors p_enemy p_floor p_inter p_lights p_map p_maputl p_mobj p_plats p_pspr p_saveg p_setup p_sight p_spec p_switch p_telept p_tick p_user r_bsp r_data r_draw r_main r_plane r_segs r_sky r_things sha1 sounds statdump st_lib st_stuff s_sound tables v_video wi_stuff w_checksum w_file w_main w_wad z_zone w_file_stdc i_input i_video doomgeneric'.split(' ');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

function checkSource(){
  const manifest=fs.readFileSync(path.join(root,'source-SHA256SUMS'),'utf8').trim().split('\n');
  const entries=new Map(manifest.map(line=>{const match=/^([0-9a-f]{64})  ([A-Za-z0-9_.-]+)$/.exec(line);if(!match)throw Error('Invalid DoomGeneric source inventory');return [match[2],match[1]];}));
  if(entries.size!==manifest.length)throw Error('Duplicate DoomGeneric source inventory entry');
  const files=fs.readdirSync(source).sort();
  if(JSON.stringify(files)!==JSON.stringify([...entries.keys()].sort()))throw Error('Changed DoomGeneric source inventory');
  for(const [name,digest] of entries)if(sha(fs.readFileSync(path.join(source,name)))!==digest)throw Error('Changed DoomGeneric source: '+name);
  for(const name of names)if(!entries.has(name+'.c'))throw Error('Missing DoomGeneric compile source: '+name);
}

function checkBinary(){
  const bytes=fs.readFileSync(output);
  if(bytes.readUInt32LE(0)!==0xfeedfacf||bytes.readUInt32LE(4)!==0x0100000c)throw Error('Doom engine is not arm64 Mach-O');
  return sha(bytes);
}

function main(args=process.argv.slice(2)){
  if(args.length>1||args.length===1&&!['--build','--check'].includes(args[0]))throw Error('Usage: node build.cjs [--build|--check]');
  checkSource();
  if(args[0]!=='--check'){
    const files=names.map(name=>path.join(source,name+'.c')).concat(path.join(root,'doom-mac.c'));
    const clang=spawnSync('/usr/bin/clang',['-O2','-DNORMALUNIX','-D_DEFAULT_SOURCE','-DDOOMGENERIC_RESX=320','-DDOOMGENERIC_RESY=200','-mmacosx-version-min=13.0','-I',source,...files,'-lm','-o',output],{encoding:'utf8',maxBuffer:4*1024*1024});
    if(clang.status!==0)throw Error('DoomGeneric build failed: '+(clang.stderr||clang.stdout||clang.error));
    fs.chmodSync(output,0o755);
  }
  const digest=checkBinary();
  process.stdout.write(`doom-headless sha256 ${digest}\n`);
  return digest;
}

if(require.main===module)try{main();}catch(error){console.error(error.message);process.exitCode=1;}
module.exports={main,checkSource,checkBinary,names};
