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

function stripLeadingEmoji(t) {
  return t.replace(/^\S+\s?/, (m) => (/^\p{Extended_Pictographic}/u.test(m) ? '' : m));
}

function listSection(title, items) {
  if (!items || items.length === 0) return '';
  const lis = items
    .map((t) => `<li>${esc(stripLeadingEmoji(t))}</li>`)
    .join('\n        ');
  return `
    <section class="section">
      <h2>${esc(title)}</h2>
      <ul class="plain-list">
        ${lis}
      </ul>
    </section>`;
}

function renderHTML(d) {
  const name = d.personLine
    ? esc(stripLeadingEmoji(d.personLine))
    : '포트폴리오';
  // "김현영(화학 교사)" -> 이름과 역할 분리
  const match = name.match(/^([^(]+)\(([^)]+)\)\s*$/);
  const displayName = match ? match[1].trim() : name;
  const role = match ? match[2].trim() : '';

  const toolsHTML = d.tools.length
    ? `
    <section class="section">
      <h2>${esc('에듀테크 연구')}</h2>
      <p class="tools-line">
        ${d.tools
          .map((t) =>
            t.url
              ? `<a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.name)}</a>`
              : `<span>${esc(t.name)}</span>`
          )
          .join('<span class="dot">·</span>')}
      </p>
    </section>`
    : '';

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(d.pageTitle)}</title>
<meta name="description" content="${esc(d.introText).slice(0, 140)}" />
<link rel="preconnect" href="https://cdn.jsdelivr.net" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css" />
<style>
  :root {
    --bg: #FAFAF7;
    --ink: #1B1B18;
    --sub: #8B8B83;
    --accent: #2F6F5E;
    --line: #E4E1D8;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    font-family: 'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg);
    color: var(--ink);
    line-height: 1.75;
    -webkit-font-smoothing: antialiased;
  }
  main {
    max-width: 640px;
    margin: 0 auto;
    padding: 96px 28px 120px;
  }

  .hero {
    display: flex;
    align-items: center;
    gap: 24px;
    margin-bottom: 56px;
  }
  .avatar {
    width: 96px;
    height: 96px;
    border-radius: 14px;
    object-fit: cover;
    flex-shrink: 0;
    background: var(--line);
  }
  .hero h1 {
    margin: 0 0 6px;
    font-size: 32px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .hero .role {
    margin: 0 0 12px;
    font-size: 15px;
    color: var(--sub);
  }
  .contact-line {
    font-size: 14px;
    color: var(--sub);
  }
  .contact-line a {
    color: var(--sub);
    text-decoration: none;
    border-bottom: 1px solid var(--line);
  }
  .contact-line a:hover { color: var(--accent); border-color: var(--accent); }
  .contact-line .dot { margin: 0 10px; color: var(--line); }

  .intro {
    font-size: 17px;
    color: var(--ink);
    margin: 0 0 20px;
    padding-left: 16px;
    border-left: 2px solid var(--accent);
  }
  .values {
    font-size: 14px;
    color: var(--sub);
    margin: 0 0 64px;
    padding-left: 16px;
  }

  .section {
    padding-top: 40px;
    margin-top: 40px;
    border-top: 1px solid var(--line);
  }
  .section:first-of-type { border-top: none; margin-top: 0; padding-top: 0; }
  .section h2 {
    font-size: 13px;
    font-weight: 600;
    color: var(--accent);
    margin: 0 0 18px;
    letter-spacing: 0.02em;
  }
  .plain-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .plain-list li {
    font-size: 15px;
    color: var(--ink);
    padding-bottom: 10px;
    border-bottom: 1px solid var(--line);
  }
  .plain-list li:last-child { border-bottom: none; padding-bottom: 0; }

  .tools-line {
    font-size: 15px;
    line-height: 2.1;
    margin: 0;
  }
  .tools-line a {
    color: var(--ink);
    text-decoration: none;
    border-bottom: 1px solid var(--line);
  }
  .tools-line a:hover { color: var(--accent); border-color: var(--accent); }
  .tools-line span:not(.dot) { color: var(--sub); }
  .tools-line .dot { margin: 0 10px; color: var(--line); }

  footer {
    max-width: 640px;
    margin: 0 auto;
    padding: 0 28px 60px;
    font-size: 12px;
    color: var(--sub);
  }

  @media (max-width: 480px) {
    main { padding: 64px 20px 90px; }
    .hero { gap: 16px; margin-bottom: 44px; }
    .avatar { width: 76px; height: 76px; border-radius: 12px; }
    .hero h1 { font-size: 26px; }
  }
</style>
</head>
<body>
  <main>
    <div class="hero">
      ${d.profileImagePath ? `<img class="avatar" src="${esc(d.profileImagePath)}" alt="profile" />` : ''}
      <div>
        <h1>${displayName}</h1>
        ${role ? `<p class="role">${esc(role)}</p>` : ''}
        <p class="contact-line">
          ${d.emailLine ? `<a href="mailto:${esc(d.emailLine)}">${esc(d.emailLine)}</a>` : ''}
          ${d.emailLine && d.blogUrl ? `<span class="dot">·</span>` : ''}
          ${d.blogUrl ? `<a href="${esc(d.blogUrl)}" target="_blank" rel="noopener">${esc(d.blogLabel || '블로그')}</a>` : ''}
        </p>
      </div>
    </div>

    ${d.introText ? `<p class="intro">${esc(d.introText)}</p>` : ''}
    ${d.valuesText ? `<p class="values">${esc(d.valuesText)}</p>` : ''}

    ${listSection(d.sectionTitles.award, d.sections.award)}
    ${listSection(d.sectionTitles.leader, d.sections.leader)}
    ${listSection(d.sectionTitles.community, d.sections.community)}
    ${listSection(d.sectionTitles.lecture, d.sections.lecture)}
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
