import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { load as loadCheerio } from 'cheerio';

// A wordpress.com blog hosting a single translation (Lan Ke Qi Yuan). There
// is no novel listing or search on the site, so the one novel is hardcoded
// and its TOC page is the only thing scraped for chapters.
// ponytail: one hardcoded novel, turn NOVEL into a list if the blog adds more.
const NOVEL: Plugin.NovelItem = {
  name: 'Lan Ke Qi Yuan',
  path: '/lkqytoc/',
  cover:
    'https://mangotranslationsrecord.wordpress.com/wp-content/uploads/2024/03/download-1.jpg',
};

class MangoTranslations implements Plugin.PluginBase {
  id = 'mangotranslations';
  name = "Mango's Record of Translations";
  icon = 'src/en/mangotranslations/icon.png';
  site = 'https://mangotranslationsrecord.wordpress.com';
  version = '1.0.0';

  async getCheerio(path: string) {
    const res = await fetchApi(this.site + path);
    if (!res.ok) {
      throw new Error('Could not reach site (' + res.status + ')');
    }
    return loadCheerio(await res.text());
  }

  async popularNovels(pageNo: number): Promise<Plugin.NovelItem[]> {
    return pageNo === 1 ? [NOVEL] : [];
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const $ = await this.getCheerio(novelPath);
    const content = $('.entry-content');

    const summary = content.children('p').first();
    summary.find('sup').remove(); // footnote markers
    summary.find('br').replaceWith('\n');

    const chapters: Plugin.ChapterItem[] = [];
    // Chapters are dated posts (/YYYY/MM/DD/slug/); matching on that keeps
    // the glossary and external links out. Restricted to list items because
    // the "Read First" button above the list links chapter 1 a second time.
    // The page carries two overlapping lists (an automatic "latest 100
    // posts" block, then a hand-kept list of everything older), so paths are
    // deduplicated.
    const seen = new Set<string>();
    content.find('li a').each((_, el) => {
      const href = $(el).attr('href') || '';
      // Own-site links only: paths are fetched as this.site + path.
      if (!href.startsWith(this.site)) return;
      const path = href.slice(this.site.length);
      const match = path.match(/^\/(\d{4})\/(\d\d)\/(\d\d)\/.+/);
      if (!match || seen.has(path)) return;
      seen.add(path);
      const name = $(el).text().replace(/\s+/g, ' ').trim();
      // A few titles drop the word "Chapter" ("LKQY 66: ...").
      const number = name.match(/^LKQY\D*(\d+(?:\.\d+)?)/i);
      chapters.push({
        name,
        path,
        releaseTime: `${match[1]}-${match[2]}-${match[3]}`,
        chapterNumber: number ? Number(number[1]) : undefined,
      });
    });

    // A layout change would otherwise show up as a silently empty novel.
    if (!chapters.length) throw new Error('No chapters found on TOC page');

    return {
      ...NOVEL,
      summary: summary.text().trim(),
      // The TOC lists newest first.
      chapters: chapters.reverse(),
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const $ = await this.getCheerio(chapterPath);
    const content = $('.entry-content').first();
    // Like/share widgets and ad markers wordpress.com appends to the post.
    content.find('#jp-post-flair, #wordads-inline-marker, script').remove();
    const html = content.html();
    if (!html) throw new Error('Chapter content not found');
    return html;
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const term = searchTerm.trim().toLowerCase();
    const haystack = (NOVEL.name + ' LKQY').toLowerCase();
    return pageNo === 1 && haystack.includes(term) ? [NOVEL] : [];
  }
}

export default new MangoTranslations();
