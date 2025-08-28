import Parser from "rss-parser";

const FEEDS = [
  { url: "https://www.autosport.com/rss/f1/news", source: "Autosport" },
  { url: "https://www.motorsport.com/rss/f1/all/news", source: "Motorsport" },
  { url: "https://www.racefans.net/category/f1/feed/", source: "RaceFans" }
];

const parser = new Parser();

export default async function handler(req, res) {
  try {
    const { mode = "balanced", q = "" } = req.query;
    const qLower = String(q).toLowerCase();

    let items = [];
    for (const f of FEEDS) {
      const feed = await parser.parseURL(f.url);
      const mapped = (feed.items || []).map((i) => ({
        id: i.guid || i.link || `${f.source}:${i.title}`,
        title: i.title || "Untitled",
        source: f.source,
        publishedAt: i.isoDate || i.pubDate || new Date().toISOString(),
        link: i.link || "#",
        summary: i.contentSnippet || i.content || ""
      }));
      items.push(...mapped);
    }

    // Поиск
    let filtered = items;
    if (qLower) {
      filtered = items.filter(x =>
        (x.title + " " + x.summary).toLowerCase().includes(qLower)
      );
    }

    // Ранжирование
    const now = Date.now();
    filtered.forEach(x => {
      const ageH = Math.max(0.1, (now - new Date(x.publishedAt).getTime()) / 36e5);
      const sourceWeight = x.source === "Autosport" ? 1.2 : x.source === "Motorsport" ? 1.1 : 1.0;
      x._score = mode === "recent" ? -ageH : Math.exp(-ageH / 18) * sourceWeight;
    });

    filtered.sort((a, b) => b._score - a._score);
    const top = filtered.slice(0, 50).map(({ _score, ...rest }) => rest);

    // Кэш CDN
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
    res.status(200).json(top);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch news" });
  }
}
