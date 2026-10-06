"""Populate a demo database: two regions with different season rules,
multiple potted individuals, division, name correction, observations across
seasons, EXIF/GPS-bearing photos, a withdrawn article, an experience record."""
import os
import sys
import struct

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from app.db import init_db, set_config
from app import services as svc

ROOT = os.path.dirname(os.path.dirname(__file__))
DB = os.environ.get("GARDEN_DB", os.path.join(ROOT, "data", "garden.db"))
UPLOAD = os.path.join(ROOT, "data", "uploads")


def make_jpeg_with_exif():
    """Minimal JPEG carrying EXIF (DateTimeOriginal + GPS latitude), for testing
    privacy stripping end-to-end."""
    desc = b"Garden GPS demo\x00"
    dto = b"2026:05:02 08:30:00\x00"
    ifd0_off = 8
    ifd0_size = 2 + 3 * 12 + 4
    desc_off = ifd0_off + ifd0_size
    exif_off = desc_off + len(desc)
    exif_size = 2 + 1 * 12 + 4
    dto_off = exif_off + exif_size
    gps_off = dto_off + len(dto)
    endian = "<"

    def ifd(ents):
        out = struct.pack(endian + "H", len(ents))
        for tag, typ, cnt, valbytes in ents:
            out += struct.pack(endian + "HHI", tag, typ, cnt) + valbytes
        out += struct.pack(endian + "I", 0)
        return out

    ifd0 = ifd([
        (0x010E, 2, len(desc), struct.pack(endian + "I", desc_off)),
        (0x8769, 4, 1, struct.pack(endian + "I", exif_off)),
        (0x8825, 4, 1, struct.pack(endian + "I", gps_off)),
    ])
    exif_ifd = ifd([(0x9003, 2, len(dto), struct.pack(endian + "I", dto_off))])
    # GPS IFD: north/south ref ascii + latitude rational pointer (points to a 0/1 rational)
    rational_off = gps_off + (2 + 2 * 12 + 4)
    gps_ifd = ifd([
        (0x0001, 2, 2, b"N\x00\x00\x00"),
        (0x0002, 5, 1, struct.pack(endian + "I", rational_off)),
    ])
    tiff = (b"II\x2a\x00" + struct.pack(endian + "I", ifd0_off) + ifd0 + desc
            + exif_ifd + dto + gps_ifd + struct.pack(endian + "II", 0, 1))

    soi = b"\xff\xd8"
    app1_payload = b"Exif\x00\x00" + tiff
    app1 = b"\xff\xe1" + struct.pack(">H", len(app1_payload) + 2) + app1_payload
    dqt = bytes.fromhex("ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432")
    sof = bytes.fromhex("ffc0000b080001000101011100")
    dht = bytes.fromhex("ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa")
    sos = bytes.fromhex("ffda0008010100003f00") + b"\x00"
    return soi + app1 + dqt + sof + dht + sos + b"\xff\xd9"


def main():
    if os.path.exists(DB):
        os.remove(DB)
    conn = init_db(DB)

    km = conn.execute(
        "INSERT INTO regions(code,name,climate_note) VALUES('kunming','昆明','云贵高原，四季如春，入春晚')").lastrowid
    hb = conn.execute(
        "INSERT INTO regions(code,name,climate_note) VALUES('harbin','哈尔滨','东北，冬季漫长，春秋短')").lastrowid
    set_config(conn, "active_region_id", km)

    conn.execute(
        """INSERT INTO season_rules(region_id,label,is_active,created_at,
           spring_doy,summer_doy,autumn_doy,winter_doy)
           VALUES (?, '昆明温和四季', 1, ?, 51, 142, 234, 326)""",
        (km, svc.now_iso()))
    conn.execute(
        """INSERT INTO season_rules(region_id,label,is_active,created_at,
           spring_doy,summer_doy,autumn_doy,winter_doy)
           VALUES (?, '哈尔滨长冬短春', 0, ?, 117, 168, 224, 280)""",
        (hb, svc.now_iso()))

    south = conn.execute(
        "INSERT INTO environments(name,kind,light,active_from,note) VALUES('南阳台','indoor','全日照','2026-01-01','封闭阳台')").lastrowid
    north = conn.execute(
        "INSERT INTO environments(name,kind,light,active_from,note) VALUES('北窗台','indoor','散射光','2026-01-01','通风一般')").lastrowid
    patio = conn.execute(
        "INSERT INTO environments(name,kind,light,active_from,note) VALUES('露台','outdoor','全日照+雨淋','2026-04-01','春末后使用')").lastrowid

    p1 = conn.execute("INSERT INTO pots(code,material,diameter_cm,created_at) VALUES('P-001','红陶',12,?)", (svc.now_iso(),)).lastrowid
    p2 = conn.execute("INSERT INTO pots(code,material,diameter_cm,created_at) VALUES('P-002','红陶',15,?)", (svc.now_iso(),)).lastrowid
    p3 = conn.execute("INSERT INTO pots(code,material,diameter_cm,created_at) VALUES('P-003','塑料',10,?)", (svc.now_iso(),)).lastrowid

    a, acc1 = svc.create_plant(conn, name="月影 Echeveria elegans", acquired_date="2026-02-01",
                               source_note="花市购入", pot_id=p1, environment_id=south,
                               position="西侧第一层")
    b, acc2 = svc.create_plant(conn, name="月影 Echeveria elegans", acquired_date="2026-02-01",
                               source_note="另一批同品种，独立个体", pot_id=p2, environment_id=north,
                               position="北窗台东头")

    svc.create_observation(conn, {"plant_id": a, "observed_at": "2026-05-02T08:30",
        "title": "清晨叶尖微红", "body": "南阳台全日照，土表干了三天，叶尖开始上状态。", "tags": "状态,光照"})
    svc.create_observation(conn, {"plant_id": a, "observed_at": "2026-05-02T19:40",
        "title": "傍晚再次查看", "body": "同日第二条：没有浇水，叶片硬挺。", "tags": "复查"})
    svc.create_observation(conn, {"plant_id": b, "observed_at": "2026-05-02T09:00",
        "title": "北窗台株型更散", "body": "散射光下摊大饼，与南阳台那盆不是同一株。", "tags": "对比"})
    svc.create_observation(conn, {"plant_id": a, "observed_at": "2026-08-10T10:00",
        "title": "度夏观察", "body": "遮阴后叶心发绿，未黑腐。", "tags": "度夏"})

    out = svc.add_identity_event(conn, a, {
        "event_type": "divide_out", "event_date": "2026-06-15",
        "from_pot_id": p1, "to_pot_id": p3, "to_environment_id": south,
        "new_name": "月影分株苗", "detail": "群生爆侧芽，切下一株单独养",
        "parent_name": "月影 Echeveria elegans"})
    child = out["child_plant_id"]
    svc.add_identity_event(conn, a, {
        "event_type": "correct_name", "event_date": "2026-09-01",
        "new_name": "月影×静夜 杂交苗", "detail": "花友核对叶形，原标签有误，品种订正"})
    svc.add_identity_event(conn, a, {
        "event_type": "move", "event_date": "2026-04-20",
        "pot_id": p1, "from_environment_id": south, "to_environment_id": patio,
        "position": "露台西架", "detail": "天暖搬露台"})

    jpg = make_jpeg_with_exif()
    os.makedirs(UPLOAD, exist_ok=True)
    ph1, priv1 = svc.save_photo(conn, blob=jpg, content_type="image/jpeg",
        filename="may-rosette.jpg", plant_id=a,
        caption="5月南阳台的莲座（当时还叫月影）", upload_dir=UPLOAD)
    ph2, priv2 = svc.save_photo(conn, blob=jpg, content_type="image/jpeg",
        filename="division.jpg", plant_id=child,
        caption="分株下来的小苗上盆", upload_dir=UPLOAD)

    first_obs = conn.execute(
        "SELECT id FROM observations WHERE plant_id=? ORDER BY id LIMIT 1", (a,)).fetchone()["id"]
    svc.add_observation_revision(conn, first_obs, "一个月后回看：那天其实已经该浇水了，判断偏保守。")

    aid, _ = svc.create_article(conn, slug="spring-balcony",
        title="昆明春天的阳台多肉", body="按昆明本地季节，2月底入春……记录本人南阳台。",
        status="published", change_summary="发表")
    wid, _ = svc.create_article(conn, slug="old-watering",
        title="一篇旧浇水文", body="内容已不适用，撤回处理。", status="published")
    svc.set_article_status(conn, wid, "withdrawn")
    svc.update_article(conn, aid, title="昆明春天的阳台多肉（修订）",
        body="按昆明本地季节，2月底入春……补充5月状态。",
        expected_version=1, change_summary="补充观察")

    eid, _ = svc.create_experience(conn, plant_id=a,
        scope_note="仅本人南阳台这一盆、2026年春的条件",
        title="控水节奏（个人记录）", body="晴好天气约10天一次，仅供自己复盘。")
    svc.add_experience_version(conn, eid, title="控水节奏（个人记录 v2）",
        body="入夏后拉长到14天。仍是个体经验，不作为通用养护指令。",
        change_summary="入夏调整", expected_version=1)

    svc.rebuild_index(conn)
    conn.commit()
    print("seeded:", DB)
    print("plant A:", acc1, "plant B:", acc2, "child id:", child)
    print("photo privacy:", priv1, priv2)


if __name__ == "__main__":
    main()
