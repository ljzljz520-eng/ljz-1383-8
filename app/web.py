"""Server-rendered public HTML pages (stdlib string templates)."""
import html
from .seasons import SEASON_CN, active_rule, rule_boundaries, season_for_date, parse_date
from . import services
from datetime import date


def esc(x):
    return html.escape(str(x if x is not None else ""))


LAYOUT = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · 园丁日志</title>
<link rel="stylesheet" href="/static/style.css">
</head><body>
<header class="topbar">
  <a class="brand" href="/">🌿 园丁日志</a>
  <nav>
    <a href="/browse">按季节/环境浏览</a>
    <a href="/plants">植物档案</a>
    <a href="/articles">文章</a>
    <a href="/environments">环境</a>
    <a href="/admin/">管理台</a>
  </nav>
  <div class="region">站主地区：<b>{region}</b> · 当前季节：<b>{season_now}</b>
  <span class="rulenote">（季节由站主声明的分季规则决定，不按月份一刀切）</span></div>
</header>
<main>{body}</main>
<footer>个人种植记录 · 经验总结仅为本人环境下的记录，不作为通用养护指令</footer>
</body></html>"""


def _ctx(conn):
    from .db import get_config
    rid = get_config(conn, "active_region_id", "1")
    region = conn.execute("SELECT * FROM regions WHERE id=?", (rid,)).fetchone()
    try:
        rule = active_rule(conn, rid)
        s = season_for_date(date.today(), rule_boundaries(rule))
        season_now = f"{SEASON_CN[s]}（规则：{esc(rule['label'])}）"
    except Exception as e:
        season_now = "未设置分季规则"
    region_label = f"{esc(region['name'])}（{esc(region['code'])}）" if region else "未声明"
    return region_label, season_now


def page(conn, title, body, status="200 "):
    region, season_now = _ctx(conn)
    html_doc = LAYOUT.format(title=esc(title), region=region,
                             season_now=season_now, body=body)
    return status, html_doc


def home(conn):
    recent = conn.execute(
        """SELECT o.*, p.accession FROM observations o
           JOIN plant_individuals p ON p.id=o.plant_id
           WHERE o.is_public=1 ORDER BY o.observed_date DESC, o.id DESC LIMIT 10"""
    ).fetchall()
    rows = "".join(
        f"""<article class="card">
          <div class="meta">{esc(r['observed_date'])} · {SEASON_CN.get(r['season'], r['season'])}
            · {esc(r['env_snapshot'])} · {esc(r['plant_name_snapshot'])}
            <span class="acc">{esc(r['accession'])}</span></div>
          <h3><a href="/observations/{r['id']}">{esc(r['title'] or '（无标题观察）')}</a></h3>
          <p>{esc(r['body'][:140])}</p>
          <div class="dates">观察日期 {esc(r['observed_at'])} ｜ 录入/发表 {esc(r['created_at'])}</div>
        </article>""" for r in recent)
    body = f"""<h1>最近观察</h1>
      <p>按站主地区的分季规则浏览：
        <a href="/browse?season=spring">春</a> ·
        <a href="/browse?season=summer">夏</a> ·
        <a href="/browse?season=autumn">秋</a> ·
        <a href="/browse?season=winter">冬</a></p>
      <section class="list">{rows or '<p>暂无公开观察。</p>'}</section>"""
    return page(conn, "首页", body)


def browse(conn, season=None, environment_id=None, q=None):
    sql = """SELECT oi.*, o.title, o.body, o.observed_at, o.created_at,
                    o.env_snapshot, o.plant_name_snapshot, p.accession
             FROM observation_index oi
             JOIN observations o ON o.id=oi.observation_id
             JOIN plant_individuals p ON p.id=oi.plant_id
             WHERE oi.is_public=1"""
    args = []
    if season:
        sql += " AND oi.season=?"; args.append(season)
    if environment_id:
        sql += " AND oi.environment_id=?"; args.append(environment_id)
    if q:
        sql += " AND (o.body LIKE ? OR o.title LIKE ? OR oi.tags LIKE ?)"
        args += [f"%{q}%"] * 3
    sql += " ORDER BY oi.observed_date DESC, oi.observation_id DESC"
    rows = conn.execute(sql, args).fetchall()
    envs = conn.execute("SELECT id, name FROM environments ORDER BY id").fetchall()
    env_opts = "".join(
        f'<option value="{e["id"]}" {"selected" if str(environment_id)==str(e["id"]) else ""}>{esc(e["name"])}</option>'
        for e in envs)
    cards = "".join(
        f"""<article class="card">
          <div class="meta">{esc(r['observed_date'])} · {SEASON_CN.get(r['season'])} ·
            {esc(r['env_snapshot'])} · {esc(r['plant_name_snapshot'])}
            <span class="acc">{esc(r['accession'])}</span></div>
          <h3><a href="/observations/{r['observation_id']}">{esc(r['title'] or '（无标题观察）')}</a></h3>
          <p>{esc(r['body'][:160])}</p></article>""" for r in rows)
    body = f"""<h1>按季节与环境浏览</h1>
      <form class="filters" method="get" action="/browse">
        <label>季节
          <select name="season">
            <option value="">全部</option>
            {''.join(f'<option value="{s}" {"selected" if season==s else ""}>{SEASON_CN[s]}</option>' for s in ("spring","summer","autumn","winter"))}
          </select></label>
        <label>环境 <select name="environment"><option value="">全部</option>{env_opts}</select></label>
        <label>关键词 <input name="q" value="{esc(q)}"></label>
        <button>筛选</button>
      </form>
      <p>共 {len(rows)} 条（索引可由管理台重建）</p>
      <section class="list">{cards or '<p>没有匹配的观察。</p>'}</section>"""
    return page(conn, "浏览", body)


def plant_detail(conn, pid):
    p = conn.execute("SELECT * FROM plant_individuals WHERE id=?", (pid,)).fetchone()
    if not p:
        return page(conn, "未找到", "<h1>植物不存在</h1>", "404 ")
    events = conn.execute(
        "SELECT * FROM plant_events WHERE plant_id=? ORDER BY event_date, id", (pid,)).fetchall()
    names = conn.execute(
        "SELECT * FROM plant_name_history WHERE plant_id=? ORDER BY valid_from, id", (pid,)).fetchall()
    obs = conn.execute(
        "SELECT * FROM observations WHERE plant_id=? ORDER BY observed_date DESC, id DESC", (pid,)).fetchall()
    photos = conn.execute(
        "SELECT * FROM photos WHERE plant_id=? ORDER BY taken_at, id", (pid,)).fetchall()
    lineage = ""
    if p["parent_plant_id"]:
        par = conn.execute("SELECT accession, current_name FROM plant_individuals WHERE id=?",
                           (p["parent_plant_id"],)).fetchone()
        lineage = f'<p class="lineage">分株来源：<a href="/plants/{p["parent_plant_id"]}">{esc(par["accession"])} {esc(par["current_name"])}</a></p>'
    ev_html = "".join(
        f"<li><b>{esc(e['event_date'])}</b> {esc(e['event_type'])} — {esc(e['detail'])}"
        + (f"；{esc(e['previous_name'])} → {esc(e['new_name'])}" if e['event_type']=='correct_name' else "")
        + (f"；子株 #{e['child_plant_id']}" if e['child_plant_id'] else "") + "</li>"
        for e in events)
    nm_html = "".join(
        f"<li>{esc(n['valid_from'])} 起：{esc(n['name'])}（{esc(n['reason'])}）</li>" for n in names)
    ob_html = "".join(
        f"""<li><a href="/observations/{o['id']}">{esc(o['observed_date'])}</a>
        {SEASON_CN.get(o['season'])} · 当时名:{esc(o['plant_name_snapshot'])} ·
        {esc(o['title'])}</li>""" for o in obs)
    ph_html = "".join(
        f"""<figure><img src="/media/{esc(r['storage_path'])}" alt="">
        <figcaption>{esc(r['caption'])}<br><small>拍摄时对象标签：{esc(r['subject_label'])}
        ｜{esc(r['taken_at'] or '无拍摄时间')}</small></figcaption></figure>""" for r in photos)
    body = f"""<h1>{esc(p['accession'])} · {esc(p['current_name'])}</h1>
      {lineage}
      <p class="note">入档 {esc(p['acquired_date'])} · 来源：{esc(p['source_note'])}</p>
      <h2>身份与名称来源（品种订正留痕）</h2><ul>{nm_html}</ul>
      <h2>栽培/身份事件（移盆·分株·订正，追加不改写）</h2><ul>{ev_html}</ul>
      <h2>观察（同一天可有多条）</h2><ul>{ob_html or '<li>无</li>'}</ul>
      <h2>照片（说明跟随当时对象）</h2><div class="photos">{ph_html or '<p>无</p>'}</div>"""
    return page(conn, p["accession"], body)


def plants_list(conn):
    rows = conn.execute(
        "SELECT * FROM plant_individuals WHERE is_current=1 ORDER BY accession").fetchall()
    items = "".join(
        f"""<li><a href="/plants/{r['id']}">{esc(r['accession'])}</a> {esc(r['current_name'])}
        <small>入档 {esc(r['acquired_date'])}</small></li>""" for r in rows)
    return page(conn, "植物档案", f"<h1>植物个体</h1><p>同品种多盆各有独立档案，不合并为一株。</p><ul class='plantlist'>{items}</ul>")


def observation_page(conn, oid):
    o = conn.execute("SELECT * FROM observations WHERE id=?", (oid,)).fetchone()
    if not o or not o["is_public"]:
        return page(conn, "未找到", "<h1>观察不存在或未公开</h1>", "404 ")
    revs = conn.execute(
        "SELECT * FROM observation_revisions WHERE observation_id=? ORDER BY id", (oid,)).fetchall()
    photos = conn.execute("SELECT * FROM photos WHERE observation_id=?", (oid,)).fetchall()
    p = conn.execute("SELECT * FROM plant_individuals WHERE id=?", (o["plant_id"],)).fetchone()
    rev_html = "".join(
        f"<li><b>事后补记</b> {esc(r['created_at'])}：{esc(r['note'])}</li>" for r in revs)
    ph_html = "".join(
        f"""<figure><img src="/media/{esc(r['storage_path'])}">
        <figcaption>{esc(r['caption'])}<br><small>拍摄时标签：{esc(r['subject_label'])}</small></figcaption></figure>"""
        for r in photos)
    body = f"""<h1>{esc(o['title'] or '观察记录')}</h1>
      <p class="meta">{esc(o['observed_date'])} · {SEASON_CN.get(o['season'])} ·
        环境（当时）：{esc(o['env_snapshot'])} · 盆器（当时）：{esc(o['pot_snapshot'])} ·
        对象当时名：{esc(o['plant_name_snapshot'])}
        <a href="/plants/{p['id']}">{esc(p['accession'])}</a></p>
      <p class="bigdates">📅 观察日期：<b>{esc(o['observed_at'])}</b> ｜ 录入/发表日期：<b>{esc(o['created_at'])}</b></p>
      <div class="obbody">{esc(o['body'])}</div>
      <h3>追加补记（原始观察不被覆盖）</h3><ul>{rev_html or '<li>无</li>'}</ul>
      <div class="photos">{ph_html}</div>"""
    return page(conn, "观察", body)


def article_page(conn, slug):
    a = conn.execute("SELECT * FROM articles WHERE slug=?", (slug,)).fetchone()
    if not a:
        return page(conn, "未找到", "<h1>文章不存在</h1>", "404 ")
    if a["status"] != "published":
        return page(conn, "文章已撤回",
                    f"<h1>该文章已被站主撤回</h1><p>撤回时间：{esc(a['withdrawn_at'])}</p>",
                    "410 ")
    v = conn.execute(
        "SELECT * FROM article_versions WHERE article_id=? AND version=?",
        (a["id"], a["current_version"])).fetchone()
    body = f"""<article class="article">
      <h1>{esc(v['title'])}</h1>
      <p class="bigdates">发表日期：<b>{esc(a['published_at'])}</b> ｜ 最近更新：{esc(v['created_at'])} ｜ 版本 v{a['current_version']}</p>
      <div class="obbody">{esc(v['body']).replace(chr(10), '<br>')}</div></article>"""
    return page(conn, v["title"], body)


def articles_list(conn):
    rows = conn.execute(
        "SELECT * FROM articles WHERE status='published' ORDER BY published_at DESC").fetchall()
    items = "".join(
        f"""<li><a href="/articles/{esc(r['slug'])}">{esc(r['title'])}</a>
        <small>发表 {esc(r['published_at'])} · v{r['current_version']}</small></li>""" for r in rows)
    return page(conn, "文章", f"<h1>公开文章</h1><ul class='plantlist'>{items or '<li>暂无</li>'}</ul>")


def environments_page(conn):
    envs = conn.execute("SELECT * FROM environments ORDER BY id").fetchall()
    cards = ""
    for e in envs:
        n = conn.execute(
            "SELECT COUNT(*) c FROM observations WHERE environment_id=?", (e["id"],)).fetchone()["c"]
        cards += f"""<div class="card"><h3>{esc(e['name'])}</h3>
          <p>{esc(e['kind'])} · {esc(e['light'])}</p>
          <p class="meta">启用 {esc(e['active_from'])} · 累计观察（历史条件不变）{n} 条</p>
          <p>{esc(e['note'])}</p></div>"""
    return page(conn, "环境", f"<h1>栽培环境</h1><div class='grid'>{cards}</div>")
