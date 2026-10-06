// 公开文章：整篇覆盖式编辑（对比观察事件的追加式），版本化，可撤回
import { Router } from 'express';
import { nowIso } from '../db.js';
import { fail } from '../util.js';

export default function articleRouter(db) {
  const r = Router();

  r.get('/articles', (req, res) => {
    const admin = req.admin === true;
    const rows = admin
      ? db.prepare('SELECT * FROM articles ORDER BY id DESC').all()
      : db.prepare("SELECT * FROM articles WHERE status='published' ORDER BY published_at DESC, id DESC").all();
    res.json(rows);
  });

  r.get('/articles/:idOrSlug', (req, res) => {
    const key = req.params.idOrSlug;
    const a = /^\d+$/.test(key)
      ? db.prepare('SELECT * FROM articles WHERE id=?').get(+key)
      : db.prepare('SELECT * FROM articles WHERE slug=?').get(key);
    if (!a) return fail(res, 404, 'not_found');
    const admin = req.admin === true;
    if (a.status === 'withdrawn' && !admin) {
      return res.status(410).json({ error: 'withdrawn', status: 'withdrawn', withdrawn_reason: a.withdrawn_reason });
    }
    if (a.status === 'draft' && !admin) return fail(res, 404, 'not_found');
    const versions = db.prepare('SELECT id,version,title,editor,created_at FROM article_versions WHERE article_id=? ORDER BY version').all(a.id);
    const refs = db.prepare(`SELECT ao.observation_id, o.obs_date, o.plant_name_snapshot
                             FROM article_observations ao JOIN observations o ON o.id=ao.observation_id
                             WHERE ao.article_id=?`).all(a.id);
    res.json({ ...a, versions, linked_observations: refs });
  });

  function upsert(id, body) {
    const { title, body: text, slug = null } = body || {};
    if (!title || !text) return { error: 400, reason: 'title_and_body_required' };
    const now = nowIso();
    if (id) {
      const a = db.prepare('SELECT * FROM articles WHERE id=?').get(id);
      if (!a) return { error: 404, reason: 'not_found' };
      const nv = a.version + 1;
      db.transaction(() => {
        db.prepare('UPDATE articles SET title=?, body=?, slug=?, version=?, updated_at=? WHERE id=?')
          .run(title, text, slug, nv, now, id);
        db.prepare('INSERT INTO article_versions(article_id,version,title,body,editor,created_at) VALUES(?,?,?,?,?,?)')
          .run(id, nv, title, text, 'owner', now);
      })();
      return { id, version: nv };
    }
    const res2 = db.transaction(() => {
      const aid = db.prepare('INSERT INTO articles(slug,title,body,version,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(slug, title, text, 1, 'draft', now, now).lastInsertRowid;
      db.prepare('INSERT INTO article_versions(article_id,version,title,body,editor,created_at) VALUES(?,?,?,?,?,?)')
        .run(aid, 1, title, text, 'owner', now);
      return aid;
    })();
    return { id: res2, version: 1 };
  }

  r.post('/admin/articles', (req, res) => {
    const out = upsert(null, req.body);
    if (out.error) return fail(res, out.error, out.reason);
    res.status(201).json({ ok: true, ...out, mode: 'whole_replace', notice: '文章按整篇覆盖保存，每次覆盖留存版本。' });
  });

  r.put('/admin/articles/:id', (req, res) => {
    const out = upsert(+req.params.id, req.body);
    if (out.error) return fail(res, out.error, out.reason);
    res.json({ ok: true, ...out, mode: 'whole_replace' });
  });

  r.post('/admin/articles/:id/publish', (req, res) => {
    const id = +req.params.id;
    const a = db.prepare('SELECT * FROM articles WHERE id=?').get(id);
    if (!a) return fail(res, 404, 'not_found');
    db.prepare("UPDATE articles SET status='published', published_at=COALESCE(published_at,?), updated_at=? WHERE id=?")
      .run(nowIso(), nowIso(), id);
    res.json({ ok: true });
  });

  // 撤回：公开 410，管理端仍在
  r.post('/admin/articles/:id/withdraw', (req, res) => {
    const id = +req.params.id;
    const a = db.prepare('SELECT * FROM articles WHERE id=?').get(id);
    if (!a) return fail(res, 404, 'not_found');
    db.prepare("UPDATE articles SET status='withdrawn', withdrawn_reason=?, updated_at=? WHERE id=?")
      .run(req.body?.reason || '站主撤回', nowIso(), id);
    res.json({ ok: true });
  });

  r.post('/admin/articles/:id/link-observations', (req, res) => {
    const id = +req.params.id;
    if (!db.prepare('SELECT id FROM articles WHERE id=?').get(id)) return fail(res, 404, 'not_found');
    const ids = req.body.observation_ids || [];
    if (!Array.isArray(ids)) return fail(res, 400, 'observation_ids_array');
    const ins = db.prepare('INSERT OR IGNORE INTO article_observations(article_id,observation_id) VALUES(?,?)');
    const tx = db.transaction(() => { for (const oid of ids) ins.run(id, +oid); });
    tx();
    res.json({ ok: true, notice: '文章仅引用你显式选择的原始观察；经验不会自动推广为其他植物的养护指令。' });
  });

  return r;
}
