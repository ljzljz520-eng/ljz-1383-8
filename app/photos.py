"""Photo storage with privacy-first EXIF handling (stdlib only).

- JPEG: APP1 (Exif/XMP), APP13 (Photoshop/IPTC) and COM segments are dropped
  from the published file. A minimal parser reads DateTimeOriginal and GPS
  presence *before* stripping, for server-side records only.
- PNG: tEXt/zTXt/iTXt/eXIf chunks are dropped.
The stripped bytes are what is served to the public.
"""
import io
import struct


class ExifSummary:
    def __init__(self):
        self.taken_at = None
        self.has_gps = False
        self.tag_count = 0


# ----------------------------- minimal TIFF/EXIF reader ---------------------

def _parse_tiff(data, summary):
    if len(data) < 8:
        return
    bo_mark = data[:2]
    if bo_mark == b"II":
        endian = "<"
    elif bo_mark == b"MM":
        endian = ">"
    else:
        return
    if struct.unpack(endian + "H", data[2:4])[0] != 42:
        return
    ifd0_off = struct.unpack(endian + "I", data[4:8])[0]

    def read_ifd(off):
        entries = {}
        if off == 0 or off + 2 > len(data):
            return entries
        n = struct.unpack(endian + "H", data[off:off + 2])[0]
        base = off + 2
        for i in range(n):
            e = base + i * 12
            if e + 12 > len(data):
                break
            tag, typ, cnt = struct.unpack(endian + "HHI", data[e:e + 8])
            entries[tag] = (typ, cnt, data[e + 8:e + 12])
            summary.tag_count += 1
        return entries

    def ascii_value(entry):
        typ, cnt, vf = entry
        if typ != 2:
            return None
        if cnt <= 4:
            raw = vf[:cnt]
        else:
            off = struct.unpack(endian + "I", vf)[0]
            raw = data[off:off + cnt]
        return raw.rstrip(b"\x00").decode("ascii", "replace")

    ifd0 = read_ifd(ifd0_off)
    if 0x8769 in ifd0:
        typ, cnt, vf = ifd0[0x8769]
        exif_ifd = read_ifd(struct.unpack(endian + "I", vf)[0])
        if 0x9003 in exif_ifd:
            summary.taken_at = ascii_value(exif_ifd[0x9003])
        elif 0x0132 in exif_ifd:
            summary.taken_at = ascii_value(exif_ifd[0x0132])
    if summary.taken_at is None and 0x0132 in ifd0:
        summary.taken_at = ascii_value(ifd0[0x0132])
    if 0x8825 in ifd0:
        typ, cnt, vf = ifd0[0x8825]
        gps_ifd = read_ifd(struct.unpack(endian + "I", vf)[0])
        if any(t in gps_ifd for t in (0x0001, 0x0002, 0x0003, 0x0004)):
            summary.has_gps = True


# ----------------------------- JPEG -----------------------------------------

def process_jpeg(blob):
    if blob[:2] != b"\xff\xd8":
        raise ValueError("not a jpeg")
    summary = ExifSummary()
    out = io.BytesIO()
    out.write(b"\xff\xd8")
    i = 2
    n = len(blob)
    while i < n:
        if blob[i] != 0xFF:
            out.write(blob[i:])  # scan data after SOS
            break
        while i < n and blob[i] == 0xFF:
            i += 1
        marker = blob[i]
        i += 1
        if marker == 0xD9:
            out.write(b"\xff\xd9")
            break
        if marker in (0xD0, 0xD1, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0x01):
            out.write(b"\xff" + bytes([marker]))  # no length
            continue
        seglen = struct.unpack(">H", blob[i:i + 2])[0]
        seg_with_len = blob[i:i + seglen]
        payload = seg_with_len[2:]
        keep = True
        if marker == 0xE1 and payload[:6] == b"Exif\x00\x00":
            _parse_tiff(payload[6:], summary)
            keep = False
        elif marker == 0xE1 and payload.startswith(b"http://ns.ad"):
            keep = False  # XMP
        elif marker in (0xED, 0xFE):
            keep = False  # IPTC/Photoshop, COM
        if keep:
            out.write(b"\xff" + bytes([marker]) + seg_with_len)
        i += seglen
        if marker == 0xDA:
            out.write(blob[i:])  # entropy scan + EOI
            break
    return out.getvalue(), summary


# ----------------------------- PNG ------------------------------------------

_DROP_PNG = {b"tEXt", b"zTXt", b"iTXt", b"eXIf"}


def process_png(blob):
    if blob[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a png")
    summary = ExifSummary()
    out = io.BytesIO()
    out.write(blob[:8])
    i = 8
    n = len(blob)
    while i + 8 <= n:
        length = struct.unpack(">I", blob[i:i + 4])[0]
        ctype = blob[i + 4:i + 8]
        body = blob[i + 8:i + 8 + length]
        if ctype == b"eXIf":
            _parse_tiff(body, summary)
        if ctype in _DROP_PNG:
            summary.tag_count += 1
        else:
            out.write(blob[i:i + 12 + length])
        i += 12 + length
    return out.getvalue(), summary


def sanitize(blob, content_type):
    if content_type == "image/jpeg" or blob[:2] == b"\xff\xd8":
        return process_jpeg(blob)
    if content_type == "image/png" or blob[:8] == b"\x89PNG\r\n\x1a\n":
        return process_png(blob)
    return blob, ExifSummary()
