// scripts/build.mjs
// 노션 페이지 + 데이터베이스를 읽어 index.html을 생성합니다.
import fs from 'node:fs/promises';
import path from 'node:path';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const PAGE_ID = process.env.NOTION_PAGE_ID;
const NOTION_VERSION = '2022-06-28';

if (!NOTION_TOKEN || !PAGE_ID) {
  console.error('NOTION_TOKEN 또는 NOTION_PAGE_ID 환경변수가 없습니다.');
  process.exit(1);
}

async function notionGet(pathname) {
  const res = await fetch(`https://api.notion.com/v1${pathname}`, {
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
    },
  });
  if (!res.ok) {
    throw new Error(`Notion API GET ${pathname} 실패 (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function notionPost(pathname, body) {
  const res = await fetch(`https://api.notion.com/v1${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    throw new Error(`Notion API POST ${pathname} 실패 (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function getAllBlocks(blockId) {
  let blocks = [];
  let cursor;
  do {
    const qs = cursor
      ? `?start_cursor=${encodeURIComponent(cursor)}&page_size=100`
      : '?page_size=100';
    const data = await notionGet(`/blocks/${blockId}/children${qs}`);
    blocks = blocks.concat(data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  for (const block of blocks) {
    if (block.has_children && block.type !== 'child_database') {
      block._children = await getAllBlocks(block.id);
    }
  }
  return blocks;
}

function richTextToPlain(rt) {
  if (!rt) return '';
  return rt.map((t) => t.plain_text).join('');
}

function richTextHref(rt) {
  if (!rt) return null;
  for (const t of rt) {
    if (t.href) return t.href;
  }
  return null;
}

function flatten(blocks, out = []) {
  for (const b of blocks) {
    out.push(b);
    if (b._children) flatten(b._children, out);
  }
  return out;
}

function getBlockText(b) {
  const data = b[b.type];
  return data && data.rich_text ? richTextToPlain(data.rich_text) : '';
}

function esc(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function downloadImage(url, destDir, filenameBase) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`이미지 다운로드 실패: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  let ext = 'jpg';
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('png')) ext = 'png';
  else if (ct.includes('webp')) ext = 'webp';
  else if (ct.includes('gif')) ext = 'gif';
  await fs.mkdir(destDir, { recursive: true });
  const filename = `${filenameBase}.${ext}`;
  await fs.writeFile(path.join(destDir, filename), buf);
  return `${destDir}/${filename}`;
}

async function main() {
  console.log('노션 데이터를 가져오는 중...');
  const page = await notionGet(`/pages/${PAGE_ID}`);
  const titleProp = Object.values(page.properties || {}).find((p) => p.type === 'title');
  const pageTitle = titleProp ? richTextToPlain(titleProp.title) : '포트폴리오';
  const pageIcon = page.icon && page.icon.type === 'emoji' ? page.icon.emoji : '';
  const coverExternal = page.cover && page.cover.type === 'external' ? page.cover.external.url : null;
  const coverFile = page.cover && page.cover.type === 'file' ? page.cover.file.url : null;

  let coverPath = null;
  const coverUrl = coverExternal || coverFile;
  if (coverUrl) {
    try {
      coverPath = await downloadImage(coverUrl, 'assets', 'cover');
    } catch (e) {
      console.error('커버 이미지 다운로드 실패:', e.message);
    }
  }

  const rootBlocks = await getAllBlocks(PAGE_ID);
  const flat = flatten(rootBlocks);

  let profileImagePath = null;
  let personLine = '';
  let emailLine = '';
  let blogLabel = '';
  let blogUrl = '';
  let introText = '';
  let valuesText = '';
  let databaseBlockId = null;

  const sections = { award: [], leader: [], community: [], lecture: [] };
  const sectionTitles = { award: '수상', leader: '선도교사', community: '연구회', lecture: '강의 이력' };
  let currentSection = null;

  for (const b of flat) {
    const type = b.type;

    if (type === 'image') {
      if (!profileImagePath) {
        const img = b.image;
        const url = img.type === 'external' ? img.external.url : img.file.url;
        try {
          profileImagePath = await downloadImage(url, 'assets', 'profile');
        } catch (e) {
          console.error('프로필 이미지 다운로드 실패:', e.message);
        }
      }
      continue;
    }

    if (type === 'callout') {
      introText = getBlockText(b);
      continue;
    }

    if (type === 'quote') {
      valuesText = getBlockText(b);
      continue;
    }

    if (type === 'heading_1' || type === 'heading_2' || type === 'heading_3') {
      const t = getBlockText(b);
      if (t.includes('수상')) currentSection = 'award';
      else if (t.includes('선도교사')) currentSection = 'leader';
      else if (t.includes('연구회')) currentSection = 'community';
      else if (t.includes('강의') || t.includes('이력')) currentSection = 'lecture';
      else if (t.includes('에듀테크')) currentSection = 'tools';
      else currentSection = null;
      continue;
    }

    if (type === 'child_database') {
      databaseBlockId = b.id;
      continue;
    }

    if (['paragraph', 'bulleted_list_item', 'numbered_list_item', 'to_do'].includes(type)) {
      const t = getBlockText(b).trim();
      if (!t) continue;

      if (t.startsWith('🏫')) {
        // 학교명은 표시하지 않음 (요청 사항)
        continue;
      }
      if (t.startsWith('🙋') && !currentSection) {
        personLine = t;
        continue;
      }
      if (t.startsWith('✉️') || t.startsWith('✉')) {
        emailLine = t.replace(/^✉️?/, '').trim();
        continue;
      }
      if (t.startsWith('📎')) {
        blogLabel = t.replace('📎', '').trim();
        const href = richTextHref(b[type] && b[type].rich_text);
        if (href) blogUrl = href;
        continue;
      }
      if (!blogUrl && /^https?:\/\//.test(t) && blogLabel) {
        blogUrl = t;
        continue;
      }
      if (currentSection && sections[currentSection]) {
        sections[currentSection].push(t);
      }
      continue;
    }
  }

  let tools = [];
  if (databaseBlockId) {
    try {
      const query = await notionPost(`/databases/${databaseBlockId}/query`, {});
      for (const row of query.results) {
        const props = row.properties;
        let name = '';
        let url = '';
        for (const val of Object.values(props)) {
          if (val.type === 'title') name = richTextToPlain(val.title);
          if (val.type === 'url' && val.url) url = val.url;
        }
        if (name) tools.push({ name, url });
      }
    } catch (e) {
      console.error('에듀테크 도구 데이터베이스 조회 실패:', e.message);
    }
  }

  const html = renderHTML({
    pageTitle,
    pageIcon,
    coverPath,
    profileImagePath,
    personLine,
    emailLine,
    blogLabel,
    blogUrl,
    introText,
    valuesText,
    sections,
    sectionTitles,
    tools,
  });

  await fs.writeFile('index.html', html, 'utf-8');
  console.log('index.html 생성 완료!');
}

function listBlock(title, icon, items) {
  if (!items || items.length === 0) return '';
  const lis = items
    .map((t) => `<li>${esc(t.replace(/^\S+\s?/, (m) => (/^\p{Extended_Pictographic}/u.test(m) ? '' : m)))}</li>`)
    .join('\n            ');
  return `
      <section class="card">
        <h2><span class="icon">${icon}</span>${esc(title)}</h2>
        <ul class="list">
            ${lis}
        </ul>
      </section>`;
}

function renderHTML(d) {
  const name = d.personLine
    ? esc(d.personLine.replace(/^🙋[^\s]*\s?/, ''))
    : '포트폴리오';

  const toolsHTML = d.tools.length
    ? `
      <section class="card">
        <h2><span class="icon">💻</span>에듀테크 연구</h2>
        <div class="tools-grid">
          ${d.tools
            .map(
              (t) => `
          <a class="tool-chip" href="${t.url ? esc(t.url) : '#'}" target="_blank" rel="noopener">
            ${esc(t.name)}
          </a>`
            )
            .join('')}
        </div>
      </section>`
    : '';

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(d.pageTitle)}</title>
<link rel="preconnect" href="https://cdn.jsdelivr.net" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css" />
<style>
  :root {
    --bg: #FBF9F6;
    --card: #FFFFFF;
    --ink: #2B2622;
    --sub: #746B62;
    --accent: #E4785C;
    --accent-soft: #FCE7DF;
    --teal: #3E7C74;
    --teal-soft: #E2F0ED;
    --line: #EEE7DE;
    --radius: 20px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: 'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg);
    color: var(--ink);
    line-height: 1.7;
  }
  .hero {
    position: relative;
    padding: 0 0 60px;
  }
  .cover {
    width: 100%;
    height: 220px;
    object-fit: cover;
    background: linear-gradient(135deg, var(--teal-soft), var(--accent-soft));
  }
  .hero-inner {
    max-width: 880px;
    margin: -70px auto 0;
    padding: 0 24px;
    display: flex;
    gap: 28px;
    align-items: flex-end;
    flex-wrap: wrap;
  }
  .avatar {
    width: 140px;
    height: 140px;
    border-radius: 50%;
    object-fit: cover;
    border: 6px solid var(--bg);
    background: var(--card);
    box-shadow: 0 8px 24px rgba(0,0,0,0.08);
  }
  .hero-text { padding-bottom: 8px; }
  .hero-text h1 {
    margin: 0 0 6px;
    font-size: 30px;
    font-weight: 800;
  }
  .hero-text .icon-badge { font-size: 26px; margin-right: 6px; }
  .contact-row {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    margin-top: 10px;
  }
  .contact-row a, .contact-row span {
    font-size: 14px;
    color: var(--sub);
    text-decoration: none;
    background: var(--card);
    padding: 6px 14px;
    border-radius: 999px;
    border: 1px solid var(--line);
  }
  .contact-row a:hover { border-color: var(--accent); color: var(--accent); }

  main {
    max-width: 880px;
    margin: 0 auto;
    padding: 0 24px 80px;
    display: flex;
    flex-direction: column;
    gap: 24px;
  }
  .intro-callout {
    background: var(--teal-soft);
    color: var(--teal);
    border-radius: var(--radius);
    padding: 22px 26px;
    font-size: 16px;
    font-weight: 500;
  }
  .quote-box {
    border-left: 4px solid var(--accent);
    background: var(--accent-soft);
    border-radius: 0 var(--radius) var(--radius) 0;
    padding: 18px 24px;
    font-size: 15px;
    color: #8A4A34;
    font-weight: 600;
  }
  .card {
    background: var(--card);
    border-radius: var(--radius);
    padding: 28px 30px;
    border: 1px solid var(--line);
  }
  .card h2 {
    margin: 0 0 16px;
    font-size: 18px;
    font-weight: 700;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .card h2 .icon { font-size: 20px; }
  .list {
    margin: 0;
    padding-left: 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 14.5px;
    color: var(--ink);
  }
  .list li { padding-left: 2px; }
  .tools-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  .tool-chip {
    background: var(--teal-soft);
    color: var(--teal);
    padding: 8px 16px;
    border-radius: 999px;
    font-size: 14px;
    font-weight: 600;
    text-decoration: none;
  }
  .tool-chip:hover { background: var(--teal); color: #fff; }
  footer {
    text-align: center;
    padding: 30px 0 50px;
    font-size: 13px;
    color: var(--sub);
  }
  @media (max-width: 520px) {
    .hero-inner { flex-direction: column; align-items: flex-start; }
    .avatar { width: 110px; height: 110px; }
    .hero-text h1 { font-size: 24px; }
  }
</style>
</head>
<body>
  <div class="hero">
    ${d.coverPath ? `<img class="cover" src="${esc(d.coverPath)}" alt="cover" />` : `<div class="cover"></div>`}
    <div class="hero-inner">
      ${d.profileImagePath ? `<img class="avatar" src="${esc(d.profileImagePath)}" alt="profile" />` : ''}
      <div class="hero-text">
        <h1><span class="icon-badge">${esc(d.pageIcon)}</span>${name}</h1>
        <div class="contact-row">
          ${d.emailLine ? `<a href="mailto:${esc(d.emailLine)}">✉️ ${esc(d.emailLine)}</a>` : ''}
          ${d.blogUrl ? `<a href="${esc(d.blogUrl)}" target="_blank" rel="noopener">📎 ${esc(d.blogLabel || '블로그')}</a>` : ''}
        </div>
      </div>
    </div>
  </div>

  <main>
    ${d.introText ? `<div class="intro-callout">💡 ${esc(d.introText)}</div>` : ''}
    ${d.valuesText ? `<div class="quote-box">${esc(d.valuesText)}</div>` : ''}

    ${listBlock(d.sectionTitles.award, '🏆', d.sections.award)}
    ${listBlock(d.sectionTitles.leader, '🙋🏻\u200d♀️', d.sections.leader)}
    ${listBlock(d.sectionTitles.community, '📒', d.sections.community)}
    ${listBlock(d.sectionTitles.lecture, '🎤', d.sections.lecture)}
    ${toolsHTML}
  </main>

  <footer>이 페이지는 Notion 데이터를 바탕으로 자동 생성되었습니다.</footer>
</body>
</html>
`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
