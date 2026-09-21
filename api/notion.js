const NOTION_VERSION = "2025-09-03";
const TOKEN = process.env.NOTION_TOKEN;

const DS = {
  projects: "ce8fb3ab-4a31-40dc-b253-ce254e3c86bc",
  tasks: "ab7c911f-d8a0-44df-bc0a-678e03d4d349",
  ideas: "78ed69fe-9f4b-4b23-8e6a-6ace0243bba1",
  finance: "142a4e13-03b2-43cd-88f7-3f52b9407900",
  goal: "e382d350-dd30-44f5-bc38-f53194cc78be",
  scripts: "97306283-80bc-4144-8c71-fe01de9ac38e",
};

async function notion(path, opts = {}) {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Notion ${res.status}: ${t}`);
  }
  return res.json();
}

function titleText(prop) { return (prop && prop.title || []).map(t => t.plain_text).join(''); }
function textText(prop) { return (prop && prop.rich_text || []).map(t => t.plain_text).join(''); }
function selectName(prop) { return (prop && prop.select && prop.select.name) || null; }
function dateStart(prop) { return (prop && prop.date && prop.date.start) || null; }
function numberVal(prop) { return typeof (prop && prop.number) === 'number' ? prop.number : 0; }
function relationIds(prop) { return (prop && prop.relation || []).map(r => r.id); }
function checkboxVal(prop) { return !!(prop && prop.checkbox); }

async function queryAll(dsId, body = {}) {
  let results = [], cursor;
  do {
    const page = await notion(`data_sources/${dsId}/query`, {
      method: 'POST',
      body: JSON.stringify(Object.assign({ page_size: 100 }, body, cursor ? { start_cursor: cursor } : {})),
    });
    results = results.concat(page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return results;
}

module.exports = async (req, res) => {
  try {
    if (!TOKEN) { res.status(500).json({ error: "NOTION_TOKEN fehlt (Vercel Umgebungsvariable setzen)" }); return; }

    if (req.method === 'GET') {
      const [projPages, taskPages, ideaPages, finPages, goalPages, scriptPages] = await Promise.all([
        queryAll(DS.projects),
        queryAll(DS.tasks),
        queryAll(DS.ideas),
        queryAll(DS.finance),
        queryAll(DS.goal),
        queryAll(DS.scripts),
      ]);

      const projects = projPages.map(p => ({
        id: p.id,
        name: titleText(p.properties['Name']),
        next: textText(p.properties['Nächster Schritt']),
        status: selectName(p.properties['Status']) || 'Aktiv',
        tier: selectName(p.properties['Tier']),
      }));

      const tasks = taskPages
        .map(p => {
          const relIds = relationIds(p.properties['Projekt']);
          return {
            id: p.id,
            title: titleText(p.properties['Titel']),
            date: dateStart(p.properties['Deadline']),
            prio: selectName(p.properties['Priorität']) || 'Mittel',
            zeit: selectName(p.properties['Zeitaufwand']) || '—',
            proj: relIds[0] || null,
            done: selectName(p.properties['Status']) === 'Erledigt',
          };
        })
        .filter(t => t.date && t.title);

      const ideas = ideaPages.map(p => ({
        id: p.id,
        text: titleText(p.properties['Idee']),
        cat: selectName(p.properties['Kategorie']) || 'Business',
        date: (p.properties['Datum'] && p.properties['Datum'].created_time) || p.created_time || null,
      })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));

      const finance = finPages.map(p => ({
        id: p.id,
        title: titleText(p.properties['Titel']),
        typ: selectName(p.properties['Typ']) || 'Ausgabe',
        betrag: numberVal(p.properties['Betrag']),
        date: dateStart(p.properties['Datum']),
      })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));

      const goalPage = goalPages[0];
      const goal = goalPage ? {
        id: goalPage.id,
        name: titleText(goalPage.properties['Sparziel']),
        target: numberVal(goalPage.properties['Zielbetrag']),
        current: numberVal(goalPage.properties['Aktuell gespart']),
      } : null;

      const scripts = scriptPages
        .filter(p => !checkboxVal(p.properties['Gedreht']))
        .map(p => ({
          id: p.id,
          text: titleText(p.properties['Titel']),
          cat: selectName(p.properties['Säule']) || 'Sonstiges',
          herkunft: selectName(p.properties['Herkunft']),
          hook: textText(p.properties['Hook']),
        }));

      res.status(200).json({ projects, tasks, ideas, finance, goal, scripts });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const { action } = body;

      if (action === 'toggleTask') {
        await notion(`pages/${body.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ properties: { 'Status': { select: { name: body.done ? 'Erledigt' : 'Geplant' } } } }),
        });
        res.status(200).json({ ok: true }); return;
      }

      if (action === 'createTask') {
        const props = {
          'Titel': { title: [{ text: { content: body.title } }] },
          'Priorität': { select: { name: body.prio || 'Mittel' } },
          'Deadline': { date: { start: body.date } },
        };
        if (body.zeit && body.zeit !== '—') props['Zeitaufwand'] = { select: { name: body.zeit } };
        if (body.proj) props['Projekt'] = { relation: [{ id: body.proj }] };
        const page = await notion(`pages`, {
          method: 'POST',
          body: JSON.stringify({ parent: { type: 'data_source_id', data_source_id: DS.tasks }, properties: props }),
        });
        res.status(200).json({ ok: true, id: page.id }); return;
      }

      if (action === 'deleteTask') {
        await notion(`pages/${body.id}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
        res.status(200).json({ ok: true }); return;
      }

      if (action === 'createIdea') {
        const page = await notion(`pages`, {
          method: 'POST',
          body: JSON.stringify({
            parent: { type: 'data_source_id', data_source_id: DS.ideas },
            properties: {
              'Idee': { title: [{ text: { content: body.text } }] },
              'Kategorie': { select: { name: body.cat } },
              'Status': { select: { name: 'Neu' } },
            },
          }),
        });
        res.status(200).json({ ok: true, id: page.id }); return;
      }

      if (action === 'deleteIdea') {
        await notion(`pages/${body.id}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
        res.status(200).json({ ok: true }); return;
      }

      if (action === 'createFinance') {
        const page = await notion(`pages`, {
          method: 'POST',
          body: JSON.stringify({
            parent: { type: 'data_source_id', data_source_id: DS.finance },
            properties: {
              'Titel': { title: [{ text: { content: body.title } }] },
              'Typ': { select: { name: body.typ } },
              'Betrag': { number: body.betrag },
              'Datum': { date: { start: body.date } },
            },
          }),
        });
        if (body.typ === 'Sparen' && body.goalId) {
          const g = await notion(`pages/${body.goalId}`);
          const cur = numberVal(g.properties['Aktuell gespart']);
          await notion(`pages/${body.goalId}`, {
            method: 'PATCH',
            body: JSON.stringify({ properties: { 'Aktuell gespart': { number: cur + body.betrag } } }),
          });
        }
        res.status(200).json({ ok: true, id: page.id }); return;
      }

      if (action === 'createScript') {
        const page = await notion(`pages`, {
          method: 'POST',
          body: JSON.stringify({
            parent: { type: 'data_source_id', data_source_id: DS.scripts },
            properties: {
              'Titel': { title: [{ text: { content: body.text } }] },
              'Säule': { select: { name: body.cat } },
            },
          }),
        });
        res.status(200).json({ ok: true, id: page.id }); return;
      }

      if (action === 'completeScript') {
        await notion(`pages/${body.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ properties: { 'Gedreht': { checkbox: true } } }),
        });
        res.status(200).json({ ok: true }); return;
      }

      if (action === 'deleteScript') {
        await notion(`pages/${body.id}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
        res.status(200).json({ ok: true }); return;
      }

      res.status(400).json({ error: 'unknown action' }); return;
    }

    res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
