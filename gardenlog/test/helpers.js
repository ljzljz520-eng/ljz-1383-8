import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';

export async function startServer() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gardenlog-test-'));
  const { app, db } = createApp(dir);
  await new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', resolve);
    srv.unref?.();
    global.__srv = srv;
  });
  const port = global.__srv.address().port;
  const base = `http://127.0.0.1:${port}/api`;
  const TOKEN = process.env.ADMIN_TOKEN || 'devtoken';

  async function req(method, p, body, { token = TOKEN, raw = false, headers = {} } = {}) {
    const h = {};
    if (token) h['x-admin-token'] = token;
    let payload;
    if (body instanceof FormData || raw) { payload = body; }
    else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    Object.assign(h, headers);
    const res = await fetch(base + p, { method, headers: h, body: method === 'GET' || method === 'HEAD' ? undefined : payload });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.arrayBuffer();
    return { status: res.status, data, headers: res.headers };
  }
  return { dir, db, base, req };
}

// 构造一个最小合法 JPEG（SOI + APP1 EXIF(含DateTimeOriginal/GPS) + DQT + SOF0 + DHT + SOS + 扫描数据 + EOI）
export function jpegWithExif({ gps = true } = {}) {
  const crc = () => 0;
  const parts = [Buffer.from([0xff, 0xd8])];
  const tiff = buildTiff(gps);
  const exifPayload = Buffer.concat([Buffer.from('Exif\0\0'), tiff]);
  const app1 = Buffer.alloc(2 + exifPayload.length);
  app1.writeUInt16BE(exifPayload.length + 2, 0);
  exifPayload.copy(app1, 2);
  parts.push(Buffer.from([0xff, 0xe1]), app1);
  parts.push(Buffer.from([0xff, 0xe0]), segment(Buffer.from('JFIF\0' + Buffer.from([1, 1, 0, 0, 1, 0, 1]))));
  parts.push(Buffer.from([0xff, 0xdb]), segment(Buffer.alloc(67, 1)));
  parts.push(Buffer.from([0xff, 0xc0]), segment(Buffer.from([0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00])));
  parts.push(Buffer.from([0xff, 0xc4]), segment(Buffer.alloc(29, 0)));
  // SOS
  const sosHeader = segment(Buffer.from([0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]));
  parts.push(Buffer.from([0xff, 0xda]), sosHeader, Buffer.from([0x00, 0x55]), Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

function segment(payload) {
  const b = Buffer.alloc(2 + payload.length);
  b.writeUInt16BE(payload.length + 2, 0);
  payload.copy(b, 2);
  return b;
}

// 手工构造 TIFF（little-endian）：IFD0 含 ExifIFDPointer(0x8769)、GPSIFDPointer(0x8825)、DateTime(0x0132)
// ExifIFD 含 DateTimeOriginal(0x9003)；GPS IFD 含 GPSLatitude(0x0002)
function buildTiff(withGps) {
  // 先规划布局：header 8 | IFD0 | exifIFD | gpsIFD | ascii strings
  const dateStr = Buffer.from('2024:05:14 09:30:00\0', 'ascii'); // 20
  const N_IFD0 = 3, N_EXIF = 1, N_GPS = 1;
  const ifd0Size = 2 + N_IFD0 * 12 + 4;
  const exifSize = 2 + N_EXIF * 12 + 4;
  const gpsSize = 2 + N_GPS * 12 + 4;
  const ifd0Off = 8;
  const exifOff = ifd0Off + ifd0Size;
  const gpsOff = exifOff + exifSize;
  const dateOff = gpsOff + gpsSize;
  const total = dateOff + dateStr.length;
  const buf = Buffer.alloc(total);
  buf.write('II', 0, 'ascii'); buf.writeUInt16LE(0x2a, 2); buf.writeUInt32LE(ifd0Off, 4);

  function entry(off, idx, tag, type, count, valueOrOffset, inline) {
    const e = off + 2 + idx * 12;
    buf.writeUInt16LE(tag, e);
    buf.writeUInt16LE(type, e + 2);
    buf.writeUInt32LE(count, e + 4);
    if (inline) buf.write(valueOrOffset, e + 8, inline === 'ascii' ? 'ascii' : undefined);
    else buf.writeUInt32LE(valueOrOffset, e + 8);
  }
  // IFD0
  buf.writeUInt16LE(N_IFD0, ifd0Off);
  entry(ifd0Off, 0, 0x8769, 4, 1, exifOff);            // ExifIFDPointer LONG
  if (withGps) entry(ifd0Off, 1, 0x8825, 4, 1, gpsOff); // GPSIFDPointer
  const dtIdx = withGps ? 2 : 1;
  entry(ifd0Off, dtIdx, 0x0132, 2, dateStr.length, dateOff); // DateTime ASCII offset
  buf.writeUInt32LE(0, ifd0Off + 2 + N_IFD0 * 12);     // next IFD = 0

  // ExifIFD: DateTimeOriginal
  buf.writeUInt16LE(N_EXIF, exifOff);
  entry(exifOff, 0, 0x9003, 2, dateStr.length, dateOff);
  buf.writeUInt32LE(0, exifOff + 2 + N_EXIF * 12);

  // GPS IFD: tag 0x0002 GPSLatitude, type 5 RATIONAL count 1 -> 需要 8 字节值；简化为内联写 0
  if (withGps) {
    buf.writeUInt16LE(N_GPS, gpsOff);
    const e = gpsOff + 2;
    buf.writeUInt16LE(0x0002, e);
    buf.writeUInt16LE(5, e + 2); // RATIONAL
    buf.writeUInt32LE(1, e + 4);
    buf.writeUInt32LE(0, e + 8);
    buf.writeUInt32LE(0, gpsOff + 2 + N_GPS * 12);
  }
  dateStr.copy(buf, dateOff);
  return buf;
}
