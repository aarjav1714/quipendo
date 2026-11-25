import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  data: Uint8Array;
  method: number;
  crc: number;
  mode: number;
}

/** A small independent reader: finds the central directory from the end, then reads each entry through its local header. */
export function readZip(buf: Uint8Array): Record<string, ZipEntry> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let end = buf.length - 22;
  while (end >= 0 && dv.getUint32(end, true) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('no end-of-central-directory record');
  const count = dv.getUint16(end + 10, true);
  let p = dv.getUint32(end + 16, true);
  const out: Record<string, ZipEntry> = {};
  for (let i = 0; i < count; i += 1) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLength = dv.getUint16(p + 28, true);
    const extraLength = dv.getUint16(p + 30, true);
    const commentLength = dv.getUint16(p + 32, true);
    const mode = dv.getUint32(p + 38, true) >>> 16;
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLength));
    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error('bad local header');
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = buf.subarray(start, start + csize);
    out[name] = { data: method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw, method, crc, mode };
    p += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}
