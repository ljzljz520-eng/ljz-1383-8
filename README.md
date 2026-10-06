# 🌿 园丁日志（Gardening Blogger Journal）

纯 Python 标准库实现（`wsgiref` + `sqlite3`，无需 pip 安装任何依赖）的个人园艺日志站。
区分**植物个体 / 盆器位置 / 栽培记录**，按站主声明的**地区与分季规则**浏览，
管理接口录入植物、照片与观察，支持**跨设备离线补记**与冲突处理。

## 运行

```bash
python3 scripts/seed.py          # 可选：写入演示数据（含 EXIF 照片、分株、订正、撤回文章）
python3 -m app.server            # http://localhost:8000
```

- 公开站点：首页 `/`、季节/环境浏览 `/browse`、植物 `/plants`、观察 `/observations/<id>`、
  文章 `/articles`、环境 `/environments`
- 管理台：`/admin/`（Bearer Token，默认 `devtoken`，存于 `site_config.admin_token`）
- 数据库：`data/garden.db`（可用环境变量 `GARDEN_DB` 覆盖）；上传文件：`data/uploads/`

## 测试

```bash
python3 -m unittest tests.test_acceptance -v
# 13 项验收测试：多盆个体、身份来源、跨地区季节、同日多观察、离线补传、
# EXIF 隐私、文章撤回/冲突、索引重建、经验版本化、环境变更不改写历史……
```

## 需求如何落实

### 1. 数据库区分个体 / 盆器位置 / 栽培记录
- `plant_individuals` 是活的植物主体（全站唯一 accession，如 `G-2026-0001`）。
- `pots` 是盆器，`pot_placements` 记录盆在环境中的位置随时间变化（`placed_from/placed_to`）。
- `environments` 是南阳台/北窗台/露台等环境。
- `plant_events` 是只追加的身份/栽培账本：`acquire | repot | move | divide_out | correct_name | note`。
- **同品种两盆 = 两条植物档案**，没有任何按品种合并的逻辑。

### 2. 移盆、分株、品种订正保留身份来源
- 分株新建子株，写入 `parent_plant_id` / `origin_event_id` 与 `source_note`，母株账本保留 `divide_out` 事件。
- 品种订正向 `plant_name_history` 与账本追加一条 `correct_name`（含 previous/new name），
  旧名称对过去日期仍可经 `plant_name_as_of()` 查到。
- 移盆（repot）与挪位（move 同盆换环境）都会保留 from/to。

### 3. 照片说明跟随当时对象，不被最新标签覆盖
- `photos.caption` 与 `photos.subject_label` 在上传时定格；订正植物名不更新它们。
- 照片说明如需修改走 `photo_caption_revisions`（留痕），`subject_label` 任何时候都不改。
- 上传即剥离隐私：JPEG 删除 APP1 Exif/XMP、APP13、COM；PNG 删除 tEXt/zTXt/iTXt/eXIf。
  剥离前在服务端解析 `DateTimeOriginal`/GPS 是否存在，仅存服务端（`taken_at`,`gps_removed`），
  公开文件不再携带（测试验证 `Exif\0\0` 与描述串已不存在且 JPEG 结构仍完整）。

### 4. 春夏秋冬由站主声明的地区和分季规则决定
- `regions` 由站主声明；`season_rules` 用**日序边界**（按闰年历映射，支持 2/29 与跨年冬季）。
- 同一天在不同地区可以是不同季节（演示：2026-10-06 昆明=秋、哈尔滨=冬）。
- 边界必须互不相同且四季区间非空，非法规则返回 400；不存在按月份的硬编码季节表。
- 观察写入时把季节快照存入 `observations.season`；筛选索引可按当前规则重建，不改动原始行。

### 5. 观察事件追加 vs 整篇文章覆盖
- 观察 `POST /api/admin/observations` 只追加；**同一天不设唯一约束**，可多条。
  事后想法走 `/revisions` 追加，原始 `body` 永不改变。
- 文章是整篇文档，`current_version` 乐观锁：离线/另一设备的陈旧覆盖返回 **409 version_conflict**，
  需拉取合并后 `force=true` 再提交；每个版本都在 `article_versions`。
- 经验总结 `experiences` 独立版本化，`is_personal_record=1` + `scope_note` 明确
  “仅本人某盆某条件”，系统不会把它推成其他植物的养护指令。

### 6. 跨设备离线补记与冲突
- 管理台在浏览器离线时把变更按 `client_uid` 存入 localStorage 队列，联网后
  `POST /api/admin/sync/push` 批量补传。
- 服务端按 `client_uid` 幂等去重；同一 `(device_id, client_batch_id)` 重放返回既有结果，
  换机/网络重试都不会产生重复观察。
- 追加类条目不冲突；文档覆盖类逐条返回 `conflict`，单条错误不影响整批，结果写入 `sync_log`。

### 7. 页面显示两个日期；环境变化不改写过去
- 观察页同时显示 **观察日期 `observed_at`** 与 **录入/发表日期 `created_at`**（补传时二者不同）。
- 观察写入时冻结 `env_snapshot / pot_snapshot / plant_name_snapshot`；
  之后挪盆、改环境只影响新数据与当前统计（`/api/stats/environments`），历史条件不被改写。

### 8. 撤回与筛选索引重建
- `POST /articles/<id>/status {withdrawn}`：公开列表移除，URL 返回 **410 Gone**，版本与撤回时间保留。
- `POST /api/admin/index/rebuild` 清空并从原始观察重建 `observation_index`；
  `/api/index/status` 可核对索引行数与原始行数是否一致。

## 主要 API（均为 JSON；除 GET 公开读接口外需 `Authorization: Bearer <token>`）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/admin/region` | 声明/切换站主地区 |
| POST | `/api/admin/season-rules` | 建立分季规则（4 个日序边界），可激活 |
| POST | `/api/admin/environments` `/pots` `/plants` | 档案录入 |
| POST | `/api/admin/plants/<id>/events` | 移盆/挪位/分株/订正（追加账本） |
| POST | `/api/admin/observations` `/observations/<id>/revisions` | 原始观察 / 事后补记 |
| POST | `/api/admin/photos` (multipart) | 照片上传，自动剥离 EXIF/GPS |
| POST | `/api/admin/articles` `/articles/<id>/versions` `/articles/<id>/status` | 文章版本与撤回 |
| POST | `/api/admin/experiences` `/experiences/<id>/versions` | 个人经验版本 |
| POST | `/api/admin/sync/push` | 离线批量补传（幂等/冲突明细） |
| POST | `/api/admin/index/rebuild` | 重建筛选索引 |
| GET | `/api/browse`类页面 / `/api/observations?season=&environment=&date=&plant=` | 浏览与筛选 |
| GET | `/api/stats/environments` `/api/region` `/api/index/status` | 统计与状态 |
