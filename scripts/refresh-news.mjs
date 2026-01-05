import { writeFile } from "node:fs/promises";

const FEED_URLS = [
  "https://www.bing.com/news/search?q=PNJ%20co%20phieu&format=rss",
  "https://www.bing.com/news/search?q=PNJ%20jewelry%20Vietnam&format=rss",
];
const PNJ_IR_URL = "https://www.pnj.com.vn/quan-he-co-dong/thong-bao/";

const MAX_ITEMS = 5;
const OUTPUT_PATH = new URL("../public/news.json", import.meta.url);

const decodeHtml = (text) =>
  text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));

const stripTags = (text) => text.replace(/<[^>]*>/g, "");

const limitSummary = (text) => (text.length > 240 ? `${text.slice(0, 237)}...` : text);

const extractTag = (block, tag) => {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = block.match(regex);
  if (!match) return "";
  const raw = match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return stripTags(decodeHtml(raw)).trim();
};

const normalizeText = (text) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

const pickTag = (title, summary) => {
  const text = normalizeText(`${title} ${summary}`);
  if (text.includes("thuong hieu") || text.includes("brand")) return "Thuong hieu";
  if (text.includes("thanh tra") || text.includes("vi pham") || text.includes("phat")) return "Cong bo TT";
  if (text.includes("cua hang") || text.includes("mo rong") || text.includes("showroom")) return "Hoat dong";
  if (text.includes("doanh thu") || text.includes("loi nhuan") || text.includes("kqkd")) return "Tai chinh";
  return "Thi truong";
};

const formatDate = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
};

const extractDayMonthYear = (text) => {
  if (!text) return "";
  const matches = [...text.matchAll(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g)];
  if (!matches.length) return "";
  const [day, month, year] = matches[matches.length - 1].slice(1);
  return `${day.padStart(2, "0")}/${month.padStart(2, "0")}/${year}`;
};

const parseDayMonthYear = (value) => {
  if (!value) return 0;
  const match = value.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return 0;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  return Date.UTC(year, month - 1, day);
};

const parseDateValue = (value) => {
  if (!value) return 0;
  const date = new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? 0 : time;
};

const isPnjIr = (url) => {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\\./, "");
    if (!host.endsWith("pnj.com.vn")) return false;
    const path = parsed.pathname.toLowerCase();
    return (
      path.includes("quan-he-co-dong") ||
      path.includes("investor") ||
      path.includes("ir")
    );
  } catch {
    return false;
  }
};

const resolveUrl = async (link) => {
  if (!link) return "";
  try {
    const parsed = new URL(link);
    if (parsed.hostname.includes("bing.com") && parsed.pathname.includes("apiclick.aspx")) {
      const direct = parsed.searchParams.get("url");
      if (direct) return decodeURIComponent(direct);
    }
    const response = await fetch(link, { redirect: "follow" });
    return response.url || link;
  } catch {
    return link;
  }
};

const parseRss = async (xml) => {
  const items = [];
  const matches = xml.matchAll(/<item>([\s\S]*?)<\/item>/gi);
  for (const match of matches) {
    const block = match[1];
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate");
    const source = extractTag(block, "News:Source") || extractTag(block, "source");
    const description = extractTag(block, "description");
    const summary = description || title;
    items.push({ title, link, pubDate, source, summary });
  }
  return items;
};

const extractMeta = (html, key, attr = "property") => {
  const regex = new RegExp(`<meta[^>]*${attr}=\"${key}\"[^>]*content=\"([^\"]+)\"`, "i");
  const match = html.match(regex);
  if (match?.[1]) return stripTags(decodeHtml(match[1])).trim();
  return "";
};

const extractTitle = (html) => {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (match?.[1]) return stripTags(decodeHtml(match[1])).trim();
  return "";
};

const fetchArticleMeta = async (url) => {
  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) return {};
    const buffer = await response.arrayBuffer();
    let html = new TextDecoder("utf-8").decode(buffer);
    const metaCharset = html.match(/<meta[^>]*charset=["']?([^"'\\s>]+)/i);
    const declared = metaCharset?.[1]?.trim().toLowerCase();
    if (declared && declared !== "utf-8") {
      html = new TextDecoder(declared).decode(buffer);
    }
    const title =
      extractMeta(html, "og:title") ||
      extractMeta(html, "twitter:title", "name") ||
      extractTitle(html);
    const description =
      extractMeta(html, "og:description") ||
      extractMeta(html, "description", "name") ||
      extractMeta(html, "twitter:description", "name");
    return { title, description };
  } catch {
    return {};
  }
};

const parseIrItems = (html) => {
  const items = [];
  const blocks = html.matchAll(/<div class="answer"[^>]*>([\s\S]*?)<\/div>/gi);
  const lineRegex =
    /\+\s*([\s\S]*?)\s*:\s*<a[^>]+href="(https:\/\/cdn\.pnj\.io[^"]+)"[^>]*>T\u1ea3i v\u1ec1<\/a>/gi;
  for (const block of blocks) {
    const blockHtml = block[1];
    for (const match of blockHtml.matchAll(lineRegex)) {
      const rawTitle = stripTags(decodeHtml(match[1])).replace(/\s+/g, " ").trim();
      if (!rawTitle) continue;
      const url = match[2];
      const date = extractDayMonthYear(rawTitle);
      const summary = limitSummary(rawTitle);
      items.push({
        title: rawTitle,
        summary,
        url,
        date,
        source: "pnj.com.vn (IR)",
        tag: pickTag(rawTitle, summary),
        ts: parseDayMonthYear(date),
        pnjIr: true,
      });
    }
  }
  return items;
};

const loadIrItems = async () => {
  try {
    const response = await fetch(PNJ_IR_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch PNJ IR: ${PNJ_IR_URL}`);
    }
    const html = await response.text();
    return parseIrItems(html);
  } catch (error) {
    console.error(error);
    return [];
  }
};

const loadFeedItems = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch RSS: ${url}`);
  }
  const xml = await response.text();
  return parseRss(xml);
};

const main = async () => {
  const allItems = [];
  for (const url of FEED_URLS) {
    try {
      const items = await loadFeedItems(url);
      allItems.push(...items);
    } catch (error) {
      console.error(error);
    }
  }

  const seenTitle = new Set();
  const seenUrl = new Set();
  const candidates = [];

  const irItems = await loadIrItems();
  for (const item of irItems) {
    const titleKey = item.title.trim();
    if (!titleKey || seenTitle.has(titleKey)) continue;
    if (item.url && seenUrl.has(item.url)) continue;
    seenTitle.add(titleKey);
    if (item.url) seenUrl.add(item.url);
    candidates.push(item);
  }

  for (const item of allItems) {
    if (!item.title) continue;
    const titleKey = item.title.trim();
    if (!titleKey || seenTitle.has(titleKey)) continue;
    seenTitle.add(titleKey);

    const url = await resolveUrl(item.link);
    if (url && seenUrl.has(url)) continue;
    if (url) seenUrl.add(url);

    const meta = await fetchArticleMeta(url);
    const title = meta.title || item.title;
    const rawSummary = meta.description || item.summary;
    const summary = limitSummary(rawSummary);
    let sourceHost = "";
    if (url) {
      try {
        sourceHost = new URL(url).hostname.replace(/^www\\./, "");
      } catch {
        sourceHost = "";
      }
    }
    candidates.push({
      title,
      summary,
      url,
      date: formatDate(item.pubDate),
      source: sourceHost || item.source || "Bing News",
      tag: pickTag(title, summary),
      ts: parseDateValue(item.pubDate),
      pnjIr: isPnjIr(url),
    });
  }

  const pnjItems = candidates
    .filter((item) => item.pnjIr)
    .sort((a, b) => b.ts - a.ts);
  const otherItems = candidates
    .filter((item) => !item.pnjIr)
    .sort((a, b) => b.ts - a.ts);

  const results = [];
  const seenSelected = new Set();
  const pushItem = (item) => {
    if (!item) return;
    const key = item.url || item.title;
    if (seenSelected.has(key)) return;
    seenSelected.add(key);
    results.push(item);
  };

  for (const item of pnjItems) {
    if (results.length >= 2) break;
    pushItem(item);
  }

  for (const item of otherItems) {
    if (results.length >= MAX_ITEMS) break;
    pushItem(item);
  }

  const finalResults = results.map((item, index) => ({
    id: `news_${index + 1}`,
    title: item.title,
    summary: item.summary,
    url: item.url,
    date: item.date,
    source: item.source,
    tag: item.tag,
  }));

  const now = new Date();
  const updatedAt = `${formatDate(now.toISOString())} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const payload = { updatedAt, items: finalResults };
  await writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`Saved ${results.length} items to ${OUTPUT_PATH.pathname}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
