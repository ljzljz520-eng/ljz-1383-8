// EXIF 处理：上传照片一律剥离 EXIF（GPS、相机、软件等隐私段），
// 剥离前提取拍摄时间(DateTimeOriginal)与"是否含 GPS"供站内记录。
// 只解析最小必需的 TIFF/IFD 结构，不重编码像素。

const SEG_KEEP = new Set([0xd8, 0xd9, 0xda]); // SOI/EOI/SOS（结构标记）
// 保留 APP0(JFIF)；删除 APP1(EXIF/XMP)、APP2..APP15、COM 等可能含隐私的段

export function stripJpegExif(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return { out: buf, stripped: false };
  }
  let takenAt = null, gpsPresent = false, exifFound = false;
  // 第一遍：定位 APP1/EXIF，只提取最小信息
  let i = 2;
  while (i + 4 < buf.length) {
    if (buf[i] !== 0xff) break;
    let marker = buf[i + 1];
    while (marker === 0xff && i + 1 < buf.length) { i++; marker = buf[i + 1]; }
    i += 2;
    if (SEG_KEEP.has(marker)) break;
    const segLen = buf.readUInt16BE(i);
    if (segLen < 2 || i + segLen > buf.length) break;
    const payload = buf.subarray(i + 2, i + segLen);
    if (marker === 0xe1 && payload.subarray(0, 4).toString('ascii') === 'Exif') {
      exifFound = true;
      try {
        const info = parseExifTiff(payload.subarray(6));
        takenAt = info.dateTimeOriginal || info.dateTime;
        gpsPresent = info.gpsPresent;
      } catch { /* 解析失败不影响剥离 */ }
    }
    i += segLen;
  }
  // 第二遍：仅保留 APP0 与图像必需段
  return { out: rebuildJpeg(buf), takenAt, gpsPresent, stripped: exifFound };
}

// 严格策略：输出 = SOI + 仅 APP0(JFIF) + 图像必需段；删除 APP1..APP15 与 COM
function rebuildJpeg(buf) {
  const parts = [Buffer.from([0xff, 0xd8])];
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    if (marker === 0xda) { parts.push(buf.subarray(i)); break; } // SOS + 扫描数据 + EOI 原样
    if (marker === 0xd9) break;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    if (marker === 0x00) { i += 2; continue; }
    const segLen = buf.readUInt16BE(i + 2);
    if (segLen < 2) break;
    const segEnd = i + 2 + segLen;
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const isCom = marker === 0xfe;
    if ((!isApp && !isCom) || marker === 0xe0) {
      parts.push(buf.subarray(i, segEnd)); // 完整段：FF xx LL LL payload
    }
    i = segEnd;
  }
  return Buffer.concat(parts);
}

// ---- 最小 EXIF/TIFF 解析 ----
function parseExifTiff(tiff) {
  const little = tiff[0] === 0x49; // II little endian
  const rd16 = (o) => little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o);
  const rd32 = (o) => little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o);
  const ifd0 = rd32(4);
  const result = { dateTimeOriginal: null, dateTime: null, gpsPresent: false };

  const walk = (offset) => {
    const n = rd16(offset);
    let exifPtr = 0, gpsPtr = 0;
    const entries = [];
    for (let k = 0; k < n; k++) {
      const e = offset + 2 + k * 12;
      entries.push({ tag: rd16(e), type: rd16(e + 2), count: rd32(e + 4), valueOff: e + 8 });
    }
    for (const en of entries) {
      if (en.tag === 0x8769) exifPtr = rd32(en.valueOff);      // ExifIFDPointer
      if (en.tag === 0x8825) gpsPtr = rd32(en.valueOff);      // GPSInfoIFDPointer
      if (en.tag === 0x0132) result.dateTime = readAscii(tiff, en, little); // DateTime
    }
    if (exifPtr) {
      const nn = rd16(exifPtr);
      for (let k = 0; k < nn; k++) {
        const e = exifPtr + 2 + k * 12;
        if (rd16(e) === 0x9003) result.dateTimeOriginal = readAscii(tiff, { type: rd16(e + 2), count: rd32(e + 4), valueOff: e + 8 }, little);
      }
    }
    if (gpsPtr) {
      // 有 GPS IFD 且含至少一个坐标类标签即视为带定位
      const nn = rd16(gpsPtr);
      for (let k = 0; k < nn; k++) {
        const e = gpsPtr + 2 + k * 12;
        const tag = rd16(e);
        if ([0x0001, 0x0002, 0x0003, 0x0004].includes(tag)) { result.gpsPresent = true; break; }
      }
    }
  };
  if (ifd0 < tiff.length) walk(ifd0);
  return result;
}

function readAscii(buf, en, little) {
  // type 2 = ASCII；<=4 字节内联，否则偏移
  if (en.type !== 2) return null;
  if (en.count <= 4) {
    return buf.subarray(en.valueOff, en.valueOff + en.count - 1).toString('ascii');
  }
  const off = little ? buf.readUInt32LE(en.valueOff) : buf.readUInt32BE(en.valueOff);
  return buf.subarray(off, off + en.count - 1).toString('ascii');
}

// PNG：删除 eXIf、tEXt、zTXt、iTXt 等文本块（像素在 IDAT，重拼块即可）
export function stripPngPrivate(buf) {
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return { out: buf, stripped: false };
  const parts = [buf.subarray(0, 8)];
  let i = 8, stripped = false;
  const DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt']);
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('ascii');
    const chunk = buf.subarray(i, i + 12 + len);
    if (DROP.has(type)) { stripped = true; }
    else parts.push(chunk);
    i += 12 + len;
    if (type === 'IEND') break;
  }
  return { out: Buffer.concat(parts), stripped };
}

export function sanitizeImage(buf, contentType) {
  if (contentType === 'image/png' || buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    const r = stripPngPrivate(buf);
    return { ...r, takenAt: null, gpsPresent: false };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) return stripJpegExif(buf);
  return { out: buf, stripped: false, takenAt: null, gpsPresent: false };
}
