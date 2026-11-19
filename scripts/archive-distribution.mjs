import {readFileSync,writeFileSync,readdirSync,statSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
if(process.argv.length!==3)throw Error('Usage: archive-distribution.mjs DIRECTORY');
const output=resolve(process.argv[2]),zipPath=output+'.zip',files=[];
function walk(directory){for(const item of readdirSync(directory,{withFileTypes:true})){const full=join(directory,item.name);if(item.isSymbolicLink())throw Error('Symlinks are not allowed');if(item.isDirectory())walk(full);else files.push(relative(output,full).replaceAll('\\','/'));}}walk(output);
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = data => { let crc = 0xffffffff; for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; };
  let offset = 0; const chunks = [], directory = [];
  for (const path of files.sort()) {
    const data = readFileSync(join(output, path)), name = Buffer.from(path), crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    chunks.push(header, name, data);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(((statSync(join(output,path)).mode & 0xffff) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42); directory.push(central, name); offset += header.length + name.length + data.length;
  }
  const center = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(center.length, 12); end.writeUInt32LE(offset, 16);
  writeFileSync(zipPath, Buffer.concat([...chunks, center, end]), { flag: 'wx' });
