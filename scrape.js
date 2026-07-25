const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const WP_BASE = "https://jobsnoticebd.com/wp-json/wp/v2";

const CATEGORY_MAP = {
  6: "government", 8: "government", 38: "government",
  7: "private", 1: "private",
  21: "bank",
  9: "ngo"
};
const RELEVANT_CATEGORY_IDS = Object.keys(CATEGORY_MAP).join(",");

const CATEGORY_TEXT_MAP = {
  "সরকারি": "government",
  "বেসরকারি": "private",
  "ব্যাংক": "bank",
  "এনজিও": "ngo",
  "প্রবাসী": "expatriate",
  "মন্ত্রণালয়": "ministry"
};

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const BN_DIGITS = "০১২৩৪৫৬৭৮৯";
function toLatinDigits(s) {
  return s.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
}

const BN_MONTHS = [
  "জানুয়ারি", "ফেব্রুয়ারি", "মার্চ", "এপ্রিল", "মে", "জুন",
  "জুলাই", "আগস্ট", "সেপ্টেম্বর", "অক্টোবর", "নভেম্বর", "ডিসেম্বর"
];

function matchBengaliDate(text) {
  if (!text) return null;
  const monthPattern = BN_MONTHS.join("|");
  const match = text.match(new RegExp(`([০-৯]{1,2})\\s*(${monthPattern})\\s*([০-৯]{4})`));
  if (!match) return null;
  const day = toLatinDigits(match[1]).padStart(2, "0");
  const monthIndex = BN_MONTHS.indexOf(match[2]);
  const year = toLatinDigits(match[3]);
  const iso = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${day}`;
  return isNaN(Date.parse(iso)) ? null : iso;
}

function extractDeadlineFromFullText(plainText) {
  const match = plainText.match(/(আবেদনের\s*শেষ\s*তারিখ|শেষ\s*তারিখ)\s*[:।]?\s*(.{0,30})/);
  return match ? matchBengaliDate(match[2]) : null;
}

function extractVacancyFromText(value) {
  if (!value) return null;
  const normalized = toLatinDigits(value);
  const match = normalized.match(/(\d+)\s*জন/) || normalized.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function extractOrgAndVacancy(title) {
  const normalizedDigits = toLatinDigits(title);
  const vacancyMatch = normalizedDigits.match(/(\d+)\s*পদে/);
  const vacancy = vacancyMatch ? parseInt(vacancyMatch[1], 10) : null;

  const orgMatch = title.match(/পদে\s+(.+?)\s*বিজ্ঞপ্তি/);
  const organization = orgMatch
    ? orgMatch[1].replace(/\s*(নিয়োগ|পরীক্ষার|ফলাফল|সময়সূচী)\s*$/, "").trim()
    : null;

  return { organization, vacancy };
}

function parseInfoTableRows(contentHtml) {
  const tableMatch = contentHtml.match(/<table>[\s\S]*?<\/table>/);
  if (!tableMatch) return [];
  const trMatches = [...tableMatch[0].matchAll(/<tr>([\s\S]*?)<\/tr>/g)];
  const rows = [];
  for (const row of trMatches) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)];
    if (cells.length < 2) continue;
    const label = stripHtml(cells[0][1]).replace(/[:：]\s*$/, "").trim();
    const rawValue = cells[1][1];
    const value = stripHtml(rawValue).trim();
    const hrefMatch = rawValue.match(/<a[^>]+href="([^"]+)"/);
    const href = hrefMatch ? hrefMatch[1] : null;
    if (label && value) rows.push({ label, value, href });
  }
  return rows;
}

function tableValue(rows, label) {
  const row = rows.find((r) => r.label === label);
  return row ? row.value : null;
}

function tableHref(rows, label) {
  const row = rows.find((r) => r.label === label);
  return row ? row.href : null;
}

async function fetchPosts(page) {
  const { data } = await axios.get(`${WP_BASE}/posts`, {
    params: {
      per_page: 50,
      page,
      categories: RELEVANT_CATEGORY_IDS,
      _embed: 1
    }
  });
  return data;
}

const KNOWN_FILLER_IMAGE_ID =
  "AVvXsEgWDRSmg1-nH1_9CFx5xtrBM8MMLitrRwtlRHv5kfYxuXYawsci0kpMgk1yJxqhVZ89TMglaUvBZYEkkK4nxBLM6tZJdCuxUQ";

function extractCircularImages(contentHtml) {
  const imgMatches = [...contentHtml.matchAll(/<img[^>]+src="([^"]+)"/g)];
  const candidates = imgMatches
    .map((m) => m[1])
    .filter((src) => src.includes("blogger.googleusercontent.com"))
    .filter((src) => !src.includes(KNOWN_FILLER_IMAGE_ID));

  const seen = new Set();
  const unique = [];
  for (const url of candidates) {
    const filename = decodeURIComponent(url.split("/").pop().split("?")[0]);
    if (seen.has(filename)) continue;
    seen.add(filename);
    unique.push(url);
  }
  return unique;
}

async function scrapeJobs() {
  const posts = await fetchPosts(1);
  const jobs = posts.map((post) => {
    const categoryId = post.categories.find((id) => CATEGORY_MAP[id]);
    const title = stripHtml(post.title.rendered);
    const plainText = stripHtml(post.content.rendered);
    const circularImages = extractCircularImages(post.content.rendered);
    const tableRows = parseInfoTableRows(post.content.rendered);
    const { organization: titleOrg, vacancy: titleVacancy } = extractOrgAndVacancy(title);
    const jobType = tableValue(tableRows, "চাকরির ধরন");
    const tableCategory = jobType ? CATEGORY_TEXT_MAP[jobType.trim()] : null;

    const applyLink =
      tableHref(tableRows, "আবেদনের ঠিকানা") ||
      tableHref(tableRows, "অফিসিয়াল ওয়েব সাইট") ||
      post.link;

    return {
      id: post.slug,
      title,
      organization: tableValue(tableRows, "প্রতিষ্ঠানের নাম") || titleOrg || title,
      logo_url: null,
      category: tableCategory || CATEGORY_MAP[categoryId] || "government",
      qualification: "any",
      published_date: post.date.slice(0, 10),
      deadline: matchBengaliDate(tableValue(tableRows, "আবেদনের শেষ তারিখ")) || extractDeadlineFromFullText(plainText),
      notice_images: circularImages,
      apply_link: applyLink,
      description: "",
      vacancy: extractVacancyFromText(tableValue(tableRows, "পদের সংখ্যা")) ?? titleVacancy,
      district: null,
      details_table: tableRows
    };
  });

  const { error } = await supabase.from("jobs").upsert(jobs, { onConflict: "id" });
  if (error) throw error;
  console.log(`${jobs.length}টা job upsert হলো`);
}

scrapeJobs();
