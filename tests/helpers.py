import io
import json
import os
import struct
import sys
import tempfile
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from app.server import GardenApp


class Client:
    def __init__(self, app, token="devtoken", device="dev"):
        self.app = app
        self.token = token
        self.device = device

    def call(self, method, path, body=None, headers=None, raw=None, ctype=None):
        if "?" in path:
            path, qs = path.split("?", 1)
        else:
            qs = ""
        h = {"Authorization": f"Bearer {self.token}", "X-Device-Id": self.device}
        if headers:
            h.update(headers)
        if raw is not None:
            h["CONTENT_TYPE"] = ctype or "application/json"
        elif body is not None:
            raw = json.dumps(body).encode()
            h["CONTENT_TYPE"] = "application/json"
        else:
            raw = b""
        environ = {
            "REQUEST_METHOD": method,
            "PATH_INFO": path,
            "QUERY_STRING": qs,
            "CONTENT_TYPE": h.pop("CONTENT_TYPE", ""),
            "CONTENT_LENGTH": str(len(raw)),
            "HTTP_AUTHORIZATION": h.get("Authorization", ""),
            "HTTP_X_DEVICE_ID": h.get("X-Device-Id", ""),
            "wsgi.input": io.BytesIO(raw),
        }
        captured = {}

        def start_response(status, headers):
            captured["status"] = status
            captured["headers"] = headers

        out = b"".join(self.app(environ, start_response))
        status_code = int(captured["status"].split()[0])
        ctp = dict((k.lower(), v) for k, v in captured["headers"]).get("content-type", "")
        if "application/json" in ctp:
            return status_code, json.loads(out.decode()), out
        return status_code, out, out

    def get(self, path):
        return self.call("GET", path)

    def post(self, path, body):
        return self.call("POST", path, body=body)

    def multipart(self, path, fields, files):
        boundary = "----gtest" + uuid.uuid4().hex
        buf = b""
        for k, v in fields.items():
            buf += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
        for k, (filename, ctype, content) in files.items():
            buf += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"; "
                    f"filename=\"{filename}\"\r\nContent-Type: {ctype}\r\n\r\n").encode()
            buf += content + b"\r\n"
        buf += f"--{boundary}--\r\n".encode()
        return self.call("POST", path, raw=buf,
                         ctype=f"multipart/form-data; boundary={boundary}")


def jpeg_with_exif():
    desc = b"SECRET DESC\x00"
    dto = b"2026:03:03 07:07:07\x00"
    ifd0_off, endian = 8, "<"
    ifd0_size = 2 + 3 * 12 + 4
    desc_off = ifd0_off + ifd0_size
    exif_off = desc_off + len(desc)
    dto_off = exif_off + (2 + 12 + 4)
    gps_off = dto_off + len(dto)

    def ifd(ents):
        out = struct.pack(endian + "H", len(ents))
        for tag, typ, cnt, vb in ents:
            out += struct.pack(endian + "HHI", tag, typ, cnt) + vb
        return out + struct.pack(endian + "I", 0)

    tiff = (b"II\x2a\x00" + struct.pack(endian + "I", 8) + ifd([
        (0x010E, 2, len(desc), struct.pack(endian + "I", desc_off)),
        (0x8769, 4, 1, struct.pack(endian + "I", exif_off)),
        (0x8825, 4, 1, struct.pack(endian + "I", gps_off))]) + desc
        + ifd([(0x9003, 2, len(dto), struct.pack(endian + "I", dto_off))]) + dto
        + ifd([(0x0001, 2, 2, b"E\x00\x00\x00"),
               (0x0002, 5, 1, struct.pack(endian + "I", gps_off + 28))])
        + struct.pack(endian + "II", 12, 1))
    payload = b"Exif\x00\x00" + tiff
    return (b"\xff\xd8" + b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload
            + bytes.fromhex("ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432")
            + bytes.fromhex("ffc0000b080001000101011100")
            + bytes.fromhex("ffda0008010100003f00") + b"\x00\xff\xd9")


def make_app(tmpdir):
    db = os.path.join(tmpdir, "test.db")
    app = GardenApp(db_path=db)
    # point uploads into temp dir to avoid littering repo
    import app.server as srv
    srv.UPLOAD_DIR = os.path.join(tmpdir, "uploads")
    return app, Client(app)
