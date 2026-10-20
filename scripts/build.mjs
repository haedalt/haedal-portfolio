// scripts/build.mjs
// 노션 페이지를 읽어 index.html의 정해진 영역만 갱신합니다. 디자인은 그대로 둡니다.
//
// index.html 안의 표시(주석) 사이만 바뀝니다:
//   AWARDS(수상) · LEADERS(선도교사) · GROUPS(연구회) · PARTNERS(파트너 활동)
//   FILTERS + LECTURES(강의 이력) · TOOLS(에듀테크 연구)
//
// 노션 작성 규칙 (제목에 아래 단어가 들어가면 그 섹션으로 읽습니다. 한 줄에 하나씩):
//   수상      →  경기도 교육청 수업혁신사례연구대회 1등급(2026)
//   선도교사  →  수원 디지털 창의역량 지원단(2025)          (연도 생략 가능)
//   연구회    →  고양 에듀테크 연구회(2022-2024)            (아이콘은 자동)
//   파트너    →  2026 왓퀴즈AI 앰버서더 2기                 (연도 생략 가능)
//   강의      →  2026 곡정고 AI 서·논술형 평가 연수         (연도 학교 내용)
//   에듀테크  →  제목 아래의 데이터베이스(이름 + URL 칸)
//
// 안전장치: 어떤 섹션을 노션에서 찾지 못하거나 한 줄도 읽지 못하면 그 섹션은 그대로 둡니다.
import fs from 'node:fs/promises';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const PAGE_ID = process.env.NOTION_PAGE_ID;
const NOTION_VERSION = '2022-06-28';
const HTML_FILE = 'index.html';

if (!NOTION_TOKEN || !PAGE_ID) {
  console.error('NOTION_TOKEN 또는 NOTION_PAGE_ID 환경변수가 없습니다. 저장소 Settings → Secrets에서 확인하세요.');
  process.exit(1);
}

// ---------------- 노션 API ----------------
async function notionRequest(method, pathname, body) {
  const res = await fetch(`https://api.notion.com/v1${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    throw new Error(`Notion API ${method} ${pathname} 실패 (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function getAllBlocks(blockId) {
  let blocks = [];
  let cursor;
  do {
    const qs = cursor ? `?start_cursor=${encodeURIComponent(cursor)}&page_size=100` : '?page_size=100';
    const data = await notionRequest('GET', `/blocks/${blockId}/children${qs}`);
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

async function queryDatabase(dbId) {
  let rows = [];
  let cursor;
  do {
    const data = await notionRequest('POST', `/databases/${dbId}/query`, cursor ? { start_cursor: cursor } : {});
    rows = rows.concat(data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return rows;
}

// ---------------- 공통 도구 ----------------
function flatten(blocks, out = []) {
  for (const b of blocks) {
    out.push(b);
    if (b._children) flatten(b._children, out);
  }
  return out;
}

const plain = (rt) => (rt || []).map((t) => t.plain_text).join('');

function getBlockText(b) {
  const data = b[b.type];
  return data && data.rich_text ? plain(data.rich_text) : '';
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 줄 앞의 꾸밈 기호(✅, •, -, 이모지 등)를 떼어 냅니다.
const LEADING_MARKS = /^(?:[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D\u20E3•·\-–*]\s*)+/u;
const clean = (t) => t.replace(/\s+/g, ' ').trim().replace(LEADING_MARKS, '').trim();

// "내용(2025)" / "내용(2022-2024)" / "2025 내용" → { text, period }
function splitPeriod(line) {
  let m = line.match(/^(.*?)\s*\(\s*(\d{4})\s*(?:[-–~]\s*(\d{4})?\s*)?\)\s*$/);
  if (m && m[1]) {
    const hasRange = /[-–~]/.test(line.slice(line.lastIndexOf('(')));
    const period = hasRange ? `${m[2]}–${m[3] || ''}` : m[2];
    return { text: m[1].trim(), period };
  }
  m = line.match(/^(\d{4})\s*년?\s+(.+)$/);
  if (m) return { text: m[2].trim(), period: m[1] };
  return { text: line, period: '' };
}

// ---------------- 섹션 판별 ----------------
function sectionOf(heading) {
  if (heading.includes('파트너')) return 'partners';
  if (heading.includes('강의')) return 'lectures';
  if (heading.includes('수상')) return 'awards';
  if (heading.includes('선도')) return 'leaders';
  if (heading.includes('연구회')) return 'groups';
  if (heading.includes('에듀테크')) return 'tools';
  return null;
}

function collectSections(flat) {
  const lines = { awards: [], leaders: [], groups: [], partners: [], lectures: [] };
  const databases = { tools: [], any: [] };
  let current = null;
  for (const b of flat) {
    if (b.type === 'heading_1' || b.type === 'heading_2' || b.type === 'heading_3') {
      current = sectionOf(getBlockText(b));
      continue;
    }
    if (b.type === 'child_database') {
      databases.any.push(b.id);
      if (current === 'tools') databases.tools.push(b.id);
      continue;
    }
    if (!current || !lines[current]) continue;
    if (['paragraph', 'bulleted_list_item', 'numbered_list_item', 'to_do'].includes(b.type)) {
      const t = clean(getBlockText(b));
      if (t) lines[current].push(t);
    }
  }
  return { lines, databases };
}

// ---------------- 섹션별 HTML ----------------
const AWARD_INDENT = '        ';
function renderAwards(lines) {
  return lines.map((line) => {
    const { text, period } = splitPeriod(line);
    return [
      `${AWARD_INDENT}<article class="award">`,
      `${AWARD_INDENT}  <span class="medal">🥇</span>`,
      `${AWARD_INDENT}  <div class="aw-body">`,
      ...(period ? [`${AWARD_INDENT}    <div class="yr">${esc(period)}</div>`] : []),
      `${AWARD_INDENT}    <div class="txt">${esc(text)}</div>`,
      `${AWARD_INDENT}  </div>`,
      `${AWARD_INDENT}</article>`,
    ].join('\n');
  });
}

function renderLeaders(lines) {
  return lines.map((line) => {
    const { text, period } = splitPeriod(line);
    return `            <span class="chip"><span class="b"></span>${esc(text)}${period ? ` <span class="yy">${esc(period)}</span>` : ''}</span>`;
  });
}

// 연구회 아이콘 자동 선택: 이름에 들어간 단어로 고르고, 없으면 돌아가며 씁니다.
const GROUP_ICON_RULES = [
  [/AI|인공지능/i, '🤖'],
  [/하이러닝/, '💡'],
  [/성장/, '🌱'],
  [/수업|탐구/, '🔬'],
  [/과학|실험|화학/, '🧪'],
  [/독서|책/, '📚'],
  [/에듀테크|디지털/, '🌊'],
];
const GROUP_ICON_FALLBACK = ['📘', '🧩', '🌏', '✨'];
function groupIcon(name, i) {
  for (const [re, icon] of GROUP_ICON_RULES) if (re.test(name)) return icon;
  return GROUP_ICON_FALLBACK[i % GROUP_ICON_FALLBACK.length];
}
function renderGroups(lines) {
  return lines.map((line, i) => {
    const { text, period } = splitPeriod(line);
    return `            <div class="group"><span class="ico">${groupIcon(text, i)}</span><span class="t">${esc(text)}</span>${period ? `<span class="yy">${esc(period)}</span>` : ''}</div>`;
  });
}

function renderPartners(lines) {
  return lines.map((line) => {
    const m = line.match(/^(?:(\d{4})\s*년?\s+)?(\S+)(?:\s+(.+))?$/);
    const year = m[1] || '';
    const name = m[2];
    const role = m[3] || '';
    return (
      `        <article class="partner"><div class="pt-top"><span class="pt-name">${esc(name)}</span>` +
      (year ? `<span class="pt-yr">${esc(year)}</span>` : '') +
      `</div>` +
      (role ? `<span class="pt-role">${esc(role)}</span>` : '') +
      `</article>`
    );
  });
}

function parseLectures(lines) {
  const out = [];
  for (const line of lines) {
    const m = line.match(/^(\d{4})\s*년?\s+(\S+)\s+(.+)$/);
    if (m) out.push({ year: m[1], place: m[2], desc: m[3] });
    else console.warn(`⚠️ [강의] 형식이 맞지 않아 건너뜀: "${line}" (예: 2026 곡정고 AI 서·논술형 평가 연수)`);
  }
  return out;
}

async function readTools(databases) {
  const ids = databases.tools.length ? databases.tools : databases.any.length === 1 ? databases.any : [];
  if (!ids.length) return [];
  const tools = [];
  for (const id of ids) {
    const rows = await queryDatabase(id);
    for (const row of rows) {
      let name = '';
      let url = '';
      for (const val of Object.values(row.properties || {})) {
        if (val.type === 'title') name = plain(val.title).trim();
        if (val.type === 'url' && val.url) url = val.url.trim();
      }
      if (!name) continue;
      if (url && /^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:\/\//i.test(url)) url = ''; // http(s) 외의 주소는 버림
      if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
      if (url && !/^https?:\/\/[^\s"'<>]+$/i.test(url)) url = '';
      tools.push({ name, url });
    }
  }
  return tools;
}

const jsString = (s) => JSON.stringify(s).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
function renderTools(tools) {
  return tools.map((t) => `    {name:${jsString(t.name)},url:${jsString(t.url)}},`);
}

// ---------------- index.html 바꾸기 ----------------
function replaceBetween(html, name, inner) {
  const re = new RegExp(
    `((?:<!--|/\\*) NOTION:${name}:START[^\\n]*\\n)[\\s\\S]*?(\\n[ \\t]*(?:<!--|/\\*) NOTION:${name}:END)`
  );
  if (!re.test(html)) throw new Error(`index.html에서 NOTION:${name} 표시를 찾지 못했습니다. 표시 주석을 지우지 않았는지 확인하세요.`);
  return html.replace(re, (_, start, end) => start + inner + end);
}

async function main() {
  console.log('노션에서 내용을 가져오는 중...');
  const flat = flatten(await getAllBlocks(PAGE_ID));
  const { lines, databases } = collectSections(flat);

  let html = await fs.readFile(HTML_FILE, 'utf-8');
  const before = html;
  const report = [];

  function apply(label, markers, items) {
    if (!items.length) {
      console.warn(`⚠️ [${label}] 노션에서 내용을 찾지 못해 사이트의 기존 내용을 그대로 둡니다.`);
      return;
    }
    for (const [name, inner] of markers) html = replaceBetween(html, name, inner);
    report.push(`${label} ${items.length}건`);
  }

  const awards = renderAwards(lines.awards);
  apply('수상', [['AWARDS', awards.join('\n')]], awards);

  const leaders = renderLeaders(lines.leaders);
  apply('선도교사', [['LEADERS', leaders.join('\n')]], leaders);

  const groups = renderGroups(lines.groups);
  apply('연구회', [['GROUPS', groups.join('\n')]], groups);

  const partners = renderPartners(lines.partners);
  apply('파트너 활동', [['PARTNERS', partners.join('\n')]], partners);

  const lectures = parseLectures(lines.lectures);
  const years = [...new Set(lectures.map((l) => l.year))].sort();
  apply(
    '강의 이력',
    [
      [
        'FILTERS',
        [
          '        <button class="filt" data-y="all" aria-pressed="true">전체</button>',
          ...years.map((y) => `        <button class="filt" data-y="${esc(y)}" aria-pressed="false">${esc(y)}</button>`),
        ].join('\n'),
      ],
      [
        'LECTURES',
        lectures
          .map(
            (l) =>
              `        <div class="tl" data-y="${esc(l.year)}"><div class="yr">${esc(l.year)}</div><div class="place">${esc(l.place)}</div><div class="desc">${esc(l.desc)}</div></div>`
          )
          .join('\n'),
      ],
    ],
    lectures
  );

  let tools = [];
  try {
    tools = await readTools(databases);
  } catch (e) {
    console.warn(`⚠️ [에듀테크 연구] 데이터베이스를 읽지 못했습니다: ${e.message}`);
  }
  apply('에듀테크 연구', [['TOOLS', renderTools(tools).join('\n')]], tools);

  if (!report.length) {
    throw new Error('노션에서 어떤 섹션도 읽지 못했습니다. 노션 페이지 연결과 제목을 확인하세요. 사이트는 바꾸지 않았습니다.');
  }
  if (html === before) {
    console.log(`변경 사항 없음 (${report.join(', ')}).`);
    return;
  }
  await fs.writeFile(HTML_FILE, html, 'utf-8');
  console.log(`갱신 완료: ${report.join(', ')}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
