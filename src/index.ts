interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * SF Rec & Park Events MCP.
 *
 * Public events & programming in San Francisco parks and public spaces, from
 * the keyless sfrecpark.org events RSS feed (custom calendarEvent: namespace).
 * Free/outdoor/community civic events that complement the commercial APIs —
 * the SF counterpart to the NYC Parks pack. Parsed + normalized in-pack.
 */


const FEED = 'https://sfrecpark.org/RSSFeed.aspx?ModID=58&CID=All';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const tools: McpToolExport['tools'] = [
  {
    name: 'events',
    description:
      'Upcoming San Francisco Rec & Park events & programming (parks, plazas, rec centers). Filter by date window and keyword (title/location/description). Free/outdoor/community civic events.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Earliest event date YYYY-MM-DD (default: today).' },
        to: { type: 'string', description: 'Latest event date YYYY-MM-DD (default: no upper bound).' },
        query: { type: 'string', description: 'Keyword over title, location, and description, e.g. "yoga", "Golden Gate", "kids".' },
        limit: { type: 'number', description: 'Max events to return (1-100, default 50).' },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name !== 'events') throw new Error(`Unknown tool: ${name}`);
  const events = parseFeed(await fetchFeed());

  const from = dateArg(args.from) || todayISO();
  const to = dateArg(args.to);
  const q = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
  const limit = clamp(numArg(args.limit, 50), 1, 100);

  let out = events.filter((e) => {
    if (e.date) {
      if (e.date < from) return false;
      if (to && e.date > to) return false;
    }
    if (q && !`${e.title} ${e.location} ${e.description}`.toLowerCase().includes(q)) return false;
    return true;
  });
  out.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));

  return {
    metro: 'San Francisco',
    source: 'sfrecpark.org',
    date_from: from,
    date_to: to || null,
    total_matching: out.length,
    count: Math.min(out.length, limit),
    events: out.slice(0, limit),
  };
}

async function fetchFeed(): Promise<string> {
  const res = await fetch(FEED, { headers: { Accept: 'application/xml, text/xml', 'User-Agent': UA } });
  if (!res.ok) throw new Error(`SF Rec & Park: HTTP ${res.status}`);
  return res.text();
}

interface RecEvent {
  id: string;
  title: string;
  url: string;
  date: string;       // ISO yyyy-mm-dd (first event date)
  date_text: string;  // raw, e.g. "June 22, 2026"
  time: string;
  location: string;
  description: string;
}

function parseFeed(xml: string): RecEvent[] {
  const out: RecEvent[] = [];
  for (const it of xml.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
    const link = tag(it, 'link');
    const dateText = tag(it, 'calendarEvent:EventDates').trim();
    out.push({
      id: (link.match(/EID=(\d+)/) ?? [])[1] || tag(it, 'guid'),
      title: tag(it, 'title'),
      url: link,
      date: toIso(dateText),
      date_text: dateText,
      time: tag(it, 'calendarEvent:EventTimes').trim(),
      location: cleanLocation(tag(it, 'calendarEvent:Location')),
      description: cleanDescription(tag(it, 'description')),
    });
  }
  return out;
}

/** "June 22, 2026" (or a range "...-...") -> "2026-06-22". */
function toIso(text: string): string {
  const first = text.split(/\s*[-–]\s*/)[0].trim();
  const m = first.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return '';
  const months: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const mo = months[m[1].slice(0, 3).toLowerCase()];
  if (!mo) return '';
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

function cleanLocation(s: string): string {
  // The feed runs the venue and "San Francisco, CA" together; insert a separator.
  return decode(s).replace(/([a-z0-9])(San Francisco,)/, '$1, $2').replace(/\s+/g, ' ').trim();
}
function cleanDescription(html: string): string {
  return decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 800);
}
function tag(xml: string, name: string): string {
  const esc = name.replace(':', '\\:');
  const m = xml.match(new RegExp(`<${esc}>([\\s\\S]*?)<\\/${esc}>`));
  if (!m) return '';
  const cdata = m[1].trim().match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return decode((cdata ? cdata[1] : m[1]).trim());
}
function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#39;|&#039;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
}
function dateArg(v: unknown): string {
  if (typeof v !== 'string') return '';
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}
function todayISO(): string {
  const d = new Date(Date.now() - 7 * 3600 * 1000); // approx US Pacific
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function numArg(v: unknown, dflt: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
