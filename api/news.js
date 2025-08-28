import Parser from "rss-parser";

const FEEDS = [
  { url: "https://www.autosport.com/rss/f1/news", source: "Autosport" },
  { url: "https://www.motorsport.com/rss/f1/all/news", source: "Motorsport" },
  { url: "https://www.racefans.net/category/f1/feed/", source: "RaceFans" },
  // добавим более стабильные источники:
  { url: "https://www.planetf1.com/feed", source: "PlanetF1" },
  { url: "https://www.bbc.com/sport/formula1/rss.xml", source: "BBC Sport" }
];

const parser = new Parser({
  // ВАЖНО: заголовки задаём здесь
  requestOptions: {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
      "accept":
        "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7"
    },
    timeout: 10000 // 10s
  },
  // Enable custom fields to expose media and content fields more reliably
  // This ensures consistent access to media:content, media:thumbnail, and content:encoded
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
      ['content:encoded', 'contentEncoded']
    ]
  }
});

/**
 * Extract image URL from RSS item using multiple fallback strategies
 * @param {Object} item - RSS item object
 * @returns {string|undefined} - Image URL if found, undefined otherwise
 */
function extractImage(item) {
  // Strategy 1: enclosure.url (handle both object and array forms)
  // rss-parser sometimes returns enclosure as an array, so we handle both cases
  if (item?.enclosure) {
    if (Array.isArray(item.enclosure)) {
      const url = item.enclosure[0]?.url;
      if (url) return url;
    } else {
      const url = item.enclosure.url;
      if (url) return url;
    }
  }

  // Strategy 2: Use custom field mediaContent (exposed via customFields)
  // This provides consistent access to media:content with array support
  if (item?.mediaContent && Array.isArray(item.mediaContent) && item.mediaContent.length > 0) {
    const url = item.mediaContent[0]?.$?.url;
    if (url) return url;
  }

  // Strategy 3: Use custom field mediaThumbnail (exposed via customFields)
  // This provides consistent access to media:thumbnail with array support
  if (item?.mediaThumbnail && Array.isArray(item.mediaThumbnail) && item.mediaThumbnail.length > 0) {
    const url = item.mediaThumbnail[0]?.$?.url;
    if (url) return url;
  }

  // Strategy 4: Parse contentEncoded HTML to find first <img src="...">
  // This is a fallback when standard RSS image fields are missing
  if (item?.contentEncoded) {
    const imgMatch = item.contentEncoded.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
    if (imgMatch && imgMatch[1]) {
      return imgMatch[1];
    }
  }

  return undefined;
}

/**
 * Normalize image URL to ensure proper protocol
 * @param {string|undefined} u - URL to normalize
 * @returns {string|undefined} - Normalized URL or undefined if falsy
 */
function normalizeUrl(u) {
  if (!u) return undefined;
  if (u.startsWith('//')) return 'https:' + u;
  return u;
}

async function fetchOneFeed(feed) {
  try {
    const parsed = await parser.parseURL(feed.url);
    const mapped = (parsed.items || []).map((i) => {
      // Extract and normalize image URL using helper functions
      const image = normalizeUrl(extractImage(i));

      return {
        id: i.guid || i.link || `${feed.source}:${i.title}`,
        title: i.title || "Untitled",
        source: feed.source,
        publishedAt: i.isoDate || i.pubDate || new Date().toISOString(),
        link: i.link || "#",
        summary: i.contentSnippet || i.content || "",
        ...(image && { image }) // Only include image field when it exists
      };
    });
    return mapped;
  } catch {
    return []; // не падаем из-за одного источника
  }
}

export default async function handler(req, res) {
  try {
    const { mode = "balanced", q = "" } = req.query;
    const qLower = String(q || "").toLowerCase();

    const results = await Promise.allSettled(FEEDS.map(fetchOneFeed));
    let items = [];
    for (const r of results) if (r.status === "fulfilled") items.push(...r.value);

    if (qLower) {
      items = items.filter((x) =>
        (x.title + " " + x.summary).toLowerCase().includes(qLower)
      );
    }

    if (!items.length) {
      res.setHeader("Cache-Control", "s-maxage=60");
      return res.status(200).json([]); // лучше пустой массив, чем 500
    }

    const now = Date.now();
    const ranked = items.map((x) => {
      const ageH = Math.max(0.1, (now - new Date(x.publishedAt).getTime()) / 36e5);
      const sourceWeight =
        x.source === "Autosport" ? 1.2 : x.source === "Motorsport" ? 1.1 : 1.0;
      const score = mode === "recent" ? -ageH : Math.exp(-ageH / 18) * sourceWeight;
      return { ...x, _score: score };
    });

    ranked.sort((a, b) => b._score - a._score);
    const top = ranked.slice(0, 60).map(({ _score, ...rest }) => rest);

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
    res.status(200).json(top);
  } catch {
    res.status(500).json({ error: "Failed to fetch news" });
  }
}
