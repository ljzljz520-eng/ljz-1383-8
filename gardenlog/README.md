# 🪴 GardenLog — 园艺博主日志站

按**季节与环境**浏览的个人园艺日志；管理接口录入植物个体、照片与观察；
数据库把**植物个体 / 盆器位置 / 栽培记录**分成三类实体，并保留身份来源与历史快照。

## 运行

```bash
npm install
npm start                 # http://localhost:3000
# 可选环境变量
PORT=3000 ADMIN_TOKEN=你的令牌 GARDENLOG_DATA=./data npm start
npm test                  # 7 组验收测试（node:test，自带临时库，不写真实数据）
```

默认管理令牌 `devtoken`（页面右上角输入登录）。生产请用 `ADMIN_TOKEN` 覆盖。
前端是无构建的原生 JS SPA（`public/`），后端 Express + SQLite（`better-sqlite3`，单文件库，
换机时拷 `data/` 目录即可）。

## 需求 → 实现对照

### 数据模型：个体 ≠ 品种 ≠ 盆
- `plants` 是**植物个体**：同品种多盆必须分别建档（`code` 唯一，如 PL-001/PL-002），统计各自独立。
- `pots` 是**盆器**：盆可空置、可被不同植物先后使用。
- `locations` + `location_periods` 是**环境与条件时段**。
- `plant_pot_periods` 是**栽培记录**：植物在哪个盆、哪个环境、自何时起（`reason`：初植/移盆/分株/换环境），
  结束日期非破坏式关闭，形成完整时间线。
- `plant_identity_events` 保留**身份来源**：`acquired / split_from / correction / rename`。
  品种订正只新增事件并更新当前标签，个体 id 与历史永不被改写；分株产生新个体并指向母株。

### 季节：站主声明，而非全球统一月份
- `site_settings` 存站主声明的**地区**与四季起点 `{spring:[m,d],…}`，默认北半球气象季节（3/1、6/1、9/1、12/1）。
- 管理端可改为任意规则（如悉尼：春 9/1、夏 12/1、秋 3/1、冬 6/1），跨年段自动归入年内起点最晚的季节。
- 规则变更写入 `settings_history`。每条观察录入时按当时规则算出 `season`（冗余索引）。
- **重建筛选索引** `POST /api/admin/reindex`：按当前规则全量重算季节标签（验收项）。

### 快照：说明跟随"当时对象"，最新标签不回写
观察（及照片）在保存时冻结：植物标签、品种、盆编号、环境名、**当时环境条件**。
之后植物改名、品种订正、移盆、环境加遮阳网，都只影响今后的观察；旧卡片显示旧标签与旧条件，
统计也按快照聚合（环境变化影响今后统计，不改写过去）。

### 观察事件：追加式；原始观察与经验分别版本化
- 同一天可多次观察，按 `obs_date` + 录入时间并存。
- `observation_versions`：`v1` 永远是 `raw`（原始观察，不可改）；事后补充是 `revision`（新版本，当前文），
  经验总结是 `kind=experience` 的**独立版本**——只是个人记录，公开侧不展示，
  也不会自动推广为其他植物/品种的养护指令（文章只能显式勾选引用观察）。
- 页面同时显示 **观察日期 `obs_date`** 与 **发表日期 `created_at`**，支持早于今天的补记（补记按该日期回溯盆/环境/季节）。

### 公开文章：整篇覆盖式（与观察的追加式相对）
- 文章编辑是**整篇覆盖**，每次覆盖留存 `article_versions`。
- 可发表、**撤回**：公开侧 `GET /api/articles/:id` 返回 **410 Gone**，列表不再出现；管理端仍可见可恢复。
- 观察本身也支持撤回/重新发布；撤回后其照片公开访问同样 403。

### 照片与 EXIF 隐私
- 上传走 `POST /api/admin/photos`（multipart），服务端在落盘前剥离 EXIF（JPEG 仅保留 JFIF(APP0)
  与图像必需段，删除 APP1 EXIF/XMP、其余 APP 段与 COM；PNG 删除 eXIf/tEXt 等块），不重编码像素。
- 剥离前只提取站内需要的两项：`DateTimeOriginal`（拍摄时间）与**是否曾含 GPS**（用于提示站主），
  相机型号、软件、定位等一律不入库。
- 照片只经受控接口 `/api/photos/:id` 读取（校验观察公开状态），磁盘文件名随机化，原始文件不外发。
- 照片说明与标签为**上传时快照**；植物后来改名/订正品种，不回写旧照片。

### 跨设备离线补记与冲突
- 前端离线/请求失败时把操作（每条带 UUID `client_op_id`、设备号、本地引用名）存入 localStorage 队列；
  联网后在"同步中心"批量 `POST /api/admin/sync`。
- 服务端在单事务内逐操作重放：
  - **幂等**：已应用的 `client_op_id` 直接回放结果（换机重复补传不产生重复观察）；
  - **批次引用映射**：同批"先建植物再补观察"用 `local_ref` 自动换成服务端新 id；
  - **冲突不静默**：乐观锁 `base_version` 过期 → 409 并进 `sync_conflicts` 队列，
    同步中心可"接受（按最新版本号重放）/拒绝"；唯一约束等异常也入队。
- 观察是追加式（天然利于离线合并）；文章是整篇覆盖（最后写入需人工意识到覆盖语义）。

## 主要接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/settings` | 地区与分季规则 |
| PUT | `/api/admin/settings` | 站主声明新地区/规则 |
| POST | `/api/admin/reindex` | 按当前规则重建季节索引 |
| GET/POST | `/api/locations` `/api/admin/locations` | 环境 |
| POST | `/api/admin/locations/:id/conditions` | 环境条件变化（时段） |
| GET/POST | `/api/pots` `/api/admin/pots` | 盆器 |
| GET/POST | `/api/plants` `/api/admin/plants` | 植物个体 |
| POST | `/api/admin/plants/:id/correct` | 品种订正（留痕） |
| POST | `/api/admin/plants/:id/split` | 分株建档（身份来源） |
| POST | `/api/admin/plants/:id/repot` `/move` | 移盆 / 换环境（可补记日期） |
| GET | `/api/plants/:id` | 身份链 + 栽培时段 + 观察时间线 |
| POST | `/api/admin/observations` | 录入观察（支持 `obs_date` 补记、`client_op_id` 幂等） |
| GET | `/api/observations?season=&location_id=&plant_id=&from=&to=&q=` | 按季节/环境浏览 |
| POST | `/api/admin/observations/:id/revisions` | 追加 `revision` / `experience`（乐观锁） |
| POST | `/api/admin/observations/:id/withdraw` `/publish` | 撤回 / 重新发表 |
| POST | `/api/admin/photos` | 照片上传（EXIF 剥离 + 快照） |
| GET | `/api/photos/:id` | 受控取图（撤回后公开 403） |
| GET | `/api/stats/overview` | 按季节/当时环境/个体聚合 |
| GET/POST/PUT | `/api/articles` … | 文章：整篇覆盖 + 版本 |
| POST | `/api/admin/articles/:id/publish` `/withdraw` | 发表 / 撤回（410） |
| POST | `/api/admin/sync` | 离线操作批量补传（幂等/引用映射/冲突） |
| GET | `/api/admin/sync/state` | 已应用操作 + 冲突队列 |

## 验收测试（`test/acceptance.test.js`）

1. 移到新环境后旧记录补传：旧观察保留旧盆/旧环境/旧条件快照；重复补传幂等。
2. 同一天多次观察并存；改南半球规则并重建索引后 3 月变秋、12 月为夏。
3. 照片 EXIF 落盘前剥离（无 APP1、保留 JFIF），仍记录拍摄时间与 GPS 是否存在；品种订正后照片快照不变。
4. 文章整篇覆盖留版本、撤回公开 410；观察 raw 不被 revision 覆盖；经验单独版本化且公开侧不可见；过期版本号 409。
5. 两设备同改一条观察：过期写入进冲突队列不覆盖；观察撤回后照片公开 403；重新发布恢复。
6. 分株后代保留母株身份来源；同品种三株独立。
7. 统计按当时快照聚合，环境变化不改写过去统计。
