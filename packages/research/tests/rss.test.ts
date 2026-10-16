import { describe, expect, it } from 'vitest';
import { parseFeed } from '../src/providers/rss.js';

const RSS_SAMPLE = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<title>Example Feed</title>
<link>https://example.com</link>
<item>
  <title><![CDATA[First post & more]]></title>
  <link>https://example.com/a?utm_source=feed</link>
  <pubDate>Wed, 15 Oct 2026 10:00:00 GMT</pubDate>
  <author>jane@example.com</author>
  <description>Body of the first post.</description>
</item>
<item>
  <title>Second post</title>
  <guid>https://example.com/b</guid>
  <pubDate>not-a-date</pubDate>
</item>
</channel></rss>`;

const ATOM_SAMPLE = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Atom Feed</title>
<link href="https://example.com/"/>
<entry>
  <title>Entry one</title>
  <link href="https://example.com/e1" rel="alternate"/>
  <link href="https://example.com/e1/comments" rel="replies"/>
  <published>2026-10-14T08:00:00Z</published>
  <author><name>Bob</name></author>
  <summary>Summary text.</summary>
</entry>
</feed>`;

describe('parseFeed', () => {
  it('parses RSS 2.0 items without inventing data', () => {
    const feed = parseFeed(RSS_SAMPLE);
    expect(feed.feedTitle).toBe('Example Feed');
    expect(feed.entries).toHaveLength(2);
    expect(feed.entries[0].title).toBe('First post & more');
    expect(feed.entries[0].publishedAt).toBe('2026-10-15T10:00:00.000Z');
    // Unparseable date → undefined, never invented.
    expect(feed.entries[1].publishedAt).toBeUndefined();
    // guid used as link fallback only when it is an http URL.
    expect(feed.entries[1].link).toBe('https://example.com/b');
  });

  it('parses Atom entries and prefers rel=alternate links', () => {
    const feed = parseFeed(ATOM_SAMPLE);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0].link).toBe('https://example.com/e1');
    expect(feed.entries[0].publishedAt).toBe('2026-10-14T08:00:00.000Z');
  });

  it('tolerates empty documents', () => {
    expect(parseFeed('<rss version="2.0"><channel></channel></rss>').entries).toEqual([]);
  });
});
