import Parser from "rss-parser";

const FEEDS = [
  { url: "https://www.autosport.com/rss/f1/news", source: "Autosport" },
  { url: "https://www.motorsport.com/rss/f1/all/news", source: "Motorsport" },
  { url: "https://www.racefans.net/category/f1/feed/", source: "RaceFans" }
];

// Заголовки, чтобы нас не резали как «бота»
const UA_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  "accept":
    "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7"
};

const parser = new Parser();

async function fetchOneFeed(feed) {
  try {
    // parseURL умеет принимать per-request options (в т.ч. headers)
    const parsed = await parser.parseURL(feed.url, { headers: UA_HEADERS });
    const mapped = (parsed.items || []).map((i) => ({
      id: i.guid || i.link || `${feed.source}:${i.title}`,
      title: i.title || "Untitled",
      source: feed.source,
      publishedAt: i.isoDate || i.pubDate || new Date().toISOString(),
      link: i.link || "#",
      summary: i.contentSnippet || i.content || ""
    }));
    return mapped;
  } catch (e) {
    // В проде логируем, тут просто пропускаем упавший источник
    return [];
  }
}

export default async function handler(req, res) {
  try {
    const { mode = "balanced", q = "" } = req.query;
    const qLower = String(q || "").toLowerCase();

    // Тянем все фиды параллельно и не падаем из-за одного
    const results = await Promise.allSettled(FEEDS.map(fetchOneFeed));
    let items = [];
    for (const r of results) {
      if (r.status === "fulfilled") items.push(...r.value);
    }

    // Если вообще пусто — вернуть 200 с пустым массивом (а не 500)
    if (!items.length) {
      res.setHeader("Cache-Control", "s-maxage=60");
      return res.status(200).json([]);
    }

    // Поиск
    if (qLower) {
      items = items.filter((x) =>
        (x.title + " " + x.summary).toLowerCase().includes(qLower)
      );
    }

    // Ранжирование
    const now = Date.now();
    const ranked = items.map((x) => {
      const ageH = Math.max(
        0.1,
        (now - new Date(x.publishedAt).getTime()) / 36e5
      );
      const sourceWeight =
        x.source === "Autosport" ? 1.2 : x.source === "Motorsport" ? 1.1 : 1.0;
      const score = mode === "recent" ? -ageH : Math.exp(-ageH / 18) * sourceWeight;
      return { ...x, _score: score };
    });

    ranked.sort((a, b) => b._score - a._score);
    const top = ranked.slice(0, 50).map(({ _score, ...rest }) => rest);

    // Кэш CDN
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
    res.status(200).json(top);
  } catch (_) {
    res.status(500).json({ error: "Failed to fetch news" });
  }
}
