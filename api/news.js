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
  }
});

async function fetchOneFeed(feed) {
  try {
    const parsed = await parser.parseURL(feed.url);
    const mapped = (parsed.items || []).map((i) => ({
      id: i.guid || i.link || `${feed.source}:${i.title}`,
      title: i.title || "Untitled",
      source: feed.source,
      publishedAt: i.isoDate || i.pubDate || new Date().toISOString(),
      link: i.link || "#",
      summary: i.contentSnippet || i.content || ""
    }));
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
