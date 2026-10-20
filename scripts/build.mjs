// scripts/build.mjs
// 노션 페이지의 "강의 이력"과 "파트너 활동" 목록을 읽어 index.html의 해당 부분만 갱신합니다.
// index.html의 디자인은 그대로 두고, 아래 표시 사이의 내용만 바꿉니다.
//   <!-- NOTION:FILTERS:START ... -->  ~  <!-- NOTION:FILTERS:END -->   (강의 연도 버튼)
//   <!-- NOTION:LECTURES:START ... --> ~  <!-- NOTION:LECTURES:END -->  (강의 타임라인)
//   <!-- NOTION:PARTNERS:START ... --> ~  <!-- NOTION:PARTNERS:END -->  (파트너 활동 카드)
//
// 노션 작성 규칙 (한 줄에 하나씩):
//   "강의"가 들어간 제목 아래   →  2026 곡정고 AI 서·논술형 평가 연수   (연도 학교 내용)
//   "파트너"가 들어간 제목 아래 →  2026 왓퀴즈AI 앰버서더 2기            (연도 회사 활동)
import fs from 'node:fs/promises';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const PAGE_ID = process.env.NOTION_PAGE_ID;
const NOTION_VERSION = '2022-06-28';
const HTML_FILE = 'index.html';

if (!NOTION_TOKEN || !PAGE_ID) {
  console.error('NOTION_TOKEN 또는 NOTION_PAGE_ID 환경변수가 없습니다. 저장소 Settings → Secrets에서 확인하세요.');
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

function flatten(blocks, out = []) {
  for (const b of blocks) {
    out.push(b);
    if (b._children) flatten(b._children, out);
  }
  return out;
}

function getBlockText(b) {
  const data = b[b.type];
  if (!data || !data.rich_text) return '';
  return data.rich_text.map((t) => t.plain_text).join('');
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 제목으로 어느 섹션인지 판단합니다.
function sectionOf(headingText) {
  if (headingText.includes('파트너')) return 'partners';
  if (headingText.includes('강의')) return 'lectures';
  return null;
}

// 노션에서 섹션별 줄을 골라냅니다. found에는 노션에 제목이 있었던 섹션이 담깁니다.
function collectSections(flat) {
  const lines = { lectures: [], partners: [] };
  const found = new Set();
  let current = null;
  for (const b of flat) {
    if (b.type === 'heading_1' || b.type === 'heading_2' || b.type === 'heading_3') {
      current = sectionOf(getBlockText(b));
      if (current) found.add(current);
      continue;
    }
    if (!current) continue;
    if (['paragraph', 'bulleted_list_item', 'numbered_list_item', 'to_do'].includes(b.type)) {
      const t = getBlockText(b).replace(/\s+/g, ' ').trim();
      if (t) lines[current].push(t);
    }
  }
  return { lines, found };
}

// "2026 곡정고 AI 서·논술형 평가 연수" → { year, place, desc }
function parseLecture(line) {
  const m = line.match(/^(\d{4})\s*년?\s+(\S+)\s+(.+)$/);
  if (!m) return null;
  return { year: m[1], place: m[2], desc: m[3] };
}

// "2026 왓퀴즈AI 앰버서더 2기" → { year, name, role }  (연도는 생략 가능)
function parsePartner(line) {
  const m = line.match(/^(?:(\d{4})\s*년?\s+)?(\S+)(?:\s+(.+))?$/);
  if (!m) return null;
  return { year: m[1] || '', name: m[2], role: m[3] || '' };
}

function parseAll(lines, parser, example) {
  const out = [];
  for (const line of lines) {
    const item = parser(line);
    if (item) out.push(item);
    else console.warn(`⚠️ 형식이 맞지 않아 건너뜀: "${line}" (예: ${example})`);
  }
  return out;
}

function replaceBetween(html, name, inner) {
  const re = new RegExp(`(<!-- NOTION:${name}:START[^>]*-->\\n)[\\s\\S]*?(\\s*<!-- NOTION:${name}:END -->)`);
  if (!re.test(html)) {
    throw new Error(`index.html에서 NOTION:${name} 표시를 찾지 못했습니다. 표시 주석을 지우지 않았는지 확인하세요.`);
  }
  return html.replace(re, (_, start, end) => start + inner + end);
}

async function main() {
  console.log('노션에서 강의 이력을 가져오는 중...');
  const flat = flatten(await getAllBlocks(PAGE_ID));
  const { lines, found } = collectSections(flat);

  // ---- 강의 이력 ----
  const lectures = parseAll(lines.lectures, parseLecture, '2026 곡정고 AI 서·논술형 평가 연수');
  // 안전장치: 하나도 못 읽었으면 사이트를 비우지 않고 멈춥니다.
  if (lectures.length === 0) {
    throw new Error('노션에서 강의 이력을 하나도 찾지 못했습니다. 제목에 "강의"가 있는지, 각 줄이 "연도 학교 내용" 형식인지 확인하세요. 사이트는 바꾸지 않았습니다.');
  }

  const years = [...new Set(lectures.map((l) => l.year))].sort();
  const filtersHtml = [
    '        <button class="filt" data-y="all" aria-pressed="true">전체</button>',
    ...years.map((y) => `        <button class="filt" data-y="${esc(y)}" aria-pressed="false">${esc(y)}</button>`),
  ].join('\n');
  const timelineHtml = lectures
    .map(
      (l) =>
        `        <div class="tl" data-y="${esc(l.year)}"><div class="yr">${esc(l.year)}</div><div class="place">${esc(l.place)}</div><div class="desc">${esc(l.desc)}</div></div>`
    )
    .join('\n');

  // ---- 파트너 활동 ----
  // 노션에 "파트너" 제목이 없으면 사이트의 파트너 영역은 건드리지 않습니다.
  let partnersHtml = null;
  if (found.has('partners')) {
    const partners = parseAll(lines.partners, parsePartner, '2026 왓퀴즈AI 앰버서더 2기');
    partnersHtml = partners.length
      ? partners
          .map(
            (p) =>
              `        <article class="partner"><div class="pt-top"><span class="pt-name">${esc(p.name)}</span>` +
              (p.year ? `<span class="pt-yr">${esc(p.year)}</span>` : '') +
              `</div>` +
              (p.role ? `<span class="pt-role">${esc(p.role)}</span>` : '') +
              `</article>`
          )
          .join('\n')
      : '        <p class="partners-empty">곧 새로운 소식으로 채워질 예정이에요.</p>';
  } else {
    console.warn('⚠️ 노션에서 "파트너" 제목을 찾지 못해 파트너 활동은 그대로 둡니다.');
  }

  let html = await fs.readFile(HTML_FILE, 'utf-8');
  const before = html;
  html = replaceBetween(html, 'FILTERS', filtersHtml);
  html = replaceBetween(html, 'LECTURES', timelineHtml);
  if (partnersHtml !== null) html = replaceBetween(html, 'PARTNERS', partnersHtml);

  if (html === before) {
    console.log(`변경 사항 없음 (강의 ${lectures.length}건).`);
    return;
  }
  await fs.writeFile(HTML_FILE, html, 'utf-8');
  console.log(`강의 이력 ${lectures.length}건${partnersHtml !== null ? ', 파트너 활동' : ''}으로 index.html을 갱신했습니다.`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
