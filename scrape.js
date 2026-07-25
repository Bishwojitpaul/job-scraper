const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // শুধু script-এ, কখনো app-এ না
);

const WP_BASE = "https://jobsnoticebd.com/wp-json/wp/v2";

// jobsnoticebd.com category id -> আমাদের app category slug
const CATEGORY_MAP = {
  6: "government",  // সরকারি চাকরি
  8: "government",  // ডিফেন্স চাকরি
  38: "government", // বিশ্ববিদ্যালয় চাকরি
  7: "private",      // বেসরকারি চাকরি
  1: "private",       // ঔষধ কোম্পানি চাকরি
  21: "bank",         // ব্যাংক চাকরি
  9: "ngo"            // এনজিও চাকরি
};
const RELEVANT_CATEGORY_IDS = Object.keys(CATEGORY_MAP).join(",");

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8230;/g, "…")
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

function extractDeadline(plainText) {
  const monthPattern = BN_MONTHS.join("|");
  const match = plainText.match(
    new RegExp(`(আবেদনের\\s*শেষ\\s*তারিখ|শেষ\\s*তারিখ)\\s*[:।]?\\s*([০-৯]{1,2})\\s*(${monthPattern})\\s*([০-৯]{4})`)
  );
  if (!match) return null;
  const day = toLatinDigits(match[2]).padStart(2, "0");
  const monthIndex = BN_MONTHS.indexOf(match[3]);
  const year = toLatinDigits(match[4]);
  const iso = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${day}`;
  return isNaN(Date.parse(iso)) ? null : iso;
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

async function scrapeJobs() {
  const posts = await fetchPosts(1); // প্রতিবার সাম্প্রতিক ৫০টা চেক করে, upsert করলে ডুপ্লিকেট হয় না
  const jobs = posts.map((post) => {
    const categoryId = post.categories.find((id) => CATEGORY_MAP[id]);
    const title = stripHtml(post.title.rendered);
    const plainText = stripHtml(post.content.rendered);
    const image = post._embedded?.["wp:featuredmedia"]?.[0]?.source_url ?? null;
    const { organization, vacancy } = extractOrgAndVacancy(title);

    return {
      id: post.slug,
      title,
      organization: organization || title,
      logo_url: null,
      category: CATEGORY_MAP[categoryId] ?? "government",
      qualification: "any",
      published_date: post.date.slice(0, 10),
      deadline: extractDeadline(plainText),
      notice_image_url: image,
      apply_link: post.link,
      description: plainText.slice(0, 4000),
      vacancy,
      district: null
    };
  });

  const { error } = await supabase.from("jobs").upsert(jobs, { onConflict: "id" });
  if (error) throw error;
  console.log(`${jobs.length}টা job upsert হলো`);
}

scrapeJobs();
