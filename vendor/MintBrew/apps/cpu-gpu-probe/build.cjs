const fs=require('node:fs/promises'),path=require('node:path'),zlib=require('node:zlib');

function crc32(bytes) {
  let value=0xffffffff;
  for(const byte of bytes){
    value^=byte;
    for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);
  }
  return (value^0xffffffff)>>>0;
}

function chunk(type,data) {
  const length=Buffer.alloc(4),checksum=Buffer.alloc(4),name=Buffer.from(type);
  length.writeUInt32BE(data.length);checksum.writeUInt32BE(crc32(Buffer.concat([name,data])));
  return Buffer.concat([length,name,data,checksum]);
}

function icon() {
  const size=128,rows=Buffer.alloc(size*(1+size*4));
  const line=[[19,68],[43,68],[53,44],[64,87],[75,47],[84,68],[109,68]];
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const offset=y*(1+size*4)+1+x*4,dx=x-64,dy=y-64,radius=Math.hypot(dx,dy);
    let wave=false;
    for(let i=1;i<line.length;i++)if(x>=line[i-1][0]&&x<=line[i][0]){
      const a=line[i-1],b=line[i],height=a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0]);
      wave=Math.abs(y-height)<3;break;
    }
    const ring=radius>=47&&radius<=52,accent=ring||wave;
    rows[offset]=accent?132:12;rows[offset+1]=accent?244:43;rows[offset+2]=accent?188:38;rows[offset+3]=255;
  }
  const header=Buffer.alloc(13);
  header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);
  header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),
    chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}

async function main() {
  const root=__dirname,assets=path.join(root,'assets');
  await fs.mkdir(assets,{recursive:true});
  await Promise.all([
    fs.writeFile(path.join(assets,'state.bin'),Buffer.alloc(1024)),
    fs.writeFile(path.join(assets,'data.bin'),Buffer.alloc(4)),
    fs.writeFile(path.join(assets,'memory.bin'),Buffer.alloc(4096)),
    fs.writeFile(path.join(assets,'icon.png'),icon())
  ]);
  await require('../../sdk/build.cjs').buildApp(root);
}

main().catch(error=>{console.error(error);process.exitCode=1;});
