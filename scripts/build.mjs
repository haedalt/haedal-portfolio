// scripts/build.mjs
// 노션 페이지의 "강의 이력" 목록을 읽어 index.html의 강의 타임라인만 갱신합니다.
// index.html의 디자인은 그대로 두고, 아래 표시 사이의 내용만 바꿉니다.
//   <!-- NOTION:FILTERS:START ... -->  ~  <!-- NOTION:FILTERS:END -->   (연도 버튼)
//   <!-- NOTION:LECTURES:START ... --> ~  <!-- NOTION:LECTURES:END -->  (타임라인)
//
// 노션 작성 규칙: "강의" 또는 "이력"이 들어간 제목 아래에 한 줄에 하나씩
//   2026 곡정고 AI 서·논술형 평가 연수
// 처럼 "연도 학교 내용" 순서로 적습니다.
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

// 노션에서 강의 이력 줄들만 골라냅니다.
function collectLectureLines(flat) {
  const lines = [];
  let inLecture = false;
  for (const b of flat) {
    if (b.type === 'heading_1' || b.type === 'heading_2' || b.type === 'heading_3') {
      const t = getBlockText(b);
      inLecture = t.includes('강의') || t.includes('이력');
      continue;
    }
    if (!inLecture) continue;
    if (['paragraph', 'bulleted_list_item', 'numbered_list_item', 'to_do'].includes(b.type)) {
      const t = getBlockText(b).replace(/\s+/g, ' ').trim();
      if (t) lines.push(t);
    }
  }
  return lines;
}

// "2026 곡정고 AI 서·논술형 평가 연수" → { year, place, desc }
function parseLecture(line) {
  const m = line.match(/^(\d{4})\s*년?\s+(\S+)\s+(.+)$/);
  if (!m) return null;
  return { year: m[1], place: m[2], desc: m[3] };
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
  const lines = collectLectureLines(flat);

  const lectures = [];
  for (const line of lines) {
    const lec = parseLecture(line);
    if (lec) lectures.push(lec);
    else console.warn(`⚠️ 형식이 맞지 않아 건너뜀: "${line}" (예: 2026 곡정고 AI 서·논술형 평가 연수)`);
  }

  // 안전장치: 하나도 못 읽었으면 사이트를 비우지 않고 멈춥니다.
  if (lectures.length === 0) {
    throw new Error('노션에서 강의 이력을 하나도 찾지 못했습니다. 제목에 "강의" 또는 "이력"이 있는지, 각 줄이 "연도 학교 내용" 형식인지 확인하세요. 사이트는 바꾸지 않았습니다.');
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

  let html = await fs.readFile(HTML_FILE, 'utf-8');
  const before = html;
  html = replaceBetween(html, 'FILTERS', filtersHtml);
  html = replaceBetween(html, 'LECTURES', timelineHtml);

  if (html === before) {
    console.log(`변경 사항 없음 (강의 ${lectures.length}건).`);
    return;
  }
  await fs.writeFile(HTML_FILE, html, 'utf-8');
  console.log(`강의 이력 ${lectures.length}건으로 index.html을 갱신했습니다.`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
