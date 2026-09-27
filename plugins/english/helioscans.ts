import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { CheerioAPI, load as loadCheerio } from 'cheerio';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';

// The whole site sits behind a Cloudflare managed challenge. Opening the
// source in the app's WebView solves it once; the cf_clearance cookie is then
// shared with fetchApi. The cookie is only accepted together with the
// WebView's User-Agent, so no custom User-Agent header is sent here.
const CHALLENGE_TITLES = [
  'just a moment...',
  'attention required! | cloudflare',
  'un instant...',
];

const MONTHS: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

class HelioScansPlugin implements Plugin.PluginBase {
  id = 'helioscans';
  name = 'Helio Scans';
  icon = 'src/en/helioscans/icon.png';
  site = 'https://helioscans.com';
  version = '1.0.0';

  private async getCheerio(url: string): Promise<CheerioAPI> {
    const res = await fetchApi(url);
    const body = await res.text();
    const $ = loadCheerio(body);
    const title = $('title').text().trim().toLowerCase();
    if (
      CHALLENGE_TITLES.includes(title) ||
      (!res.ok && body.includes('cf-chl'))
    ) {
      throw new Error('Cloudflare challenge, please open in webview');
    }
    if (!res.ok) {
      throw new Error(
        'Could not reach site (' + res.status + ') try to open in webview.',
      );
    }
    return $;
  }

  // The site ships every series on /series/ in one page and filters it in
  // the browser (?q= and ?genre= are ignored by the server), so search and
  // filters are applied here to the full list.
  private async fetchSeries(
    matches?: (name: string, genres: string[], status: string) => boolean,
  ): Promise<Plugin.NovelItem[]> {
    const $ = await this.getCheerio(this.site + '/series/');
    const novels: Plugin.NovelItem[] = [];
    $('#searched_series_page > button').each((_, el) => {
      const card = $(el);
      if (card.attr('data-type') && card.attr('data-type') !== 'novel') return;
      const path = card.find('a[href^="/series/"]').first().attr('href');
      const name = (card.attr('title') || card.find('h3').text()).trim();
      if (!path || !name) return;

      let genres: string[] = [];
      try {
        genres = JSON.parse(card.attr('tags') || '[]');
      } catch {
        genres = [];
      }
      const status = card.attr('data-status') || '';
      if (
        matches &&
        !matches(
          name.toLowerCase(),
          genres.map(g => g.toLowerCase()),
          status.toLowerCase(),
        )
      ) {
        return;
      }

      const style = card.find('[style*="background-image"]').attr('style');
      novels.push({ name, path, cover: this.coverFromStyle(style) });
    });
    return novels;
  }

  // Covers are wsrv.nl thumbnails (&w=300); drop the width to get the full image.
  private coverFromStyle(style?: string): string {
    const match = style?.match(/url\(['"]?([^'")]+)['"]?\)/);
    if (!match) return defaultCover;
    return match[1].replace(/&amp;/g, '&').replace(/&w=\d+$/, '');
  }

  async popularNovels(
    pageNo: number,
    { filters }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];
    const genre = filters?.genre?.value || '';
    const status = filters?.status?.value || '';
    if (!genre && !status) return this.fetchSeries();
    return this.fetchSeries(
      (_, genres, novelStatus) =>
        (!genre || genres.includes(genre)) &&
        (!status || novelStatus === status),
    );
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];
    const term = searchTerm.trim().toLowerCase();
    return this.fetchSeries(name => name.includes(term));
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const $ = await this.getCheerio(this.site + novelPath);

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: $('h1').first().text().trim() || 'Untitled',
      cover: $('meta[property="og:image"]').attr('content') || defaultCover,
    };

    const summary = $('#expand_content p').first();
    summary.find('br').replaceWith('\n');
    novel.summary = summary.text().trim();

    novel.genres = $('h1')
      .first()
      .parent()
      .find('a[href^="/series/?genre="]')
      .map((_, el) => $(el).text().trim())
      .get()
      .join(',');

    // Author/Type/Status are label + value boxes next to each other.
    const info = (label: string) => {
      const box = $('div.font-medium')
        .filter((_, el) => $(el).text().trim() === label)
        .first()
        .next();
      return box.text().trim();
    };
    const author = info('Author');
    if (author && author !== 'N/A') novel.author = author;
    novel.status = this.parseStatus(info('Status'));

    // Chapters are listed newest first. Early access chapters carry a coin
    // badge and can only be read after buying them, so they are left out.
    const chapters: Plugin.ChapterItem[] = [];
    $('#chapters_panel a[href^="/chapter/"]').each((_, el) => {
      const link = $(el);
      if (link.find('img[alt="Coin"]').length) return;
      const name = (link.attr('title') || link.find('span').first().text())
        .trim()
        .replace(/\s+/g, ' ');
      const numberMatch = name.match(/(\d+(?:\.\d+)?)/);
      chapters.push({
        name,
        path: link.attr('href')!,
        releaseTime: this.parseDate(link.attr('d')),
        chapterNumber: numberMatch ? parseFloat(numberMatch[1]) : undefined,
      });
    });
    novel.chapters = chapters.reverse();

    return novel;
  }

  private parseStatus(status: string): string {
    switch (status.toLowerCase()) {
      case 'ongoing':
        return NovelStatus.Ongoing;
      case 'completed':
        return NovelStatus.Completed;
      case 'paused':
      case 'hiatus':
        return NovelStatus.OnHiatus;
      case 'dropped':
        return NovelStatus.Cancelled;
      default:
        return NovelStatus.Unknown;
    }
  }

  // "Sep 16, 2026" -> "2026-09-16"
  private parseDate(date?: string): string | null {
    const match = date?.match(/^([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})$/);
    if (!match) return date || null;
    const month = MONTHS[match[1].toLowerCase()];
    if (!month) return date || null;
    return `${match[3]}-${month}-${match[2].padStart(2, '0')}`;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const $ = await this.getCheerio(this.site + chapterPath);
    const content = $('#pages .novel-reader');
    if (!content.length) {
      if ($('body').text().toLowerCase().includes('early access chapter')) {
        throw new Error('This is a paid early access chapter.');
      }
      throw new Error('Chapter content not found, try to open in webview.');
    }

    // Images are lazy loaded: the real file is referenced by its uid.
    content.find('img[uid]').each((_, el) => {
      const img = $(el);
      img.attr('src', 'https://cdn.meowing.org/uploads/' + img.attr('uid'));
    });
    content.find('script, style').remove();
    return content.html() || '';
  }

  resolveUrl = (path: string) => this.site + path;

  filters = {
    genre: {
      label: 'Genre',
      value: '',
      options: [
        { label: 'All', value: '' },
        { label: 'Academy', value: 'academy' },
        { label: 'Action', value: 'action' },
        { label: 'Adventure', value: 'adventure' },
        { label: 'Apocalypse', value: 'apocalypse' },
        { label: 'Dark', value: 'dark' },
        { label: 'Demons', value: 'demons' },
        { label: 'Drama', value: 'drama' },
        { label: 'Dungeon', value: 'dungeon' },
        { label: 'Fantasy', value: 'fantasy' },
        { label: 'Game', value: 'game' },
        { label: 'Genius', value: 'genius' },
        { label: 'Genius MC', value: 'genius mc' },
        { label: 'Harem', value: 'harem' },
        { label: 'Hero', value: 'hero' },
        { label: 'Hunter', value: 'hunter' },
        { label: 'Magic', value: 'magic' },
        { label: 'Monsters', value: 'monsters' },
        { label: 'Necromancer', value: 'necromancer' },
        { label: 'Necromancy', value: 'necromancy' },
        { label: 'Noble', value: 'noble' },
        { label: 'Overpowered', value: 'overpowered' },
        { label: 'Rebirth', value: 'rebirth' },
        { label: 'Regression', value: 'regression' },
        { label: 'Reincarnation', value: 'reincarnation' },
        { label: 'Revenge', value: 'revenge' },
        { label: 'Swordmaster', value: 'swordmaster' },
        { label: 'System', value: 'system' },
        { label: 'Tower', value: 'tower' },
        { label: 'Transmigration', value: 'transmigration' },
        { label: 'Villain', value: 'villain' },
      ],
      type: FilterTypes.Picker,
    },
    status: {
      label: 'Status',
      value: '',
      options: [
        { label: 'All', value: '' },
        { label: 'Ongoing', value: 'ongoing' },
        { label: 'Completed', value: 'completed' },
        { label: 'Paused', value: 'paused' },
        { label: 'Dropped', value: 'dropped' },
      ],
      type: FilterTypes.Picker,
    },
  } satisfies Filters;
}

export default new HelioScansPlugin();
